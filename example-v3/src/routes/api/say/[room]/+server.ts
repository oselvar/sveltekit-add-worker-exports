import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ params, request, platform }) => {
	const text = await request.text();
	const id = platform!.env.ECHO.idFromName(params.room);
	await platform!.env.ECHO.get(id).replyAsBot(text);
	return new Response('ok');
};
