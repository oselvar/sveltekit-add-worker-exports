import { forwardWebSocket } from './forwardWebSocket';

export { EchoDO } from './EchoDO';
export { BotWorkflow } from './BotWorkflow';
export { VoicedAgent } from './VoicedAgent';

// `fetch` runs only in the wrangler dev sidecar — SvelteKit's route handlers
// own request handling in production. `scheduled` runs in both: Cloudflare
// invokes it from the cron triggers in wrangler.jsonc, and the plugin merges
// it onto the production worker's default export.
export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const match = new URL(request.url).pathname.match(/^\/ws\/(.+)$/);
		if (!match) return new Response('Not found', { status: 404 });
		console.log(`WebSocket upgrade for room "${match[1]}"`);
		return forwardWebSocket(request, env.ECHO, match[1]);
	},
	async scheduled(event: ScheduledEvent, _env: Env, _ctx: ExecutionContext): Promise<void> {
		console.log(`Cron fired: ${event.cron} at ${new Date(event.scheduledTime).toISOString()}`);
	}
};
