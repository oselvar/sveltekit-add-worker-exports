// No SvelteKit: this fixture only exercises the plugin's dev sidecar.
import { addWorkerExports } from '@oselvar/sveltekit-add-worker-exports';
import { defineConfig } from 'vite';

export default defineConfig({
	plugins: [addWorkerExports({ entryPoint: 'src/index.ts' })]
});
