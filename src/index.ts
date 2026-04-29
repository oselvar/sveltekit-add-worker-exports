/**
 * Vite plugin that adds named exports (Durable Objects, Workflows) to a
 * SvelteKit Cloudflare worker.
 *
 * SvelteKit's adapter-cloudflare generates _worker.js with only a default
 * export (the fetch handler). Cloudflare requires Durable Object and Workflow
 * classes to be named exports from the worker entry point.
 *
 * This plugin runs after the adapter in the closeBundle hook. It bundles the
 * extra exports with esbuild and creates a new _worker.js that re-exports the
 * SvelteKit default handler alongside the named exports.
 *
 * Usage in vite.config.ts:
 *   addWorkerExports({ entryPoint: 'src/lib/server/index.ts' })
 *
 * @see https://github.com/sveltejs/kit/issues/1712
 */

import { build } from 'esbuild';
import { access, rename, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Plugin } from 'vite';

export interface AddWorkerExportsOptions {
	/** File that exports Durable Object and/or Workflow classes */
	entryPoint: string;
	/** Directory containing the SvelteKit-generated _worker.js (default: .svelte-kit/cloudflare) */
	outputDir?: string;
}

export function addWorkerExports(options: AddWorkerExportsOptions): Plugin {
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

async function exists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}
