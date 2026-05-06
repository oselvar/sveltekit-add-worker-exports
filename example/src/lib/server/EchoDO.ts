import { DurableObject } from 'cloudflare:workers';

type Attachment = { roomName: string };

export class EchoDO extends DurableObject<Env> {
	async fetch(request: Request): Promise<Response> {
		if (request.headers.get('Upgrade') !== 'websocket') {
			return new Response('Expected WebSocket', { status: 426 });
		}

		const match = new URL(request.url).pathname.match(/^\/ws\/(.+)$/);
		const roomName = match?.[1] ?? 'default';

		const pair = new WebSocketPair();
		this.ctx.acceptWebSocket(pair[1]);
		pair[1].serializeAttachment({ roomName } satisfies Attachment);
		return new Response(null, { status: 101, webSocket: pair[0] });
	}

	async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
		// Broadcast the user's message to all connected clients
		for (const client of this.ctx.getWebSockets()) {
			client.send(message);
		}

		// Trigger the bot workflow for text messages
		if (typeof message === 'string') {
			const { roomName } = (ws.deserializeAttachment() as Attachment | null) ?? {
				roomName: 'default'
			};
			await this.env.BOT_WORKFLOW.create({
				params: { roomName, userMessage: message }
			});
		}
	}

	async webSocketClose(ws: WebSocket): Promise<void> {
		ws.close();
	}

	async webSocketError(ws: WebSocket): Promise<void> {
		ws.close();
	}

	// Called by BotWorkflow to broadcast the bot's reply
	async replyAsBot(message: string): Promise<void> {
		for (const client of this.ctx.getWebSockets()) {
			client.send(`🤖 ${message}`);
		}
	}
}
