import { env } from 'cloudflare:workers';
import { forwardWebSocket } from '#lib/server/forwardWebSocket.ts';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = ({ params, request }) =>
	forwardWebSocket(request, env.ECHO, params.id);
