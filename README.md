# @oselvar/sveltekit-add-worker-exports

A Vite plugin that adds named exports (Durable Objects, Workflows) to SvelteKit Cloudflare workers.

SvelteKit's `adapter-cloudflare` generates `_worker.js` with only a default export (the fetch handler). Cloudflare Workers requires Durable Object and Workflow classes to be **named exports** from the worker entry point. This plugin bridges the gap by post-processing the build output to merge your named exports with SvelteKit's default export.

## Install

```bash
pnpm add -D @oselvar/sveltekit-add-worker-exports
```

`esbuild` and `vite` are peer dependencies -- your SvelteKit project already has them.

## Usage

Create a file that exports your Durable Object and/or Workflow classes:

```typescript
// src/lib/server/index.ts
export { MyDurableObject } from './MyDurableObject';
export { MyWorkflow } from './MyWorkflow';

// A default export is required by Cloudflare but won't be used (SvelteKit handles fetch)
export default {
  fetch(): Response {
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

That's it. When you run `vite build`, the plugin will bundle your exports and merge them into the generated `_worker.js`.

## Options

| Option       | Type     | Required | Default                  | Description                                                          |
| ------------ | -------- | -------- | ------------------------ | -------------------------------------------------------------------- |
| `entryPoint` | `string` | Yes      | --                       | Path to the file that exports your Durable Object / Workflow classes |
| `outputDir`  | `string` | No       | `.svelte-kit/cloudflare` | Directory containing the SvelteKit-generated `_worker.js`            |

## How it works

The plugin runs in the `closeBundle` hook (after SvelteKit's adapter has generated `_worker.js`):

1. Bundles your `entryPoint` with esbuild into `_extra_exports.js`
2. Renames the original `_worker.js` to `_sveltekit_worker.js`
3. Creates a new `_worker.js` that re-exports both:

```javascript
export { default } from './_sveltekit_worker.js';
export * from './_extra_exports.js';
```

The operation is idempotent -- if `_sveltekit_worker.js` already exists, the plugin skips. It also skips during the SSR build phase (before the adapter runs).

## Why this exists

SvelteKit's adapter-cloudflare does not support named exports from the worker entry point. See [sveltejs/kit#1712](https://github.com/sveltejs/kit/issues/1712) for the upstream discussion.

## License

MIT
