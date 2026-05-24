/**
 * SvelteKit `Handle` re-exported for users.
 *
 * Implementation lives in `./bridge/runtime-hook` while the workflow bridge
 * exists. Once miniflare ships cross-worker workflow routing
 * (cloudflare/workers-sdk#7459), replace this file with a no-op handle:
 *
 *   import type { Handle } from '@sveltejs/kit';
 *   export const handle: Handle = ({ event, resolve }) => resolve(event);
 *
 * and delete `src/bridge/`.
 */
export { handle } from './bridge/runtime-hook.js';
