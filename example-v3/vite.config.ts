import { sveltekit } from '@sveltejs/kit/vite';
import adapter from '@sveltejs/adapter-cloudflare';
import { addWorkerExports } from '@oselvar/sveltekit-add-worker-exports';
import { defineConfig } from 'vite';

// SvelteKit v3 no longer reads svelte.config.js — kit configuration is passed
// directly to the `sveltekit(...)` plugin, which is now async.
export default defineConfig({
	plugins: [
		await sveltekit({
			adapter: adapter({
				platformProxy: {
					configPath: '.platform-proxy-wrangler.jsonc',
					persist: { path: '.wrangler/state' }
				}
			})
		}),
		addWorkerExports({ entryPoint: 'src/lib/server/index.ts' })
	]
});
