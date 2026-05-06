import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';

export type BotWorkflowParams = {
	roomName: string;
	userMessage: string;
};

export class BotWorkflow extends WorkflowEntrypoint<Env, BotWorkflowParams> {
	async run(event: WorkflowEvent<BotWorkflowParams>, step: WorkflowStep): Promise<void> {
		const { roomName, userMessage } = event.payload;

		await step.sleep('think', '2 seconds');

		const reply = await step.do('generate reply', async () => {
			return `I heard you say: "${userMessage}"`;
		});

		await step.do('send reply', async () => {
			const id = this.env.ECHO.idFromName(roomName);
			await this.env.ECHO.get(id).replyAsBot(reply);
		});
	}
}
