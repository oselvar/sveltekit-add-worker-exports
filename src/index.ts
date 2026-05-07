/**
 * Vite plugin that makes Durable Objects and Workflows work with SvelteKit
 * on Cloudflare, in both dev and production.
 *
 * **Build mode:** SvelteKit's adapter-cloudflare generates _worker.js with
 * only a default export. Cloudflare requires DO/Workflow classes as named
 * exports. This plugin post-processes the build output to merge them.
 *
 * **Dev mode:** `getPlatformProxy` (used by adapter-cloudflare in dev) can't
 * run internal Durable Objects. This plugin starts a separate wrangler dev
 * server via `unstable_startWorker` that runs the real DO worker. Clients
 * connect directly to it via WebSocket on a separate port.
 *
 * Usage in vite.config.ts:
 *   addWorkerExports({ entryPoint: 'src/lib/server/index.ts' })
 *
 * @see https://github.com/sveltejs/kit/issues/1712
 */

import { build } from 'esbuild';
import { existsSync } from 'node:fs';
import { access, mkdir, readFile, rename, writeFile, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { parse as parseJsonc } from 'jsonc-parser';
import type { NodeJSCompatMode } from 'miniflare';
import type { Plugin } from 'vite';

const DEFAULT_DEV_PORT = 8787;
const BRIDGE_BINDING = '__SWE_BRIDGE';
const CACHE_DIR_REL = 'node_modules/.cache/sveltekit-add-worker-exports';
const WRAPPER_FILENAME = 'dev-worker-entry.ts';

/**
 * Mirrors wrangler's internal getRegistryPath() — wrangler doesn't export it.
 * Workers register themselves under this path so cross-worker `script_name`
 * bindings can find each other.
 */
function getWranglerRegistryPath(): string {
	if (process.env.WRANGLER_REGISTRY_PATH) return process.env.WRANGLER_REGISTRY_PATH;
	const legacy = join(homedir(), '.wrangler');
	if (existsSync(legacy)) return join(legacy, 'registry');
	if (process.platform === 'darwin') {
		return join(homedir(), 'Library', 'Preferences', '.wrangler', 'registry');
	}
	if (process.platform === 'win32') {
		return join(
			process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'),
			'.wrangler',
			'registry'
		);
	}
	return join(
		process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'),
		'.wrangler',
		'registry'
	);
}

export interface AddWorkerExportsOptions {
	/** File that exports Durable Object and/or Workflow classes */
	entryPoint: string;
	/** Directory containing the SvelteKit-generated _worker.js (default: .svelte-kit/cloudflare) */
	outputDir?: string;
	/** Override wrangler config path (default: auto-discovered by wrangler) */
	wranglerConfig?: string;
	/** Port for the dev worker server (default: 8787) */
	devPort?: number;
}

/**
 * Returns two Vite plugins: one for build (patches _worker.js) and one for
 * dev (starts a wrangler dev server for Durable Objects).
 *
 * The dev plugin injects `__DEV_WORKER_PORT__` as a compile-time constant
 * via Vite's `define`. Declare it in your app's type definitions:
 *
 * ```typescript
 * // src/app.d.ts
 * declare global {
 *   const __DEV_WORKER_PORT__: number;
 * }
 * ```
 */
export function addWorkerExports(options: AddWorkerExportsOptions): Plugin[] {
	return [buildPlugin(options), devPlugin(options)];
}

function buildPlugin(options: AddWorkerExportsOptions): Plugin {
	return {
		name: 'add-worker-exports',
		apply: 'build',
		enforce: 'post',

		async closeBundle() {
			const outputDir = resolve(options.outputDir ?? '.svelte-kit/cloudflare');
			const workerPath = resolve(outputDir, '_worker.js');
			const sveltekitPath = resolve(outputDir, '_sveltekit_worker.js');
			const exportsPath = resolve(outputDir, '_extra_exports.js');

			// Skip if already patched (idempotent)
			if (await exists(sveltekitPath)) {
				return;
			}

			// Skip if the adapter hasn't run yet (e.g. during SSR build phase)
			if (!(await exists(workerPath))) {
				return;
			}

			// Bundle the named exports
			await build({
				entryPoints: [options.entryPoint],
				bundle: true,
				format: 'esm',
				sourcemap: true,
				target: 'esnext',
				external: ['cloudflare:*'],
				outfile: exportsPath
			});

			// Rename original worker and create merged entry point
			await rename(workerPath, sveltekitPath);
			await writeFile(
				workerPath,
				`export { default } from './_sveltekit_worker.js';\nexport * from './_extra_exports.js';\n`
			);
		}
	};
}

function devPlugin(options: AddWorkerExportsOptions): Plugin {
	const devPort = options.devPort ?? DEFAULT_DEV_PORT;
	let worker: { dispose: () => Promise<void> } | null = null;
	let tempConfigPath: string | null = null;
	let proxyConfigPath: string | null = null;
	let typesConfigPath: string | null = null;
	let wrapperPath: string | null = null;

	let cached: { rawJson: string; workflowBindings: string[] } | null = null;
	async function readConfig() {
		if (cached) return cached;
		const { unstable_readConfig } = await import('wrangler');
		const parsed = unstable_readConfig(
			options.wranglerConfig ? { config: options.wranglerConfig } : {}
		);
		const rawJson = await readFile(parsed.configPath!, 'utf-8');
		const workflowBindings = (parsed.workflows ?? []).map((w: { binding: string }) => w.binding);
		cached = { rawJson, workflowBindings };
		return cached;
	}

	return {
		name: 'add-worker-exports-dev',
		apply: 'serve',

		config() {
			return {
				define: {
					__DEV_WORKER_PORT__: JSON.stringify(devPort)
				}
			};
		},

		async configureServer(server) {
			const { unstable_startWorker } = await import('wrangler');
			const { rawJson, workflowBindings } = await readConfig();

			// The hook reads these from globalThis. We can't use vite's `define`
			// because dist/hooks.js lives in node_modules and vite doesn't
			// transform external modules in SSR by default — substitutions
			// would never apply.
			(globalThis as Record<string, unknown>).__SWE_BRIDGE_NAME__ = BRIDGE_BINDING;
			(globalThis as Record<string, unknown>).__SWE_WORKFLOWS__ = workflowBindings;

			// Generate a sidecar wrapper entry that re-exports the user's classes
			// and adds /__swe/wf/* HTTP routes used by the SvelteKit-side hook to
			// proxy workflow API calls into the sidecar (which has the real
			// workflow bindings).
			const cacheDir = resolve(CACHE_DIR_REL);
			await mkdir(cacheDir, { recursive: true });
			wrapperPath = join(cacheDir, WRAPPER_FILENAME);
			const userEntryAbs = resolve(options.entryPoint);
			const userEntryRel = relative(dirname(wrapperPath), userEntryAbs)
				.replace(/\\/g, '/')
				.replace(/\.(ts|tsx|js|jsx|mjs|mts)$/, '');
			await writeFile(wrapperPath, generateWrapperSource(userEntryRel, workflowBindings));

			// Copy the raw config and override main, name, and dev port
			const devConfig = parseJsonc(rawJson);
			devConfig.name = `${devConfig.name ?? 'sveltekit'}-dev-worker`;
			devConfig.main = wrapperPath;
			devConfig.dev = { ...devConfig.dev, port: devPort };
			delete devConfig.assets;

			tempConfigPath = resolve('.dev-worker-wrangler.jsonc');
			await writeFile(tempConfigPath, JSON.stringify(devConfig, null, '\t'));

			// Write a wrangler config for adapter-cloudflare's getPlatformProxy
			// (used by vite dev for platform.env). It can't run internal DOs or
			// Workflows itself -- those are served by the sidecar above. Rewrite
			// internal DO bindings as cross-worker bindings (script_name pointing
			// at the sidecar) so platform.env.MY_DO calls in +server.ts reach the
			// sidecar via the wrangler dev registry.
			//
			// Workflows are different: wrangler's getPlatformProxy unconditionally
			// deletes workflow bindings from the env (see
			// getMiniflareOptionsFromConfig in wrangler), even when they have a
			// script_name. We strip them here and add a cross-worker service
			// binding (BRIDGE_BINDING) pointing at the sidecar; the
			// `hooks.server.ts` handle exported from this package synthesizes
			// Workflow-shaped objects on platform.env that proxy API calls
			// through that service binding into the sidecar's /__swe/wf/* routes.
			const proxyConfig = parseJsonc(rawJson);
			if (proxyConfig.durable_objects?.bindings) {
				proxyConfig.durable_objects.bindings = proxyConfig.durable_objects.bindings.map(
					(b: { script_name?: string }) =>
						b.script_name ? b : { ...b, script_name: devConfig.name }
				);
			}
			if (workflowBindings.length > 0) {
				proxyConfig.services = [
					...(proxyConfig.services ?? []),
					{ binding: BRIDGE_BINDING, service: devConfig.name }
				];
			}
			delete proxyConfig.workflows;
			delete proxyConfig.migrations;

			proxyConfigPath = resolve('.platform-proxy-wrangler.jsonc');
			await writeFile(proxyConfigPath, JSON.stringify(proxyConfig, null, '\t'));

			// A third config used only by `wrangler types`. Identical to the dev
			// config except `main` points at the user's source entry, so wrangler
			// can resolve typed bindings (DurableObjectNamespace<EchoDO>, etc.).
			// Pointing types at our generated wrapper produces untyped bindings
			// because wrangler's type resolver doesn't follow `export *` re-exports
			// out of node_modules.
			const typesConfig = parseJsonc(rawJson);
			typesConfig.name = devConfig.name;
			typesConfig.main = options.entryPoint;
			typesConfig.dev = { ...typesConfig.dev, port: devPort };
			delete typesConfig.assets;
			typesConfigPath = resolve('.types-worker-wrangler.jsonc');
			await writeFile(typesConfigPath, JSON.stringify(typesConfig, null, '\t'));

			worker = await unstable_startWorker({
				config: tempConfigPath,
				dev: { registry: getWranglerRegistryPath() },
				build: {
					nodejsCompatMode: (parsedConfig) =>
						getNodejsCompatMode(
							parsedConfig.compatibility_date,
							parsedConfig.compatibility_flags
						)
				}
			});

			server.httpServer?.on('close', async () => {
				if (worker) {
					await worker.dispose();
					worker = null;
				}
				if (tempConfigPath) {
					await unlink(tempConfigPath).catch(() => {});
				}
				if (proxyConfigPath) {
					await unlink(proxyConfigPath).catch(() => {});
				}
				if (typesConfigPath) {
					await unlink(typesConfigPath).catch(() => {});
				}
				if (wrapperPath) {
					await unlink(wrapperPath).catch(() => {});
				}
			});
		}
	};
}

function generateWrapperSource(userEntryRel: string, workflowBindings: string[]): string {
	const importPath = JSON.stringify(userEntryRel);
	const bindingList = JSON.stringify(workflowBindings);
	return `// Auto-generated by @oselvar/sveltekit-add-worker-exports.
// Bridges Workflow bindings to SvelteKit dev. Do not edit.
import * as user from ${importPath};
export * from ${importPath};

const userDefault: any = (user as any).default;
const WORKFLOW_BINDINGS = new Set<string>(${bindingList});

export default {
\tasync fetch(request: Request, env: any, ctx: any): Promise<Response> {
\t\tconst url = new URL(request.url);
\t\tif (url.pathname.startsWith('/__swe/wf/')) {
\t\t\treturn handleWf(url.pathname.slice('/__swe/wf/'.length), request, env);
\t\t}
\t\tif (userDefault?.fetch) return userDefault.fetch(request, env, ctx);
\t\treturn new Response('Not found', { status: 404 });
\t}
};

async function handleWf(rest: string, request: Request, env: any): Promise<Response> {
\tconst parts = rest.split('/').map(decodeURIComponent);
\tconst [binding, op, ...tail] = parts;
\tif (!binding || !WORKFLOW_BINDINGS.has(binding)) {
\t\treturn new Response('unknown workflow binding: ' + binding, { status: 404 });
\t}
\tconst wf = env[binding];
\tif (!wf) return new Response('binding ' + binding + ' missing on sidecar', { status: 500 });
\ttry {
\t\tif (op === 'create' && request.method === 'POST') {
\t\t\tconst opts = await request.json();
\t\t\tconst inst = await wf.create(opts);
\t\t\treturn Response.json({ id: inst.id });
\t\t}
\t\tif (op === 'createBatch' && request.method === 'POST') {
\t\t\tconst batch = await request.json();
\t\t\tconst insts = await wf.createBatch(batch);
\t\t\treturn Response.json(insts.map((i: any) => ({ id: i.id })));
\t\t}
\t\tif (op === 'get' && tail.length === 1) {
\t\t\tconst inst = await wf.get(tail[0]);
\t\t\treturn Response.json({ id: inst.id });
\t\t}
\t\tif (op === 'instance' && tail.length === 2) {
\t\t\tconst [id, method] = tail;
\t\t\tconst inst = await wf.get(id);
\t\t\tswitch (method) {
\t\t\t\tcase 'pause': await inst.pause(); return new Response(null, { status: 204 });
\t\t\t\tcase 'resume': await inst.resume(); return new Response(null, { status: 204 });
\t\t\t\tcase 'terminate': await inst.terminate(); return new Response(null, { status: 204 });
\t\t\t\tcase 'restart': await inst.restart(); return new Response(null, { status: 204 });
\t\t\t\tcase 'status': return Response.json(await inst.status());
\t\t\t\tcase 'sendEvent': {
\t\t\t\t\tconst body = await request.json();
\t\t\t\t\tawait inst.sendEvent(body);
\t\t\t\t\treturn new Response(null, { status: 204 });
\t\t\t\t}
\t\t\t}
\t\t\treturn new Response('unknown method: ' + method, { status: 404 });
\t\t}
\t\treturn new Response('unknown op: ' + op, { status: 404 });
\t} catch (err: any) {
\t\treturn new Response('error: ' + (err?.message ?? String(err)), { status: 500 });
\t}
}
`;
}

async function exists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

/**
 * Mirrors miniflare's `getNodeCompat` mode resolution. wrangler's
 * `unstable_startWorker` does not derive this from the config flags
 * automatically — without it, wrangler falls back to the legacy nodejs
 * compat plugin and warns about `node:*` imports even when
 * `nodejs_compat` is enabled.
 */
function getNodejsCompatMode(
	compatibilityDate: string | undefined,
	compatibilityFlags: readonly string[] = []
): NodeJSCompatMode {
	const hasCompat = compatibilityFlags.includes('nodejs_compat');
	const hasCompatV2 = compatibilityFlags.includes('nodejs_compat_v2');
	const hasNoCompatV2 = compatibilityFlags.includes('no_nodejs_compat_v2');
	const hasAls = compatibilityFlags.includes('nodejs_als');
	const date = compatibilityDate ?? '2000-01-01';
	if (hasCompatV2 || (hasCompat && date >= '2024-09-23' && !hasNoCompatV2)) return 'v2';
	if (hasCompat) return 'v1';
	if (hasAls) return 'als';
	return null;
}