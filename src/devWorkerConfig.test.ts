import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseJsonc } from 'jsonc-parser';
import { deriveDevWorkerConfig, parseWranglerConfig, writeDevWorkerConfig } from './index';
import { loadPluginOptions, main } from './cli';

const fixturesDir = join(import.meta.dirname, '__fixtures__');
const fixtureConfigPath = join(fixturesDir, 'wrangler.jsonc');
const fixtureConfig = parseWranglerConfig(
	fixtureConfigPath,
	readFileSync(fixtureConfigPath, 'utf-8')
) as any;

describe('deriveDevWorkerConfig', () => {
	it('points main at the entry point, renames, sets the dev port and drops assets', () => {
		const derived = deriveDevWorkerConfig(fixtureConfig, {
			entryPoint: 'src/lib/server/index.ts',
			devPort: 9999
		});

		expect(derived.main).toBe('src/lib/server/index.ts');
		expect(derived.name).toBe('fixture-worker-dev-worker');
		expect(derived.dev).toEqual({ port: 9999 });
		expect(derived.assets).toBeUndefined();
		expect(derived.durable_objects).toEqual(fixtureConfig.durable_objects);
		expect(derived.migrations).toEqual(fixtureConfig.migrations);
	});

	it('defaults the dev port and does not mutate the input', () => {
		const derived = deriveDevWorkerConfig(fixtureConfig, { entryPoint: 'x.ts' });

		expect(derived.dev.port).toBe(8787);
		expect(fixtureConfig.main).toBe('src/entry.ts');
		expect(fixtureConfig.assets).toBeDefined();
	});
});

describe('without the dev server', () => {
	let dir: string;
	let cwd: string;

	beforeEach(() => {
		cwd = process.cwd();
		dir = mkdtempSync(join(tmpdir(), 'add-worker-exports-'));
		writeFileSync(join(dir, 'wrangler.jsonc'), readFileSync(fixtureConfigPath));
		process.chdir(dir);
	});

	afterEach(() => {
		process.chdir(cwd);
		rmSync(dir, { recursive: true, force: true });
	});

	const readOutput = (file = '.dev-worker-wrangler.jsonc') =>
		parseJsonc(readFileSync(join(dir, file), 'utf-8'));

	it('writeDevWorkerConfig writes the derived config', async () => {
		const path = await writeDevWorkerConfig({ entryPoint: 'src/lib/server/index.ts' });

		expect(path).toBe(join(process.cwd(), '.dev-worker-wrangler.jsonc'));
		expect(readOutput()).toEqual(
			deriveDevWorkerConfig(fixtureConfig, { entryPoint: 'src/lib/server/index.ts' })
		);
	});

	it('loadPluginOptions finds the options in a vite config', async () => {
		// A stand-in for addWorkerExports(): nested and async plugin options,
		// like `plugins: [sveltekit(), addWorkerExports(...)]`.
		writeFileSync(
			join(dir, 'vite.config.mjs'),
			`export default {
				plugins: [
					Promise.resolve([{ name: 'sveltekit' }]),
					[{ name: 'add-worker-exports' }, { name: 'add-worker-exports-dev', api: { options: { entryPoint: 'src/worker.ts', devPort: 1234 } } }]
				]
			};\n`
		);

		expect(await loadPluginOptions()).toEqual({ entryPoint: 'src/worker.ts', devPort: 1234 });
	});

	it('loadPluginOptions fails when the plugin is missing', async () => {
		writeFileSync(join(dir, 'vite.config.mjs'), `export default { plugins: [] };\n`);

		await expect(loadPluginOptions()).rejects.toThrow(/addWorkerExports\(\) not found/);
	});

	it('write-config --entry --out writes without a vite config', async () => {
		await main(['write-config', '--entry', 'src/worker.ts', '--out', 'types.jsonc']);

		expect(readOutput('types.jsonc').main).toBe('src/worker.ts');
	});

	it('rejects unknown commands', async () => {
		await expect(main(['nope'])).rejects.toThrow(/Unknown command: nope/);
	});
});
