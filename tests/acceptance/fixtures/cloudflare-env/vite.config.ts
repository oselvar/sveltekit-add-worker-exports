// No SvelteKit: this fixture only exercises the plugin's dev sidecar.
import { addWorkerExports } from '@oselvar/sveltekit-add-worker-exports';
import { defineConfig } from 'vite';

export default defineConfig({
	// Its own sidecar port, so it can run alongside the example apps' tests.
	plugins: [addWorkerExports({ entryPoint: 'src/index.ts', devPort: 8789 })]
});
