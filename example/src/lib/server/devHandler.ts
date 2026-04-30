// Fetch handler for the wrangler dev server.
// In production, SvelteKit's route handlers handle all requests.
export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);
		const match = url.pathname.match(/^\/ws\/(.+)$/);
		if (match && request.headers.get('Upgrade') === 'websocket') {
			const id = env.ECHO.idFromName(match[1]);
			return env.ECHO.get(id).fetch(request);
		}
		return new Response('Not found', { status: 404 });
	}
};
