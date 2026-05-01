import { forwardWebSocket } from '$lib/server/forwardWebSocket';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = ({ params, request, platform }) =>
	forwardWebSocket(request, platform!.env.ECHO, params.id);
