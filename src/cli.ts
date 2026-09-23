/**
 * CLI for tasks that shouldn't require a running `vite dev`.
 *
 *   sveltekit-add-worker-exports write-config [options]
 *
 * Writes `.dev-worker-wrangler.jsonc` (the config the dev sidecar runs) so
 * `wrangler types --config .dev-worker-wrangler.jsonc [--check]` works in CI.
 * The plugin options are read from the vite config by default; `--entry`
 * skips loading it.
 */

import { relative } from 'node:path';
import { parseArgs } from 'node:util';
import type { Plugin, PluginOption } from 'vite';
import {
	DEV_WORKER_CONFIG_FILE,
	writeDevWorkerConfig,
	type AddWorkerExportsOptions
} from './index.js';

export const USAGE = `Usage: sveltekit-add-worker-exports write-config [options]

Writes ${DEV_WORKER_CONFIG_FILE} for \`wrangler types --config ${DEV_WORKER_CONFIG_FILE}\`
without starting the dev server.

Options:
  --out <path>              Output file (default: ${DEV_WORKER_CONFIG_FILE})
  --vite-config <path>      Vite config to read plugin options from (default: auto-discovered)
  --entry <path>            Worker entry point; skips loading the vite config
  --wrangler-config <path>  Wrangler config (default: from the vite config, else auto-discovered)
  -h, --help                Show this help
`;

export async function main(argv: string[]): Promise<void> {
	const { positionals, values } = parseArgs({
		args: argv,
		allowPositionals: true,
		options: {
			out: { type: 'string' },
			'vite-config': { type: 'string' },
			entry: { type: 'string' },
			'wrangler-config': { type: 'string' },
			help: { type: 'boolean', short: 'h' }
		}
	});

	if (values.help) {
		process.stdout.write(USAGE);
		return;
	}
	if (positionals[0] !== 'write-config' || positionals.length > 1) {
		throw new UsageError(
			positionals.length ? `Unknown command: ${positionals.join(' ')}` : 'No command given'
		);
	}

	const options: AddWorkerExportsOptions = values.entry
		? { entryPoint: values.entry }
		: await loadPluginOptions(values['vite-config']);
	if (values['wrangler-config']) {
		options.wranglerConfig = values['wrangler-config'];
	}

	const path = await writeDevWorkerConfig(options, values.out);
	process.stdout.write(`Wrote ${relative(process.cwd(), path) || path}\n`);
}

/**
 * Loads the vite config and returns the options passed to
 * `addWorkerExports()`, which the dev plugin exposes as `api.options`.
 */
export async function loadPluginOptions(configFile?: string): Promise<AddWorkerExportsOptions> {
	const { loadConfigFromFile } = await import('vite');
	const loaded = await loadConfigFromFile(
		{ command: 'serve', mode: 'development' },
		configFile,
		process.cwd(),
		'silent'
	);
	if (!loaded) {
		throw new Error('No vite config found. Pass --vite-config <path> or --entry <path>.');
	}
	const plugins = await flattenPlugins(loaded.config.plugins ?? []);
	const plugin = plugins.find((p) => p.name === 'add-worker-exports-dev');
	const options = plugin?.api?.options as AddWorkerExportsOptions | undefined;
	if (!options) {
		throw new Error(
			`addWorkerExports() not found in ${relative(process.cwd(), loaded.path)}. Pass --entry <path> instead.`
		);
	}
	return { ...options };
}

async function flattenPlugins(options: PluginOption[]): Promise<Plugin[]> {
	const plugins: Plugin[] = [];
	for (const option of options) {
		const resolved = await option;
		if (Array.isArray(resolved)) {
			plugins.push(...(await flattenPlugins(resolved)));
		} else if (resolved) {
			plugins.push(resolved);
		}
	}
	return plugins;
}

export class UsageError extends Error {}
