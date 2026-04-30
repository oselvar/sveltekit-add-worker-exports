import { sveltekit } from '@sveltejs/kit/vite';
import { addWorkerExports } from '@oselvar/sveltekit-add-worker-exports';
import { defineConfig } from 'vite';

export default defineConfig({
	plugins: [sveltekit(), addWorkerExports({ entryPoint: 'src/lib/server/index.ts' })]
});
