import adapter from '@sveltejs/adapter-cloudflare';

/** @type {import('@sveltejs/kit').Config} */
const config = {
	kit: {
		adapter: adapter({
			platformProxy: {
				configPath: '.platform-proxy-wrangler.jsonc',
				persist: { path: '.wrangler/state' }
			}
		})
	}
};

export default config;
