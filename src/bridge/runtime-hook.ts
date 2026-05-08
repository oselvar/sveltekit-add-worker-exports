/**
 * SvelteKit `Handle` that injects fake Workflow bindings into `event.platform.env`
 * during `vite dev`. In production this is a no-op.
 *
 * Why: wrangler's `getPlatformProxy` (used by `adapter-cloudflare` in dev) deletes
 * workflow bindings before they reach miniflare, so `+server.ts` can't call
 * `platform.env.MY_WORKFLOW.create(...)` directly. The companion vite plugin
 * exposes a service binding (`__SWE_BRIDGE`) that fetches into a sidecar wrangler
 * dev worker which has the real workflow binding. This hook synthesizes a
 * `Workflow`-shaped object per declared workflow that proxies API calls through
 * that bridge.
 *
 * Usage in `src/hooks.server.ts`:
 *
 *   export { handle } from '@oselvar/sveltekit-add-worker-exports/hooks';
 *
 * If you already have a `handle`, compose with `sequence`:
 *
 *   import { sequence } from '@sveltejs/kit/hooks';
 *   import { handle as sweHandle } from '@oselvar/sveltekit-add-worker-exports/hooks';
 *   export const handle = sequence(sweHandle, myHandle);
 */

import type { Handle } from '@sveltejs/kit';

interface FetcherLike {
	fetch(input: Request | string, init?: RequestInit): Promise<Response>;
}

interface SweGlobals {
	__SWE_BRIDGE_NAME__?: string;
	__SWE_WORKFLOWS__?: readonly string[];
}

/**
 * Reads bridge config from `globalThis`, set by the vite dev plugin at startup.
 *
 * We can't rely on vite `define` / compile-time substitution here because this
 * file ships in node_modules and vite doesn't transform external modules in
 * SSR by default. Plain runtime globals dodge that entirely and stay
 * `undefined` in production (workerd), making this hook a no-op there.
 */
export const handle: Handle = async ({ event, resolve }) => {
	const g = globalThis as SweGlobals;
	const bridgeName = g.__SWE_BRIDGE_NAME__;
	const workflows = g.__SWE_WORKFLOWS__;
	if (!bridgeName || !workflows || workflows.length === 0) return resolve(event);
	const env = (event.platform as { env?: Record<string, unknown> } | undefined)?.env;
	if (!env) return resolve(event);
	const bridge = env[bridgeName] as FetcherLike | undefined;
	if (!bridge) return resolve(event);
	for (const name of workflows) {
		if (env[name]) continue;
		env[name] = makeFakeWorkflow(bridge, name);
	}
	return resolve(event);
};

function makeFakeWorkflow(bridge: FetcherLike, binding: string) {
	const base = `http://swe/__swe/wf/${encodeURIComponent(binding)}`;
	return {
		async create(opts?: unknown) {
			const { id } = await postJson<{ id: string }>(bridge, `${base}/create`, opts ?? {});
			return makeFakeInstance(bridge, binding, id);
		},
		async createBatch(batch: unknown[]) {
			const ids = await postJson<{ id: string }[]>(bridge, `${base}/createBatch`, batch);
			return ids.map(({ id }) => makeFakeInstance(bridge, binding, id));
		},
		async get(id: string) {
			await getOk(bridge, `${base}/get/${encodeURIComponent(id)}`);
			return makeFakeInstance(bridge, binding, id);
		}
	};
}

function makeFakeInstance(bridge: FetcherLike, binding: string, id: string) {
	const base = `http://swe/__swe/wf/${encodeURIComponent(binding)}/instance/${encodeURIComponent(id)}`;
	const post = async (method: string, body?: unknown) => {
		const res = await bridge.fetch(`${base}/${method}`, {
			method: 'POST',
			body: body === undefined ? undefined : JSON.stringify(body)
		});
		if (!res.ok) {
			throw new Error(`workflow ${method} failed: ${res.status} ${await res.text()}`);
		}
		const text = await res.text();
		return text ? (JSON.parse(text) as unknown) : undefined;
	};
	return {
		id,
		pause: () => post('pause').then(() => undefined),
		resume: () => post('resume').then(() => undefined),
		terminate: () => post('terminate').then(() => undefined),
		restart: () => post('restart').then(() => undefined),
		status: () => post('status'),
		sendEvent: (opts: { type: string; payload: unknown }) =>
			post('sendEvent', opts).then(() => undefined)
	};
}

// Pass URL string + init (not a pre-built Request): miniflare's internal undici
// won't accept a Request from a different realm — it stringifies it and tries
// to parse `[object Request]` as a URL.
async function postJson<T>(bridge: FetcherLike, url: string, body: unknown): Promise<T> {
	const res = await bridge.fetch(url, { method: 'POST', body: JSON.stringify(body) });
	if (!res.ok) {
		throw new Error(`bridge POST ${url} failed: ${res.status} ${await res.text()}`);
	}
	return (await res.json()) as T;
}

async function getOk(bridge: FetcherLike, url: string): Promise<void> {
	const res = await bridge.fetch(url);
	if (!res.ok) {
		throw new Error(`bridge GET ${url} failed: ${res.status} ${await res.text()}`);
	}
}
