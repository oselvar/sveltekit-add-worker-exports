import { forwardWebSocket } from './forwardWebSocket';

// Fetch handler for the wrangler dev server.
// In production, SvelteKit's route handlers handle all requests.
export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const match = new URL(request.url).pathname.match(/^\/ws\/(.+)$/);
		if (!match) return new Response('Not found', { status: 404 });
		return forwardWebSocket(request, env.ECHO, match[1]);
	}
};
