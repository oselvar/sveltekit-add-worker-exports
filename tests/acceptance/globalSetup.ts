/**
 * Fails the run immediately if any port the tests need is already taken.
 * Without this, a leftover dev server (say, another project's `vite dev` on
 * 8787) answers the tests' requests, and every test retries until its
 * timeout: a 45s run turns into ten minutes of misleading failures.
 */

import { execFileSync } from 'node:child_process';
import { connect } from 'node:net';
import { ALL_PORTS } from './ports';

function isListening(port: number, host: string): Promise<boolean> {
	return new Promise((resolve) => {
		const socket = connect({ port, host });
		socket.setTimeout(500);
		socket.once('connect', () => {
			socket.destroy();
			resolve(true);
		});
		socket.once('timeout', () => {
			socket.destroy();
			resolve(false);
		});
		socket.once('error', () => resolve(false));
	});
}

/** Best effort: "pid 123 (node)", or '' where lsof/ps aren't available. */
function describeListener(port: number): string {
	try {
		const pids = execFileSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], {
			encoding: 'utf-8'
		})
			.trim()
			.split('\n')
			.filter(Boolean);
		return pids
			.map((pid) => {
				const command = execFileSync('ps', ['-o', 'command=', '-p', pid], {
					encoding: 'utf-8'
				}).trim();
				return `pid ${pid} (${command.slice(0, 120)})`;
			})
			.join(', ');
	} catch {
		return '';
	}
}

export default async function setup(): Promise<void> {
	const busy: string[] = [];
	for (const port of ALL_PORTS) {
		const [v4, v6] = await Promise.all([isListening(port, '127.0.0.1'), isListening(port, '::1')]);
		if (v4 || v6) {
			const who = describeListener(port);
			busy.push(`  ${port}${who ? `: ${who}` : ''}`);
		}
	}
	if (busy.length > 0) {
		throw new Error(
			`Acceptance tests need these ports, but they are already in use:\n${busy.join('\n')}\n` +
				'Stop those processes (e.g. a dev server from another project) and re-run.'
		);
	}
}
