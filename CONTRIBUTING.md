# Contributing

## Prerequisites

- [Node.js](https://nodejs.org/) >= 18
- [pnpm](https://pnpm.io/)

## Setup

```bash
git clone https://github.com/oselvar/sveltekit-add-worker-exports.git
cd sveltekit-add-worker-exports
pnpm install
```

## Development

### Build

```bash
pnpm build
```

This runs [tsup](https://tsup.egoist.dev/) to produce:
- `dist/index.js` (ESM)
- `dist/index.cjs` (CJS)
- `dist/index.d.ts` / `dist/index.d.cts` (type declarations)

### Testing locally

To test against a local SvelteKit project, import from the dist output:

```typescript
// vite.config.ts in your test project
import { addWorkerExports } from '../sveltekit-add-worker-exports/dist/index.js';
```

Run `pnpm build` in this repo after every change, then restart `pnpm dev` in the test project.

## Architecture

The package exports a single function `addWorkerExports()` that returns two Vite plugins:

1. **Build plugin** (`add-worker-exports`, `apply: 'build'`): Runs in the `closeBundle` hook after SvelteKit's adapter generates `_worker.js`. Bundles the entry point with esbuild and creates a merged worker that re-exports both SvelteKit's default handler and the named DO/Workflow exports.

2. **Dev plugin** (`add-worker-exports-dev`, `apply: 'serve'`): Reads the project's wrangler config, creates a temporary copy with `main` overridden to the source entry point, and starts a wrangler dev server via `unstable_startWorker`. Injects `__DEV_WORKER_PORT__` as a compile-time constant.

### Dependencies

- `esbuild`, `vite`, and `wrangler` are **peer dependencies** (the consuming SvelteKit project provides them)
- `jsonc-parser` is bundled into the dist (via tsup `noExternal`) so it works without being installed in the consuming project

## Releasing

1. Update the version in `package.json`
2. Build: `pnpm build`
3. Commit: `git commit -am "vX.Y.Z"`
4. Tag: `git tag vX.Y.Z`
5. Publish: `pnpm publish --access public`
6. Push: `git push && git push --tags`
