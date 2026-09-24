import { env } from 'cloudflare:workers';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ params, request }) => {
	const text = await request.text();
	const id = env.ECHO.idFromName(params.room);
	await env.ECHO.get(id).replyAsBot(text);
	return new Response('ok');
};
