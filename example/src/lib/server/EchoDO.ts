import { DurableObject } from 'cloudflare:workers';

export class EchoDO extends DurableObject<Env> {
	async fetch(request: Request): Promise<Response> {
		if (request.headers.get('Upgrade') !== 'websocket') {
			return new Response('Expected WebSocket', { status: 426 });
		}

		const pair = new WebSocketPair();
		this.ctx.acceptWebSocket(pair[1]);
		return new Response(null, { status: 101, webSocket: pair[0] });
	}

	async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): void {
		// Broadcast to all connected clients
		for (const client of this.ctx.getWebSockets()) {
			client.send(message);
		}
	}

	async webSocketClose(ws: WebSocket): Promise<void> {
		ws.close();
	}

	async webSocketError(ws: WebSocket): Promise<void> {
		ws.close();
	}
}
