// The sidecar's entry point: replies with the FRONTEND_URL it was started with.
export default {
	async fetch(_request: Request, env: { FRONTEND_URL: string }): Promise<Response> {
		return new Response(env.FRONTEND_URL);
	}
};
