/**
 * Vite plugin that makes Durable Objects and Workflows work with SvelteKit
 * on Cloudflare, in both dev and production.
 *
 * **Build mode:** SvelteKit's adapter-cloudflare generates _worker.js with
 * only a default export. Cloudflare requires DO/Workflow classes as named
 * exports. This plugin post-processes the build output to merge them.
 *
 * **Dev mode:** `getPlatformProxy` (used by adapter-cloudflare in dev) can't
 * run internal Durable Objects or Workflows. This plugin starts a separate
 * wrangler dev server via `unstable_startWorker` that runs the real
 * DO/Workflow worker. Internal DO and Workflow bindings in the platform-proxy
 * config get a `script_name` pointing at that sidecar; miniflare routes calls
 * across the dev registry (cloudflare/workers-sdk#7459, fixed in wrangler
 * 4.98.0). Clients connect directly to the sidecar via WebSocket on a
 * separate port.
 *
 * Usage in vite.config.ts:
 *   addWorkerExports({ entryPoint: 'src/lib/server/index.ts' })
 *
 * @see https://github.com/sveltejs/kit/issues/1712
 */

import { build } from 'esbuild';
import { existsSync } from 'node:fs';
import { access, readFile, rename, writeFile, unlink } from 'node:fs/promises';
import { builtinModules as NODE_BUILTINS } from 'node:module';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { parse as parseJsonc } from 'jsonc-parser';
import { getNodeCompat, WorkerdStructuredLog, type NodeJSCompatMode } from 'miniflare';
import { parse as parseToml } from 'smol-toml';
import type { Plugin } from 'vite';

/**
 * Parses a wrangler config file. Picks the parser by extension:
 * `.toml` uses smol-toml; everything else (`.jsonc`, `.json`, or no
 * extension) uses jsonc-parser, which handles plain JSON fine.
 *
 * Exported for tests; the dev plugin uses it via the configureServer hook.
 */
export function parseWranglerConfig(path: string, contents: string): unknown {
	return path.endsWith('.toml') ? parseToml(contents) : parseJsonc(contents);
}

const DEFAULT_DEV_PORT = 8787;

/**
 * The build outputs this plugin writes into the adapter's output dir. They are
 * server-side / Durable Object bundles and their source maps — never meant to
 * be downloadable. adapter-cloudflare's generated `.assetsignore` only excludes
 * its own outputs (`_worker.js`, `_routes.json`, `_headers`, `_redirects`), so
 * without this Cloudflare would serve these as public static assets, leaking
 * the bundled code and (via the maps' `sourcesContent`) the original
 * TypeScript. See https://github.com/oselvar/sveltekit-add-worker-exports/issues/4
 */
export const PLUGIN_ASSETS_IGNORE_ENTRIES = [
	'_sveltekit_worker.js',
	'_sveltekit_worker.js.map',
	'_extra_exports.js',
	'_extra_exports.js.map'
];

/**
 * Returns `.assetsignore` content with `entries` appended, skipping any that
 * are already present (trim-compared). Preserves existing lines and order,
 * normalises to a trailing newline. Idempotent — `.assetsignore` controls only
 * public asset serving, so the listed files stay on disk for wrangler to bundle.
 */
export function mergeAssetsIgnore(existing: string, entries: string[]): string {
	const lines = existing.split('\n');
	const present = new Set(lines.map((l) => l.trim()));
	const additions = entries.filter((e) => !present.has(e.trim()));

	// Drop trailing blank lines so we append cleanly, then re-add one newline.
	while (lines.length > 0 && lines[lines.length - 1].trim() === '') {
		lines.pop();
	}
	return [...lines, ...additions].join('\n') + '\n';
}

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
	/**
	 * Handles each structured log line emitted by the sidecar worker (one entry
	 * per `console.log` / `console.error` / etc. call). When omitted, a default
	 * handler prints each line to the host's stdout (or stderr for `error`
	 * level) prefixed with the sidecar name. Pass `() => {}` to silence.
	 */
	structuredLogsHandler?: (log: { level: string; message: string; timestamp: number }) => void;
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

			// Rename original worker and create merged entry point.
			//
			// `export *` re-exports named exports only, so class-based bindings
			// (DOs, Workflows, WorkerEntrypoint) from `_extra_exports.js` flow
			// through. Non-fetch handlers (scheduled, queue, email, tail, trace)
			// live on the user entry's `default` export — Cloudflare invokes
			// them as methods on the worker's default object, not as named
			// exports — so we spread them onto the SvelteKit default. `fetch`
			// is dropped from the user default because SvelteKit owns request
			// handling in production.
			await rename(workerPath, sveltekitPath);
			await writeFile(
				workerPath,
				`import sveltekitWorker from './_sveltekit_worker.js';\n` +
					`import * as extra from './_extra_exports.js';\n` +
					`export * from './_extra_exports.js';\n` +
					`const { fetch: _ignored, ...extraHandlers } = extra.default ?? {};\n` +
					`export default { ...sveltekitWorker, ...extraHandlers };\n`
			);

			// Keep this plugin's server bundles and source maps out of the
			// publicly-served assets. The adapter regenerates `.assetsignore`
			// every build with only its own outputs; this plugin runs
			// `enforce: 'post'`, so appending here survives each deploy.
			const assetsIgnorePath = resolve(outputDir, '.assetsignore');
			const currentIgnore = (await exists(assetsIgnorePath))
				? await readFile(assetsIgnorePath, 'utf-8')
				: '';
			await writeFile(
				assetsIgnorePath,
				mergeAssetsIgnore(currentIgnore, PLUGIN_ASSETS_IGNORE_ENTRIES)
			);
		}
	};
}

function devPlugin(options: AddWorkerExportsOptions): Plugin {
	const devPort = options.devPort ?? DEFAULT_DEV_PORT;
	let worker: { dispose: () => Promise<void> } | null = null;
	let tempConfigPath: string | null = null;
	let proxyConfigPath: string | null = null;

	async function readRawConfig(): Promise<{ path: string; contents: string }> {
		const { unstable_readConfig } = await import('wrangler');
		const parsed = unstable_readConfig(
			options.wranglerConfig ? { config: options.wranglerConfig } : {}
		);
		const path = parsed.configPath!;
		const contents = await readFile(path, 'utf-8');
		return { path, contents };
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
			const { path: configPath, contents } = await readRawConfig();
			const baseConfig = parseWranglerConfig(configPath, contents) as any;

			const sidecarName = `${baseConfig.name ?? 'sveltekit'}-dev-worker`;

			// When CLOUDFLARE_ENV is set, wrangler suffixes the registered
			// worker name with `-${env}` (see appendEnvName in wrangler), so
			// cross-worker `script_name` lookups must use the suffixed name.
			// We don't suffix `devConfig.name` itself — wrangler does that
			// based on CLOUDFLARE_ENV when starting the sidecar.
			const envName = process.env.CLOUDFLARE_ENV;
			const registeredSidecarName = envName ? `${sidecarName}-${envName}` : sidecarName;

			// Copy the raw config and override main, name, and dev port
			const devConfig = structuredClone(baseConfig);
			devConfig.name = sidecarName;
			devConfig.main = options.entryPoint;
			devConfig.dev = { ...devConfig.dev, port: devPort };
			delete devConfig.assets;

			// The user can also pass this file to `wrangler types --config
			// .dev-worker-wrangler.jsonc` to get typed bindings like
			// DurableObjectNamespace<EchoDO> resolved from the source entry.
			const devConfigJson = JSON.stringify(devConfig, null, '\t');
			tempConfigPath = resolve('.dev-worker-wrangler.jsonc');
			await writeFile(tempConfigPath, devConfigJson);

			// Write a wrangler config for adapter-cloudflare's getPlatformProxy
			// (used by vite dev for platform.env). It can't run internal DOs or
			// Workflows itself -- those are served by the sidecar above. Rewrite
			// internal DO and Workflow bindings as cross-worker bindings
			// (script_name pointing at the sidecar) so platform.env.MY_DO and
			// platform.env.MY_WORKFLOW calls in +server.ts reach the sidecar via
			// the wrangler dev registry.
			const proxyConfig = structuredClone(baseConfig);

			// Wrangler does not merge per-env `durable_objects`/`workflows`/
			// `migrations` arrays with the top-level — the selected env wholly
			// overrides them. So we patch only the scope wrangler will actually
			// use: top-level when no env, env[envName] when CLOUDFLARE_ENV is set.
			const activeScope = envName ? proxyConfig.env?.[envName] : proxyConfig;
			if (envName && !activeScope) {
				throw new Error(
					`CLOUDFLARE_ENV="${envName}" but no \`env.${envName}\` block in the wrangler config`
				);
			}
			if (activeScope.durable_objects?.bindings) {
				activeScope.durable_objects.bindings = activeScope.durable_objects.bindings.map(
					(b: { script_name?: string }) =>
						b.script_name ? b : { ...b, script_name: registeredSidecarName }
				);
			}
			if (Array.isArray(activeScope.workflows)) {
				activeScope.workflows = activeScope.workflows.map(
					(w: { script_name?: string }) =>
						w.script_name ? w : { ...w, script_name: registeredSidecarName }
				);
			}
			delete activeScope.migrations;

			proxyConfigPath = resolve('.platform-proxy-wrangler.jsonc');
			await writeFile(proxyConfigPath, JSON.stringify(proxyConfig, null, '\t'));

			const structuredLogsHandler =
				options.structuredLogsHandler ?? makeDefaultWorkerLogHandler(sidecarName);

			worker = await unstable_startWorker({
				config: tempConfigPath,
				// `testScheduled` mounts a `/__scheduled` endpoint on the sidecar
				// so cron handlers can be invoked manually in dev — wrangler dev
				// never auto-fires crons. Curl
				// `http://localhost:<devPort>/__scheduled?cron=*+*+*+*+*` to
				// trigger your `scheduled` handler.
				//
				// `structuredLogsHandler` (added in wrangler 4.99) routes each
				// worker log line through `onWorkerLog`. Without it, wrangler
				// pipes worker logs through its own Logger which can get
				// swallowed when `unstable_startWorker` is driven
				// programmatically — `console.log` inside the worker
				// disappears. Cast is needed because peer wrangler types may
				// be older.
				dev: {
					registry: getWranglerRegistryPath(),
					testScheduled: true,
					structuredLogsHandler
				} as Parameters<typeof unstable_startWorker>[0]['dev'],
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
			});
		}
	};
}

/**
 * Default handler for sidecar worker logs. Writes each line to stdout (or
 * stderr for `error` level) tagged with the sidecar name so it's obvious
 * which process produced it.
 */
function makeDefaultWorkerLogHandler(
	sidecarName: string
): (log: WorkerdStructuredLog) => void {
	const prefix = `[${sidecarName}]`;
	return ({ level, message }) => {
		const stream = level === 'error' ? process.stderr : process.stdout;
		stream.write(`${prefix} ${message}\n`);
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
 * wrangler's `unstable_startWorker` does not derive this from the config
 * flags automatically — without it, wrangler falls back to the legacy
 * nodejs compat plugin and warns about `node:*` imports even when
 * `nodejs_compat` is enabled.
 */
function getNodejsCompatMode(
	compatibilityDate: string | undefined,
	compatibilityFlags: readonly string[] = []
): NodeJSCompatMode {
	return getNodeCompat(compatibilityDate, [...compatibilityFlags]).mode;
}
