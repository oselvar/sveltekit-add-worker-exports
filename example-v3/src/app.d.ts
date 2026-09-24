/// <reference path="../worker-configuration.d.ts" />

// SvelteKit v3's adapter-cloudflare no longer provides `event.platform`;
// routes read bindings with `import { env } from 'cloudflare:workers'`.
declare global {
	const __DEV_WORKER_PORT__: number;
}

export {};
