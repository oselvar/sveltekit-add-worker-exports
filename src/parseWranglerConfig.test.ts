import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseWranglerConfig } from './index.ts';

const fixturesDir = join(import.meta.dirname, '__fixtures__');

describe('parseWranglerConfig', () => {
	it('parses JSONC and TOML to deep-equal objects', () => {
		const jsoncPath = join(fixturesDir, 'wrangler.jsonc');
		const tomlPath = join(fixturesDir, 'wrangler.toml');
		const jsoncContents = readFileSync(jsoncPath, 'utf-8');
		const tomlContents = readFileSync(tomlPath, 'utf-8');

		const fromJsonc = parseWranglerConfig(jsoncPath, jsoncContents);
		const fromToml = parseWranglerConfig(tomlPath, tomlContents);

		expect(fromToml).toEqual(fromJsonc);
	});

	it('parses JSONC content shape correctly', () => {
		const jsoncPath = join(fixturesDir, 'wrangler.jsonc');
		const jsoncContents = readFileSync(jsoncPath, 'utf-8');
		const config = parseWranglerConfig(jsoncPath, jsoncContents) as {
			name: string;
			durable_objects: { bindings: Array<{ name: string }> };
			env: { staging: { name: string } };
		};

		expect(config.name).toBe('fixture-worker');
		expect(config.durable_objects.bindings[0].name).toBe('ECHO');
		expect(config.env.staging.name).toBe('fixture-worker-staging');
	});
});
