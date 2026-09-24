import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type AddressInfo, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { removeDeadRegistryEntry } from './index';

describe('removeDeadRegistryEntry', () => {
	let registry: string;
	let server: Server | undefined;

	beforeEach(() => {
		registry = mkdtempSync(join(tmpdir(), 'wrangler-registry-'));
	});

	afterEach(() => {
		server?.close();
		server = undefined;
		rmSync(registry, { recursive: true, force: true });
	});

	const writeEntry = (debugPortAddress: string) =>
		writeFileSync(join(registry, 'app-dev-worker'), JSON.stringify({ debugPortAddress }));

	it('removes an entry whose debug port is not listening', async () => {
		// Grab a free port, then close it so nothing listens there.
		const port = await new Promise<number>((resolve) => {
			const s = createServer().listen(0, '127.0.0.1', () => {
				const { port } = s.address() as AddressInfo;
				s.close(() => resolve(port));
			});
		});
		writeEntry(`127.0.0.1:${port}`);

		await removeDeadRegistryEntry(registry, 'app-dev-worker');

		expect(existsSync(join(registry, 'app-dev-worker'))).toBe(false);
	});

	it('keeps an entry whose debug port is listening', async () => {
		const port = await new Promise<number>((resolve) => {
			server = createServer().listen(0, '127.0.0.1', () =>
				resolve((server!.address() as AddressInfo).port)
			);
		});
		writeEntry(`127.0.0.1:${port}`);

		await removeDeadRegistryEntry(registry, 'app-dev-worker');

		expect(existsSync(join(registry, 'app-dev-worker'))).toBe(true);
	});

	it('does nothing when there is no entry', async () => {
		await expect(removeDeadRegistryEntry(registry, 'missing')).resolves.toBeUndefined();
	});
});
