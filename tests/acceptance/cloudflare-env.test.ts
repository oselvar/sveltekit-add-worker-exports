import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { type ManagedProcess, startProcess, waitForHttp, waitForPortClosed } from './helpers';
import { CLOUDFLARE_ENV_PORTS } from './ports';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '../..');

// https://github.com/oselvar/sveltekit-add-worker-exports/issues/11: the
// sidecar must load `.env.<CLOUDFLARE_ENV>`, not only `.env`, like
// `wrangler dev --env <env>` does.
describe('CLOUDFLARE_ENV — dev sidecar (fixtures/cloudflare-env)', () => {
	const dir = join(ROOT, 'tests/acceptance/fixtures/cloudflare-env');
	const sidecarUrl = `http://localhost:${CLOUDFLARE_ENV_PORTS.sidecarPort}`;
	let proc: ManagedProcess;
	let registryPath: string;

	beforeAll(async () => {
		// A private registry, so the assertion below doesn't depend on (or
		// disturb) other wrangler dev sessions on this machine.
		registryPath = await mkdtemp(join(tmpdir(), 'wrangler-registry-'));
		proc = startProcess(
			['vite', 'dev', '--port', String(CLOUDFLARE_ENV_PORTS.vitePort), '--strictPort'],
			dir,
			{ CLOUDFLARE_ENV: 'dev_b', WRANGLER_REGISTRY_PATH: registryPath }
		);
		try {
			await waitForHttp(`http://localhost:${CLOUDFLARE_ENV_PORTS.vitePort}/`, 120_000);
			await waitForHttp(`${sidecarUrl}/`, 60_000);
		} catch (error) {
			await proc.kill();
			throw new Error(`${error}\n--- vite dev output ---\n${proc.output()}`);
		}
	});

	beforeEach(({ onTestFailed }) => {
		onTestFailed(() => {
			console.error(`--- cloudflare-env vite dev output ---\n${proc?.output().slice(-8000)}`);
		});
	});

	afterAll(async () => {
		await proc?.kill();
		await waitForPortClosed(`${sidecarUrl}/`, 30_000);
		await rm(registryPath, { recursive: true, force: true });
	});

	test('loads .env.<CLOUDFLARE_ENV> over .env', async () => {
		const res = await fetch(`${sidecarUrl}/`);
		expect(await res.text()).toBe('http://localhost:5180');
	});

	test('registers the sidecar under the env-suffixed name', async () => {
		expect(await readdir(registryPath)).toContain('cloudflare-env-fixture-dev-worker-dev_b');
	});
});
