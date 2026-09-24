import { env } from 'cloudflare:workers';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ params, request }) => {
	const userMessage = await request.text();
	const instance = await env.BOT_WORKFLOW.create({
		params: { roomName: params.room, userMessage }
	});
	return new Response(instance.id);
};
