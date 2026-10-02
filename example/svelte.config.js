import adapter from '@sveltejs/adapter-cloudflare';
import { fileURLToPath } from 'node:url';

/** @type {import('@sveltejs/kit').Config} */
const config = {
	kit: {
		adapter: adapter({
			platformProxy: {
				configPath: '.platform-proxy-wrangler.jsonc',
				// Must be absolute: miniflare 5 rejects Workflow calls when the persist
				// path is relative ("Invalid workflow name").
				persist: { path: fileURLToPath(new URL('.wrangler/state', import.meta.url)) }
			}
		})
	}
};

export default config;
