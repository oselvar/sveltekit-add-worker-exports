export async function forwardWebSocket<T extends Rpc.DurableObjectBranded | undefined>(
	request: Request,
	namespace: DurableObjectNamespace<T>,
	name: string
): Promise<Response> {
	if (request.headers.get('upgrade') !== 'websocket') {
		return new Response('Expected WebSocket', { status: 426 });
	}
	const id = namespace.idFromName(name);
	return namespace.get(id).fetch(request);
}
