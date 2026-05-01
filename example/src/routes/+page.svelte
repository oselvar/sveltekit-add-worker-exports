<script lang="ts">
	import { dev } from '$app/environment';

	let messages = $state<string[]>([]);
	let input = $state('');
	let ws: WebSocket | null = $state(null);
	let connected = $state(false);

	$effect(() => {
		let wsUrl: string;
		if (dev) {
			wsUrl = `ws://${window.location.hostname}:${__DEV_WORKER_PORT__}/ws/chat`;
		} else {
			const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
			wsUrl = `${protocol}//${window.location.host}/ws/chat`;
		}

		const socket = new WebSocket(wsUrl);
		socket.addEventListener('open', () => (connected = true));
		socket.addEventListener('close', () => (connected = false));
		socket.addEventListener('message', (e) => {
			messages = [...messages, String(e.data)];
		});
		ws = socket;

		return () => socket.close();
	});

	function send() {
		if (ws && input.trim()) {
			ws.send(input.trim());
			input = '';
		}
	}
</script>

<h1>Echo Chat</h1>
<p>{connected ? 'Connected' : 'Connecting...'}</p>

<form
	onsubmit={(e) => {
		e.preventDefault();
		send();
	}}
>
	<input bind:value={input} placeholder="Type a message..." />
	<button type="submit" disabled={!connected}>Send</button>
</form>

<ul>
	{#each messages as msg}
		<li>{msg}</li>
	{/each}
</ul>
