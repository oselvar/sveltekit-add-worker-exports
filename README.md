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

Create a file that exports your Durable Object and/or Workflow classes:

```typescript
// src/lib/server/index.ts
export { MyDurableObject } from './MyDurableObject';

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // Route WebSocket upgrades to Durable Objects (used during dev)
    const url = new URL(request.url);
    const match = url.pathname.match(/^\/ws\/(.+)$/);
    if (match && request.headers.get('Upgrade') === 'websocket') {
      const id = env.MY_DO.idFromName(match[1]);
      return env.MY_DO.get(id).fetch(request);
    }
    return new Response('Not found', { status: 404 });
  }
};
```

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

## Why this exists

SvelteKit's adapter-cloudflare does not support named exports from the worker entry point ([sveltejs/kit#1712](https://github.com/sveltejs/kit/issues/1712)). Additionally, `getPlatformProxy` (used for local dev) cannot run internal Durable Objects because it uses an empty worker script.

## License

MIT
