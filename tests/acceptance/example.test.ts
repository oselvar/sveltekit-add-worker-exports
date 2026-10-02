// SvelteKit 2 example app (example/). See appSuites.ts.
import { defineAppSuites } from './appSuites';
import { EXAMPLE_PORTS } from './ports';

defineAppSuites({ name: 'example', ...EXAMPLE_PORTS, userTextRule: false });
