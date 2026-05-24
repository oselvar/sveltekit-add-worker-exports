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
 * Workflows in dev are best-effort: if the installed wrangler/miniflare
 * supports cross-worker workflow routing (cloudflare/workers-sdk#7459),
 * `platform.env.MY_WORKFLOW.create(...)` works directly. Otherwise the bridge
 * in `src/bridge/` synthesises the binding via an HTTP fallback. Once the
 * upstream patch lands, delete `src/bridge/`, drop the `setupBridge` import
 * and call below, replace `wrapperPath` with `options.entryPoint`, remove
 * the `serviceBinding` insertion, and replace `src/hooks.ts` with a no-op
 * handle.
 *
 * Usage in vite.config.ts:
 *   addWorkerExports({ entryPoint: 'src/lib/server/index.ts' })
 *
 * @see https://github.com/sveltejs/kit/issues/1712
 */

import { build } from 'esbuild';
import { existsSync } from 'node:fs';
import { access, readFile, rename, writeFile, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { parse as parseJsonc } from 'jsonc-parser';
import type { NodeJSCompatMode } from 'miniflare';
import type { Plugin } from 'vite';
import { setupBridge } from './bridge/setup.js';

const DEFAULT_DEV_PORT = 8787;

const NODE_BUILTINS = [
	'assert', 'async_hooks', 'buffer', 'child_process', 'cluster', 'console',
	'constants', 'crypto', 'dgram', 'diagnostics_channel', 'dns', 'domain',
	'events', 'fs', 'fs/promises', 'http', 'http2', 'https', 'inspector',
	'module', 'net', 'os', 'path', 'path/posix', 'path/win32', 'perf_hooks',
	'process', 'punycode', 'querystring', 'readline', 'repl', 'stream',
	'stream/consumers', 'stream/promises', 'stream/web', 'string_decoder',
	'sys', 'timers', 'timers/promises', 'tls', 'trace_events', 'tty', 'url',
	'util', 'util/types', 'v8', 'vm', 'wasi', 'worker_threads', 'zlib'
];

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

			// Bundle the named exports.
			//
			// `conditions: ['workerd', 'worker', 'browser']` is the Cloudflare-
			// recommended set for bundlers targeting Workers — it picks the
			// workerd-specific or browser-shimmed variants of packages over
			// their Node variants (e.g. nanoid's webcrypto-via-`globalThis.crypto`
			// browser build instead of the `node:crypto`-importing main build).
			//
			// Node built-ins are externalised so transitive deps that do
			// `require('path')` or `import 'node:async_hooks'` survive bundling;
			// the Workers runtime resolves them when `nodejs_compat` is enabled
			// in wrangler.jsonc.
			await build({
				entryPoints: [options.entryPoint],
				bundle: true,
				format: 'esm',
				sourcemap: true,
				target: 'esnext',
				conditions: ['workerd', 'worker', 'browser'],
				external: [
					'cloudflare:*',
					...NODE_BUILTINS,
					...NODE_BUILTINS.map((m) => `node:${m}`)
				],
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
	let bridgeDispose: (() => Promise<void>) | null = null;

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

			const sidecarName = `${parseJsonc(rawJson).name ?? 'sveltekit'}-dev-worker`;

			// Set up the workflow HTTP bridge (see src/bridge/). This is the
			// fallback used when the installed wrangler/miniflare strips
			// workflow bindings from getPlatformProxy. When the upstream
			// patch lands (cloudflare/workers-sdk#7459), delete src/bridge,
			// remove this call, and use options.entryPoint as the dev
			// config's `main` directly (no service binding either).
			const bridge = await setupBridge({
				userEntryAbs: resolve(options.entryPoint),
				workflowBindings,
				sidecarName
			});
			bridgeDispose = bridge.dispose;

			// Copy the raw config and override main, name, and dev port
			const devConfig = parseJsonc(rawJson);
			devConfig.name = sidecarName;
			devConfig.main = bridge.wrapperPath;
			devConfig.dev = { ...devConfig.dev, port: devPort };
			delete devConfig.assets;

			tempConfigPath = resolve('.dev-worker-wrangler.jsonc');
			await writeFile(tempConfigPath, JSON.stringify(devConfig, null, '\t'));

			// Write a wrangler config for adapter-cloudflare's getPlatformProxy
			// (used by vite dev for platform.env). It can't run internal DOs or
			// Workflows itself -- those are served by the sidecar above. Rewrite
			// internal DO bindings as cross-worker bindings (script_name pointing
			// at the sidecar) so platform.env.MY_DO calls in +server.ts reach the
			// sidecar via the wrangler dev registry. Workflows get the same
			// rewrite; on patched wrangler/miniflare miniflare routes them via
			// the dev-registry-proxy. On unpatched, wrangler strips them and the
			// bridge service binding (added below) drives the SvelteKit hook
			// fallback.
			const proxyConfig = parseJsonc(rawJson);
			if (proxyConfig.durable_objects?.bindings) {
				proxyConfig.durable_objects.bindings = proxyConfig.durable_objects.bindings.map(
					(b: { script_name?: string }) =>
						b.script_name ? b : { ...b, script_name: sidecarName }
				);
			}
			if (Array.isArray(proxyConfig.workflows)) {
				proxyConfig.workflows = proxyConfig.workflows.map(
					(w: { script_name?: string }) =>
						w.script_name ? w : { ...w, script_name: sidecarName }
				);
			}
			if (workflowBindings.length > 0) {
				proxyConfig.services = [
					...(proxyConfig.services ?? []),
					bridge.serviceBinding
				];
			}
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
			typesConfig.name = sidecarName;
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
				if (bridgeDispose) {
					await bridgeDispose();
					bridgeDispose = null;
				}
			});
		}
	};
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
