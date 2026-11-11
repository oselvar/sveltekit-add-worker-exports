import { build } from 'esbuild';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readModuleRules } from './index';
import {
	createModuleRulesPlugin,
	WRANGLER_DEFAULT_MODULE_RULES,
	type ModuleRule
} from './moduleRules';

const fixturesDir = join(import.meta.dirname, '__fixtures__', 'moduleRules');

/** Bundles `entry` with the module-rules plugin and imports the result. */
async function bundleAndImport(
	entry: string,
	userRules: ModuleRule[] = []
): Promise<Record<string, unknown>> {
	const result = await build({
		entryPoints: [join(fixturesDir, entry)],
		bundle: true,
		format: 'esm',
		write: false,
		plugins: [createModuleRulesPlugin(userRules)],
		logLevel: 'silent'
	});
	const code = result.outputFiles[0].text;
	return import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
}

describe('createModuleRulesPlugin', () => {
	it('inlines .sql imports as strings via wrangler default rules', async () => {
		const bundled = await bundleAndImport('entry.ts');
		expect(bundled.schemaSql).toContain("VALUES ('hello from sql')");
		expect(typeof bundled.schemaSql).toBe('string');
	});

	it('inlines .bin imports as ArrayBuffer via wrangler default rules', async () => {
		const bundled = await bundleAndImport('entry.ts');
		expect(bundled.blob).toBeInstanceOf(ArrayBuffer);
		expect([...new Uint8Array(bundled.blob as ArrayBuffer)]).toEqual([0, 1, 2, 254, 255]);
	});

	it('applies user rules before default rules', async () => {
		// A user Text rule for *.bin (fallthrough so the default Data rule for
		// *.bin stays shadow-error-free for other types) wins over the default.
		const bundled = await bundleAndImport('entry.ts', [
			{ type: 'Text', include: ['**/*.bin'], fallthrough: true }
		]);
		expect(typeof bundled.blob).toBe('string');
	});

	it('rejects CompiledWasm imports with an actionable error', async () => {
		await expect(bundleAndImport('entry-wasm.ts')).rejects.toThrow(
			/"CompiledWasm" module rules are not supported/
		);
	});

	it('fails with the wrangler fallthrough error when a shadowed rule matches', async () => {
		// A user Text rule without fallthrough finalises Text, shadowing the
		// default Text rule — so the .sql import must fail with wrangler's
		// error, not esbuild's "No loader is configured".
		await expect(
			bundleAndImport('entry.ts', [{ type: 'Text', include: ['**/*.md'] }])
		).rejects.toThrow(/previous rule with the same type was not marked as `fallthrough = true`/);
	});
});

describe('WRANGLER_DEFAULT_MODULE_RULES', () => {
	it('matches wrangler defaults: .txt/.html/.sql as Text, .bin as Data, .wasm as CompiledWasm', () => {
		expect(WRANGLER_DEFAULT_MODULE_RULES).toEqual([
			{ type: 'Text', include: ['**/*.txt', '**/*.html', '**/*.sql'] },
			{ type: 'Data', include: ['**/*.bin'] },
			{ type: 'CompiledWasm', include: ['**/*.wasm', '**/*.wasm?module'] }
		]);
	});
});

describe('readModuleRules', () => {
	it('reads and maps rules from the wrangler config', async () => {
		const rules = await readModuleRules({
			entryPoint: 'unused.ts',
			wranglerConfig: join(import.meta.dirname, '__fixtures__', 'wrangler.jsonc')
		});
		expect(rules).toEqual([{ type: 'Text', include: ['**/*.graphql'], fallthrough: true }]);
	});

	it('returns no user rules when no config is auto-discovered', async () => {
		// vitest runs with cwd at the repo root, which has no wrangler config.
		// Wrangler returns an empty config rather than throwing in this case.
		const rules = await readModuleRules({ entryPoint: 'unused.ts' });
		expect(rules).toEqual([]);
	});

	it('fails the build when an explicitly configured path cannot be read', async () => {
		// Deliberately not swallowed: a broken or missing config would fail
		// `wrangler dev`/`deploy` too, and silently dropping the user's rules
		// here would reintroduce the dev/build asymmetry (#8).
		await expect(
			readModuleRules({
				entryPoint: 'unused.ts',
				wranglerConfig: join(import.meta.dirname, '__fixtures__', 'does-not-exist.jsonc')
			})
		).rejects.toThrow(/Could not read file/);
	});
});
