/**
 * Helpers for the acceptance tests: spawn the example apps as child
 * processes (vite dev / vite build / wrangler dev) and talk to them with
 * plain `fetch` and Node's built-in `WebSocket` — no browser involved.
 */

import { spawn } from 'node:child_process';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const baseEnv = {
	...process.env,
	FORCE_COLOR: '0',
	WRANGLER_SEND_METRICS: 'false'
};

export interface ManagedProcess {
	/** Everything the process wrote to stdout and stderr so far. */
	output(): string;
	/** Terminates the whole process group (vite/wrangler spawn workerd children). */
	kill(): Promise<void>;
}

/**
 * Starts a long-running command via `pnpm exec` in `cwd`, detached so the
 * whole process group (including workerd grandchildren) can be signalled.
 */
export function startProcess(args: string[], cwd: string): ManagedProcess {
	const child = spawn('pnpm', ['exec', ...args], {
		cwd,
		detached: true,
		stdio: ['ignore', 'pipe', 'pipe'],
		env: baseEnv
	});
	let output = '';
	child.stdout.on('data', (data) => (output += data));
	child.stderr.on('data', (data) => (output += data));
	const exited = new Promise<void>((resolve) => child.on('exit', () => resolve()));

	return {
		output: () => output,
		async kill() {
			if (child.exitCode === null && child.signalCode === null) {
				// SIGTERM first so vite can dispose the sidecar and clean up its
				// temp wrangler configs; escalate to SIGKILL if it hangs.
				try {
					process.kill(-child.pid!, 'SIGTERM');
				} catch {
					/* group already gone */
				}
				const timedOut = await Promise.race([
					exited.then(() => false),
					sleep(10_000).then(() => true)
				]);
				if (timedOut) {
					try {
						process.kill(-child.pid!, 'SIGKILL');
					} catch {
						/* group already gone */
					}
					await exited;
				}
			}
			// Sweep any orphaned group members (e.g. workerd) that survived.
			try {
				process.kill(-child.pid!, 'SIGKILL');
			} catch {
				/* group already gone */
			}
		}
	};
}

/**
 * Runs a command via `pnpm exec` in `cwd` to completion. Resolves with the
 * combined output, rejects (including the output) on a non-zero exit.
 */
export function runToCompletion(args: string[], cwd: string): Promise<string> {
	return new Promise((resolve, reject) => {
		const child = spawn('pnpm', ['exec', ...args], {
			cwd,
			stdio: ['ignore', 'pipe', 'pipe'],
			env: baseEnv
		});
		let output = '';
		child.stdout.on('data', (data) => (output += data));
		child.stderr.on('data', (data) => (output += data));
		child.on('error', reject);
		child.on('exit', (code) => {
			if (code === 0) resolve(output);
			else reject(new Error(`\`${args.join(' ')}\` exited with ${code}\n${output}`));
		});
	});
}

/**
 * Polls `url` until the server responds with something `accept`s (any
 * response by default — a 404 still proves the server is up).
 */
export async function waitForHttp(
	url: string,
	timeoutMs: number,
	accept: (res: Response) => boolean = () => true
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	let lastError: unknown;
	while (Date.now() < deadline) {
		try {
			const res = await fetch(url, { signal: AbortSignal.timeout(2_000) });
			if (accept(res)) return;
			lastError = new Error(`unexpected status ${res.status}`);
		} catch (error) {
			lastError = error;
		}
		await sleep(500);
	}
	throw new Error(`Timed out after ${timeoutMs}ms waiting for ${url}: ${lastError}`);
}

/** Polls `url` until connections are refused, i.e. the port is released. */
export async function waitForPortClosed(url: string, timeoutMs: number): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			await fetch(url, { signal: AbortSignal.timeout(1_000) });
		} catch {
			return;
		}
		await sleep(500);
	}
	throw new Error(`Timed out after ${timeoutMs}ms waiting for ${url} to stop responding`);
}

/**
 * POSTs `body` to `url`, retrying until the response is ok. Retries cover
 * the window where the dev-registry routing between the platform proxy and
 * the sidecar is still settling.
 */
export async function postWithRetry(
	url: string,
	body: string,
	timeoutMs = 30_000
): Promise<Response> {
	const deadline = Date.now() + timeoutMs;
	let lastError: unknown;
	while (Date.now() < deadline) {
		try {
			const res = await fetch(url, {
				method: 'POST',
				body,
				// A same-origin `Origin`, as a browser would send. SvelteKit's CSRF
				// check rejects text/plain POSTs without one (v3 is stricter than
				// v2 about a missing header).
				headers: { origin: new URL(url).origin },
				signal: AbortSignal.timeout(10_000)
			});
			if (res.ok) return res;
			lastError = new Error(`status ${res.status}: ${await res.text()}`);
		} catch (error) {
			lastError = error;
		}
		await sleep(1_000);
	}
	throw new Error(`POST ${url} never succeeded within ${timeoutMs}ms: ${lastError}`);
}

/** A WebSocket client that records incoming messages for assertions. */
export class WsClient {
	readonly messages: string[] = [];
	private waiters: Array<() => void> = [];

	private constructor(private readonly ws: WebSocket) {}

	/** Connects to `url`, retrying while the server is still coming up. */
	static async connect(url: string, timeoutMs = 15_000): Promise<WsClient> {
		const deadline = Date.now() + timeoutMs;
		let lastError: unknown;
		while (Date.now() < deadline) {
			try {
				const ws = await new Promise<WebSocket>((resolve, reject) => {
					const socket = new WebSocket(url);
					socket.addEventListener('open', () => resolve(socket));
					socket.addEventListener('error', () =>
						reject(new Error(`WebSocket connection to ${url} failed`))
					);
				});
				const client = new WsClient(ws);
				ws.addEventListener('message', (event) => {
					client.messages.push(String(event.data));
					for (const wake of client.waiters.splice(0)) wake();
				});
				return client;
			} catch (error) {
				lastError = error;
				await sleep(500);
			}
		}
		throw new Error(`Could not connect to ${url} within ${timeoutMs}ms: ${lastError}`);
	}

	send(message: string): void {
		this.ws.send(message);
	}

	/** Resolves with the first received message matching `predicate`. */
	async waitFor(predicate: (message: string) => boolean, timeoutMs: number): Promise<string> {
		const deadline = Date.now() + timeoutMs;
		for (;;) {
			const found = this.messages.find(predicate);
			if (found !== undefined) return found;
			const remaining = deadline - Date.now();
			if (remaining <= 0) {
				throw new Error(
					`Timed out after ${timeoutMs}ms waiting for a WebSocket message. ` +
						`Received so far: ${JSON.stringify(this.messages)}`
				);
			}
			await new Promise<void>((resolve) => {
				const timer = setTimeout(resolve, Math.min(remaining, 1_000));
				this.waiters.push(() => {
					clearTimeout(timer);
					resolve();
				});
			});
		}
	}

	close(): void {
		this.ws.close();
	}
}
