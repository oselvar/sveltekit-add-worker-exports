# @oselvar/sveltekit-add-worker-exports

A Vite plugin that makes any class-based Cloudflare Worker export (Durable Objects, Workflows, `WorkerEntrypoint` RPC, voice agents, …) and any non-fetch handler (`scheduled`, `queue`, `email`, `tail`, `trace`) work with SvelteKit on Cloudflare, in both dev and production.

**Build mode:** SvelteKit's `adapter-cloudflare` generates `_worker.js` with only a default export (the fetch handler). Cloudflare Workers requires class-based bindings (Durable Objects, Workflows, `WorkerEntrypoint`, etc.) to be **named exports**, and non-fetch handlers (`scheduled`, `queue`, `email`, …) to be **methods on the default export**. This plugin post-processes the build output to merge both kinds onto SvelteKit's worker.

**Dev mode:** `getPlatformProxy` (used by `adapter-cloudflare` in dev) can't run internal Durable Objects, Workflows, or other class-based bindings. This plugin starts a separate wrangler dev server that runs the real worker with hot-reload. SvelteKit `+server.ts` handlers call bindings through `platform.env.MY_BINDING.<rpc>()` as usual — the plugin rewrites those bindings to point at the sidecar via wrangler's dev registry, so cross-worker calls Just Work. WebSocket clients in dev connect to the sidecar directly on a separate port — see [WebSockets](#websockets) below. The sidecar also exposes `/__scheduled` so `scheduled` handlers can be fired manually in dev — see [Scheduled, queue, email, tail handlers](#scheduled-queue-email-tail-handlers).

## What this works with

The plugin is binding-agnostic: if Cloudflare resolves it through a named class export plus a `wrangler.jsonc` binding, or through a method on the default export, the plugin handles it. Confirmed working:

- Durable Objects
- Workflows (`WorkflowEntrypoint`)
- Voice agents
- `scheduled` (cron triggers) — see [Scheduled, queue, email, tail handlers](#scheduled-queue-email-tail-handlers)

It should also work with `WorkerEntrypoint` RPC and any future class-based export that follows the same export-plus-binding pattern, as well as `queue`, `email`, `tail`, and `trace` — anything Cloudflare invokes as a method on the worker's default export. The examples below use Durable Objects and Workflows because they're the most common, but the wiring is the same for any class-based entrypoint — export the class from your entry point, declare the binding in `wrangler.jsonc`, and call it via `platform.env.MY_BINDING` in your routes.

## Install

```bash
pnpm add -D @oselvar/sveltekit-add-worker-exports
```

`esbuild`, `vite`, and `wrangler` are peer dependencies -- your SvelteKit project already has them.

## Usage

Create a worker entry point that exports your class-based bindings:

```typescript
// src/lib/server/index.ts
export { MyDurableObject } from './MyDurableObject';
export { MyWorkflow } from './MyWorkflow';
```

Workflow classes (extending `WorkflowEntrypoint`) are exported the same way as Durable Objects — the plugin merges them into `_worker.js` as named exports. Declare them in `wrangler.jsonc` under `workflows`, and they become available as bindings (e.g. `env.MY_WORKFLOW.create({ params })`) in both dev and production.

If clients need to talk directly to the dev sidecar over HTTP (e.g. WebSockets), also export a default fetch handler — see [WebSockets](#websockets) below.

Add the plugin to your `vite.config.ts` **after** `sveltekit()`:

```typescript
import { sveltekit } from '@sveltejs/kit/vite';
import { addWorkerExports } from '@oselvar/sveltekit-add-worker-exports';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [
    sveltekit(),
    addWorkerExports({ entryPoint: 'src/lib/server/index.ts' })
  ]
});
```

Point `adapter-cloudflare`'s platform proxy at the generated `.platform-proxy-wrangler.jsonc`. The plugin writes this file with internal Durable Object and Workflow bindings rewritten to cross-worker form (each gets a `script_name` pointing at the sidecar), so `platform.env.MY_DO` and `platform.env.MY_WORKFLOW` calls in `+server.ts` reach the sidecar via the wrangler dev registry. Without this config path, `getPlatformProxy` would try to run the DO/Workflow classes itself and warn that it can't:

```javascript
// svelte.config.js
import adapter from '@sveltejs/adapter-cloudflare';

export default {
  kit: {
    adapter: adapter({
      platformProxy: {
        configPath: '.platform-proxy-wrangler.jsonc'
      }
    })
  }
};
```

The plugin auto-discovers your `wrangler.jsonc` (or `wrangler.toml`) and reads bindings, workflows, migrations, and compatibility settings from it. It overrides only the `main` entry point to point at your source entry.

### Calling Workflows

`+server.ts` calls workflows the same way in dev and production:

```typescript
export const POST: RequestHandler = async ({ params, request, platform }) => {
  const userMessage = await request.text();
  const instance = await platform!.env.MY_WORKFLOW.create({
    params: { ... }
  });
  return new Response(instance.id);
};
```

The sidecar runs the real `WorkflowEntrypoint` class; calls reach it via the `script_name` rewrite in the platform-proxy config. This requires `wrangler >= 4.98.0` ([cloudflare/workers-sdk#13863](https://github.com/cloudflare/workers-sdk/pull/13863)).

### Testing the production build locally

`vite dev` exercises your code via the wrangler-dev sidecar; it does *not* exercise the merged `_worker.js`. To verify the production wiring (named class exports + SvelteKit routes in the same worker), run wrangler against the build output:

```bash
pnpm build              # produces .svelte-kit/cloudflare/_worker.js with merged exports
pnpm wrangler dev       # uses wrangler.jsonc → main: .svelte-kit/cloudflare/_worker.js
```

This serves the exact bundle that gets deployed, with local Durable Object storage. Exercise whichever route calls your binding (HTTP, WebSocket, whatever your app uses) and confirm the response — that proves the request flowed through the SvelteKit `+server.ts` and into your class.

A handy shortcut is to add a `preview` script to `package.json`:

```json
{
  "scripts": {
    "preview": "wrangler dev"
  }
}
```

> Note: `vite preview` is *not* suitable here — it only serves static assets and cannot run Durable Objects. Always use `wrangler dev` to preview the production worker.

## Scheduled, queue, email, tail handlers

Cloudflare invokes non-fetch handlers (`scheduled`, `queue`, `email`, `tail`, `trace`) as methods on the worker's default export, not as named exports. Put them on the `default` export of your entry point and the plugin merges them onto the production worker's default alongside SvelteKit's fetch handler:

```typescript
// src/lib/server/index.ts
export { MyDurableObject } from './MyDurableObject';
export default {
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    // runs from the cron triggers in wrangler.jsonc
  }
};
```

If you also need a dev-only `fetch` (e.g. for WebSocket upgrades), put it on the same default — the plugin keeps the non-`fetch` handlers and drops `fetch` in production. See [WebSockets](#websockets) below for the full shape.

### Firing scheduled in dev

Wrangler dev never auto-fires crons — `triggers.crons` in `wrangler.jsonc` is only honored on the real Cloudflare edge. The plugin enables `testScheduled` on the sidecar so you can invoke the handler manually:

```bash
curl 'http://localhost:8787/__scheduled?cron=*+*+*+*+*'
```

The `cron` query parameter (URL-encoded — `+` instead of spaces) is what gets passed to your handler as `event.cron`. Stdout from the sidecar lands in the vite terminal.

## WebSockets

`vite dev` doesn't proxy WebSocket upgrades to the wrangler-dev sidecar, so in dev mode the browser needs to connect to the sidecar directly. The plugin exposes the sidecar's port as a compile-time constant `__DEV_WORKER_PORT__` for exactly this.

The pattern: one helper handles the upgrade-and-forward, called from both the dev sidecar's fetch handler and the production `+server.ts` route, so both code paths stay in sync.

```typescript
// src/lib/server/forwardWebSocket.ts
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
```

Put a `fetch` on the entry's default export so the dev sidecar can receive the direct connection:

```typescript
// src/lib/server/index.ts
import { forwardWebSocket } from './forwardWebSocket';

export { MyDurableObject } from './MyDurableObject';
export { MyWorkflow } from './MyWorkflow';

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const match = new URL(request.url).pathname.match(/^\/ws\/(.+)$/);
    if (!match) return new Response('Not found', { status: 404 });
    return forwardWebSocket(request, env.MY_DO, match[1]);
  }
};
```

In production this `fetch` is dropped (SvelteKit owns request handling — the plugin's merge strips it). The same path is served through a `+server.ts` route that delegates to the same helper:

```typescript
// src/routes/ws/[id]/+server.ts
import { forwardWebSocket } from '$lib/server/forwardWebSocket';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = ({ params, request, platform }) =>
  forwardWebSocket(request, platform!.env.MY_DO, params.id);
```

Any change to the upgrade-and-forward logic (auth, rate-limiting, response shape) now lives in one place and applies to both dev and production.

### Connecting from the client

Use `__DEV_WORKER_PORT__` to pick between the sidecar (dev) and the SvelteKit route (production):

```typescript
import { dev } from '$app/environment';

let wsUrl: string;
if (dev) {
  wsUrl = `ws://${window.location.hostname}:${__DEV_WORKER_PORT__}/ws/${id}`;
} else {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  wsUrl = `${protocol}//${window.location.host}/ws/${id}`;
}
const ws = new WebSocket(wsUrl);
```

Add the type declaration to your `src/app.d.ts`:

```typescript
declare global {
  const __DEV_WORKER_PORT__: number;
}
```

## Options

| Option | Type | Required | Default | Description |
|--------|------|----------|---------|-------------|
| `entryPoint` | `string` | Yes | -- | Path to the file that exports your DO/Workflow classes |
| `outputDir` | `string` | No | `.svelte-kit/cloudflare` | Directory containing the SvelteKit-generated `_worker.js` |
| `wranglerConfig` | `string` | No | auto-discovered | Path to wrangler config file |
| `devPort` | `number` | No | `8787` | Port for the dev worker server |

## How it works

### Build mode

The plugin runs in the `closeBundle` hook (after SvelteKit's adapter has generated `_worker.js`):

1. Bundles your `entryPoint` with esbuild into `_extra_exports.js`
2. Renames the original `_worker.js` to `_sveltekit_worker.js`
3. Creates a new `_worker.js` that re-exports the named exports and merges the entry's `default` handlers (`scheduled`, `queue`, `email`, …) onto the SvelteKit default:

```javascript
import sveltekitWorker from './_sveltekit_worker.js';
import * as extra from './_extra_exports.js';
export * from './_extra_exports.js';
const { fetch: _ignored, ...extraHandlers } = extra.default ?? {};
export default { ...sveltekitWorker, ...extraHandlers };
```

The operation is idempotent -- if `_sveltekit_worker.js` already exists, the plugin skips.

### Dev mode

The plugin reads your wrangler config, creates a temporary config with `main` pointing to your `entryPoint`, and starts a wrangler dev server via `unstable_startWorker`. This gives you:

- Real workerd runtime (not emulated)
- Hot-reload when you change DO code
- Same WebSocket protocol as production
- Fully typed Durable Object bindings (see below)

### Generating typed bindings

The dev plugin creates a temporary `.dev-worker-wrangler.jsonc` with `main` pointing to your source entry point. Use it to generate fully generic Cloudflare types:

```bash
wrangler types --config .dev-worker-wrangler.jsonc
```

This produces typed DO bindings like `DurableObjectNamespace<MyDurableObject>` instead of the untyped `DurableObjectNamespace` you get from the default `wrangler.jsonc` (whose `main` points to the SvelteKit build output, which doesn't exist during dev).

Add this to your `package.json` scripts for convenience:

```json
{
  "scripts": {
    "types": "wrangler types --config .dev-worker-wrangler.jsonc"
  }
}
```

Note: the `.dev-worker-wrangler.jsonc` file is generated when the dev server starts. Run `pnpm dev` at least once before running `wrangler types`.

## Why this exists

SvelteKit's adapter-cloudflare does not support named exports from the worker entry point ([sveltejs/kit#1712](https://github.com/sveltejs/kit/issues/1712)) — which blocks every class-based Cloudflare binding, not just Durable Objects. Additionally, `getPlatformProxy` (used for local dev) cannot run internal class-based bindings because it uses an empty worker script.

## When this plugin can be retired

This plugin is a stopgap. The single blocker for retirement is [sveltejs/kit#15627](https://github.com/sveltejs/kit/pull/15627) — which replaces `adapter-cloudflare`'s custom build with `@cloudflare/vite-plugin`. Open as of writing. Closes [#1712](https://github.com/sveltejs/kit/issues/1712), [#10496](https://github.com/sveltejs/kit/issues/10496), [#13692](https://github.com/sveltejs/kit/issues/13692), [#2963](https://github.com/sveltejs/kit/issues/2963), [#13300](https://github.com/sveltejs/kit/issues/13300), [#1519](https://github.com/sveltejs/kit/issues/1519).

Once that PR lands, `@cloudflare/vite-plugin` handles everything this plugin does, natively:

- **Build:** the plugin bundles a single worker entry that exports `default` + named classes directly — no `_worker.js` post-processing, no second esbuild pass to merge exports.
- **Dev:** Durable Objects and Workflows run in the same worker as SvelteKit on real workerd, hot-reloaded — no sidecar via `unstable_startWorker`, no platform-proxy `script_name` rewrite, no separate WebSocket port, no dev registry routing.
- **Types:** `wrangler types` resolves typed bindings (`DurableObjectNamespace<MyDO>`) from the user entry, no `.dev-worker-wrangler.jsonc` indirection.

Side note: [cloudflare/workers-sdk#14013](https://github.com/cloudflare/workers-sdk/pull/14013) introduces an experimental `cloudflare.config.ts` flow (typed `exports` API) where the Durable Object branch currently throws `"Durable Object exports are not currently supported."` (see [`convert.ts`](https://github.com/cloudflare/workers-sdk/blob/main/packages/config/src/convert.ts)) and Workflows are commented out. This is a separate, opt-in config surface — the standard `wrangler.jsonc` path that kit#15627 uses already supports DO and Workflow named exports, so this limitation does **not** gate retirement.

## License

MIT
