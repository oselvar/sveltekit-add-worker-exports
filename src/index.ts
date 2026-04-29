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
import { access, readFile, rename, writeFile, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parse as parseJsonc } from 'jsonc-parser';
import type { Plugin } from 'vite';

const DEFAULT_DEV_PORT = 8787;

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
			const { unstable_readConfig, unstable_startWorker } = await import('wrangler');

			// Read the project's wrangler config (auto-discovers wrangler.jsonc/toml)
			const wranglerConfig = unstable_readConfig(
				options.wranglerConfig ? { config: options.wranglerConfig } : {}
			);

			// Copy the raw config and override main, name, and dev port
			const rawJson = await readFile(wranglerConfig.configPath!, 'utf-8');
			const devConfig = parseJsonc(rawJson);
			devConfig.name = `${devConfig.name ?? 'sveltekit'}-dev-worker`;
			devConfig.main = options.entryPoint;
			devConfig.dev = { ...devConfig.dev, port: devPort };
			delete devConfig.assets;

			tempConfigPath = resolve('.dev-worker-wrangler.jsonc');
			await writeFile(tempConfigPath, JSON.stringify(devConfig, null, '\t'));

			worker = await unstable_startWorker({ config: tempConfigPath });

			server.httpServer?.on('close', async () => {
				if (worker) {
					await worker.dispose();
					worker = null;
				}
				if (tempConfigPath) {
					await unlink(tempConfigPath).catch(() => {});
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