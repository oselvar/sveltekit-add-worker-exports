// SvelteKit 3 example app (example-v3/). See appSuites.ts.
import { defineAppSuites } from './appSuites';
import { EXAMPLE_V3_PORTS } from './ports';

defineAppSuites({ name: 'example-v3', ...EXAMPLE_V3_PORTS, userTextRule: true });
