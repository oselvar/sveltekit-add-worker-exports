# @oselvar/sveltekit-add-worker-exports

A Vite plugin that makes Durable Objects and Workflows work with SvelteKit on Cloudflare, in both dev and production.

**Build mode:** SvelteKit's `adapter-cloudflare` generates `_worker.js` with only a default export (the fetch handler). Cloudflare Workers requires Durable Object and Workflow classes to be **named exports**. This plugin post-processes the build output to merge your named exports with SvelteKit's default export.

**Dev mode:** `getPlatformProxy` (used by `adapter-cloudflare` in dev) can't run internal Durable Objects. This plugin starts a separate wrangler dev server that runs the real DO worker with hot-reload. Clients connect directly to it via WebSocket on a separate port.

## Install

```bash
pnpm add -D @oselvar/sveltekit-add-worker-exports
```

`esbuild`, `vite`, and `wrangler` are peer dependencies -- your SvelteKit project already has them.

## Usage

Create a worker entry point that exports your Durable Object classes and a default fetch handler. The fetch handler is only used by the wrangler dev server — in production, SvelteKit's route handlers handle all requests.

```typescript
// src/lib/server/index.ts
export { MyDurableObject } from './MyDurableObject';
export { default } from './devHandler';
```

Both the dev handler and the production SvelteKit route need to do the same thing: validate the upgrade header and forward the request to a Durable Object. Extract that into a small helper so the two callers stay in sync:

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

The dev handler parses the URL and delegates. It's only used by the wrangler dev sidecar:

```typescript
// src/lib/server/devHandler.ts
import { forwardWebSocket } from './forwardWebSocket';

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const match = new URL(request.url).pathname.match(/^\/ws\/(.+)$/);
    if (!match) return new Response('Not found', { status: 404 });
    return forwardWebSocket(request, env.MY_DO, match[1]);
  }
};
```

In production, the dev handler is *not* used — SvelteKit serves the same path through a `+server.ts` route, which delegates to the same helper:

```typescript
// src/routes/ws/[id]/+server.ts
import { forwardWebSocket } from '$lib/server/forwardWebSocket';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = ({ params, request, platform }) =>
  forwardWebSocket(request, platform!.env.MY_DO, params.id);
```

Now any change to the upgrade-and-forward logic (auth, rate-limiting, response shape) lives in one place and applies to both dev and production.

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

### Dev mode: connecting to Durable Objects

In dev mode, the plugin starts a wrangler dev server on a separate port and injects `__DEV_WORKER_PORT__` as a compile-time constant. Use it to connect your client:

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

The plugin auto-discovers your `wrangler.jsonc` (or `wrangler.toml`) and reads DO bindings, migrations, and compatibility settings from it. It overrides only the `main` entry point to use your source file instead of the SvelteKit build output.

### Testing the production build locally

`vite dev` exercises the dev handler via the wrangler-dev sidecar; it does *not* exercise your `+server.ts` route or the merged `_worker.js`. To verify the production wiring (named DO exports + SvelteKit routes in the same worker), run wrangler against the build output:

```bash
pnpm build              # produces .svelte-kit/cloudflare/_worker.js with merged exports
pnpm wrangler dev       # uses wrangler.jsonc → main: .svelte-kit/cloudflare/_worker.js
```

This serves the exact bundle that gets deployed, with local Durable Object storage. Connect a WebSocket client to `ws://localhost:8787/ws/<id>` and confirm you get a `101 Switching Protocols` response — that proves the request flowed through the SvelteKit `+server.ts` and into your DO.

A handy shortcut is to add a `preview` script to `package.json`:

```json
{
  "scripts": {
    "preview": "wrangler dev"
  }
}
```

> Note: `vite preview` is *not* suitable here — it only serves static assets and cannot run Durable Objects. Always use `wrangler dev` to preview the production worker.

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
3. Creates a new `_worker.js` that re-exports both:

```javascript
export { default } from './_sveltekit_worker.js';
export * from './_extra_exports.js';
```

The operation is idempotent -- if `_sveltekit_worker.js` already exists, the plugin skips.

### Dev mode

The plugin reads your wrangler config, creates a temporary config with `main` pointing to your `entryPoint`, and starts a wrangler dev server via `unstable_startWorker`. This gives you:

- Real workerd runtime (not emulated)
- Hot-reload when you change DO code
- Same WebSocket protocol as production
- Fully typed Durable Object bindings (see below)

### Generating typed bindings

The dev plugin creates a temporary `.dev-worker-wrangler.jsonc` with `main` pointing to your source entry point. You can use this to generate fully generic Cloudflare types:

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

SvelteKit's adapter-cloudflare does not support named exports from the worker entry point ([sveltejs/kit#1712](https://github.com/sveltejs/kit/issues/1712)). Additionally, `getPlatformProxy` (used for local dev) cannot run internal Durable Objects because it uses an empty worker script.

## License

MIT
