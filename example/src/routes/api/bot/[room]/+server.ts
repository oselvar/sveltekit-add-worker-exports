import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ params, request, platform }) => {
	const userMessage = await request.text();
	const instance = await platform!.env.BOT_WORKFLOW.create({
		params: { roomName: params.room, userMessage }
	});
	return new Response(instance.id);
};
