import { sveltekit } from '@sveltejs/kit/vite';
import adapter from '@sveltejs/adapter-cloudflare';
import { addWorkerExports } from '@oselvar/sveltekit-add-worker-exports';
import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

// SvelteKit v3 no longer reads svelte.config.js — kit configuration is passed
// directly to the `sveltekit(...)` plugin, which is now async.
export default defineConfig({
	plugins: [
		await sveltekit({
			adapter: adapter({
				platformProxy: {
					configPath: '.platform-proxy-wrangler.jsonc',
					// Must be absolute: miniflare 5 rejects Workflow calls when the persist
					// path is relative ("Invalid workflow name").
					persist: { path: fileURLToPath(new URL('.wrangler/state', import.meta.url)) }
				}
			})
		}),
		// Not the default 8787, so this app's dev server can run alongside example/'s.
		addWorkerExports({ entryPoint: 'src/lib/server/index.ts', devPort: 8788 })
	]
});
