/**
 * SvelteKit `Handle` re-exported for users.
 *
 * Kept as a no-op for backwards compatibility. Wrangler 4.98.0 fixed
 * cross-worker workflow routing in `getPlatformProxy`
 * (cloudflare/workers-sdk#13863), so `platform.env.MY_WORKFLOW` is now a
 * real binding in both dev and production — no synthesis required.
 */

import type { Handle } from '@sveltejs/kit';

export const handle: Handle = ({ event, resolve }) => resolve(event);
