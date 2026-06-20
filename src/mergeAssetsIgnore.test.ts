import { describe, it, expect } from 'vitest';
import { mergeAssetsIgnore, PLUGIN_ASSETS_IGNORE_ENTRIES } from './index';

// The .assetsignore content adapter-cloudflare generates.
const ADAPTER_DEFAULT = '\n_worker.js\n_routes.json\n_headers\n_redirects\n';

describe('mergeAssetsIgnore', () => {
	it('appends all plugin entries to the adapter default', () => {
		const result = mergeAssetsIgnore(ADAPTER_DEFAULT, PLUGIN_ASSETS_IGNORE_ENTRIES);
		for (const entry of PLUGIN_ASSETS_IGNORE_ENTRIES) {
			expect(result).toContain(entry);
		}
	});

	it('preserves the adapter-generated lines', () => {
		const result = mergeAssetsIgnore(ADAPTER_DEFAULT, PLUGIN_ASSETS_IGNORE_ENTRIES);
		for (const line of ['_worker.js', '_routes.json', '_headers', '_redirects']) {
			expect(result).toContain(line);
		}
	});

	it('is idempotent — running twice adds nothing new', () => {
		const once = mergeAssetsIgnore(ADAPTER_DEFAULT, PLUGIN_ASSETS_IGNORE_ENTRIES);
		const twice = mergeAssetsIgnore(once, PLUGIN_ASSETS_IGNORE_ENTRIES);
		expect(twice).toBe(once);
	});

	it('does not duplicate an entry that is already present', () => {
		const existing = '_worker.js\n_extra_exports.js\n';
		const result = mergeAssetsIgnore(existing, PLUGIN_ASSETS_IGNORE_ENTRIES);
		const occurrences = result.split('\n').filter((l) => l.trim() === '_extra_exports.js').length;
		expect(occurrences).toBe(1);
	});

	it('treats empty existing content as creating a fresh file', () => {
		const result = mergeAssetsIgnore('', PLUGIN_ASSETS_IGNORE_ENTRIES);
		for (const entry of PLUGIN_ASSETS_IGNORE_ENTRIES) {
			expect(result).toContain(entry);
		}
		expect(result.endsWith('\n')).toBe(true);
	});

	it('ignores surrounding whitespace when comparing existing entries', () => {
		const existing = '  _extra_exports.js  \n';
		const result = mergeAssetsIgnore(existing, ['_extra_exports.js']);
		const occurrences = result.split('\n').filter((l) => l.trim() === '_extra_exports.js').length;
		expect(occurrences).toBe(1);
	});
});
