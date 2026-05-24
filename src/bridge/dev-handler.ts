/**
 * Workerd-side bridge handler. Bundled into the dev sidecar by wrangler via
 * the cache wrapper at `node_modules/.cache/sveltekit-add-worker-exports/`.
 *
 * The wrapper imports `createBridgeFetch` from this file and uses it as the
 * default fetch handler. Routes `/__swe/wf/*` are handled here; anything else
 * delegates to the user's own default fetch handler.
 *
 * This file is part of the workflow-bridge fallback that exists because
 * `getPlatformProxy()` in unpatched wrangler/miniflare strips workflow
 * bindings. Once the upstream patch lands (cloudflare/workers-sdk#7459),
 * the entire `src/bridge/` directory can be deleted.
 */

interface FetcherWithSafeBindings {
	[binding: string]: WorkflowLike;
}

interface WorkflowLike {
	create(opts?: unknown): Promise<{ id: string }>;
	createBatch(batch: unknown[]): Promise<{ id: string }[]>;
	get(id: string): Promise<WorkflowInstanceLike>;
}

interface WorkflowInstanceLike {
	id: string;
	pause(): Promise<void>;
	resume(): Promise<void>;
	terminate(): Promise<void>;
	restart(): Promise<void>;
	status(): Promise<unknown>;
	sendEvent(opts: { type: string; payload: unknown }): Promise<void>;
}

// Local type alias so this file doesn't depend on @cloudflare/workers-types.
// Wrangler's bundler will swap in the real workerd types at runtime.
type CtxLike = { waitUntil(promise: Promise<unknown>): void };

type UserFetch = (
	request: Request,
	env: unknown,
	ctx: CtxLike
) => Promise<Response> | Response;

export interface BridgeOptions {
	workflowBindings: readonly string[];
	userFetch?: UserFetch;
}

/**
 * Returns a `fetch` handler that intercepts `/__swe/wf/*` and forwards
 * everything else to `userFetch`.
 */
export function createBridgeFetch(
	options: BridgeOptions
): (request: Request, env: unknown, ctx: CtxLike) => Promise<Response> {
	const bindings = new Set(options.workflowBindings);
	return async (request, env, ctx) => {
		const url = new URL(request.url);
		if (url.pathname.startsWith('/__swe/wf/')) {
			return handleWf(url.pathname.slice('/__swe/wf/'.length), request, env, bindings);
		}
		if (options.userFetch) {
			return options.userFetch(request, env, ctx);
		}
		return new Response('Not found', { status: 404 });
	};
}

async function handleWf(
	rest: string,
	request: Request,
	env: unknown,
	bindings: Set<string>
): Promise<Response> {
	const parts = rest.split('/').map(decodeURIComponent);
	const [binding, op, ...tail] = parts;
	if (!binding || !bindings.has(binding)) {
		return new Response('unknown workflow binding: ' + binding, { status: 404 });
	}
	const wf = (env as FetcherWithSafeBindings)[binding];
	if (!wf) {
		return new Response('binding ' + binding + ' missing on sidecar', { status: 500 });
	}
	try {
		if (op === 'create' && request.method === 'POST') {
			const opts = await request.json();
			const inst = await wf.create(opts);
			return Response.json({ id: inst.id });
		}
		if (op === 'createBatch' && request.method === 'POST') {
			const batch = (await request.json()) as unknown[];
			const insts = await wf.createBatch(batch);
			return Response.json(insts.map((i) => ({ id: i.id })));
		}
		if (op === 'get' && tail.length === 1) {
			const inst = await wf.get(tail[0]);
			return Response.json({ id: inst.id });
		}
		if (op === 'instance' && tail.length === 2) {
			const [id, method] = tail;
			const inst = await wf.get(id);
			switch (method) {
				case 'pause':
					await inst.pause();
					return new Response(null, { status: 204 });
				case 'resume':
					await inst.resume();
					return new Response(null, { status: 204 });
				case 'terminate':
					await inst.terminate();
					return new Response(null, { status: 204 });
				case 'restart':
					await inst.restart();
					return new Response(null, { status: 204 });
				case 'status':
					return Response.json(await inst.status());
				case 'sendEvent': {
					const body = (await request.json()) as { type: string; payload: unknown };
					await inst.sendEvent(body);
					return new Response(null, { status: 204 });
				}
			}
			return new Response('unknown method: ' + method, { status: 404 });
		}
		return new Response('unknown op: ' + op, { status: 404 });
	} catch (err: unknown) {
		const message = err instanceof Error ? err.message : String(err);
		return new Response('error: ' + message, { status: 500 });
	}
}
