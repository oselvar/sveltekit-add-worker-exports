import { defineConfig } from 'vitest/config';

// Acceptance tests spawn the example apps (vite dev / vite build / wrangler
// dev) and drive them over HTTP and WebSocket. Each test file runs in its
// own worker, in parallel with the others: they use separate ports (see
// tests/acceptance/ports.ts) and private wrangler dev registries. Within a
// file, dev mode and built mode run one after the other.
export default defineConfig({
	test: {
		include: ['tests/acceptance/**/*.test.ts'],
		globalSetup: ['tests/acceptance/globalSetup.ts'],
		testTimeout: 60_000,
		hookTimeout: 300_000
	}
});
