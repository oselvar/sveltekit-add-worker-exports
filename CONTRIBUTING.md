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

This runs `tsc` to produce `dist/index.js` (ESM) and `dist/index.d.ts` (type declarations).

### Testing locally

Link the package into a local SvelteKit project:

```bash
# In this repo
pnpm link --global

# In your test project
pnpm link --global @oselvar/sveltekit-add-worker-exports
```

Then rebuild after each change:

```bash
pnpm build
# Restart pnpm dev in the test project
```

## Architecture

The package exports a single function `addWorkerExports()` that returns two Vite plugins:

1. **Build plugin** (`add-worker-exports`, `apply: 'build'`): Runs in the `closeBundle` hook after SvelteKit's adapter generates `_worker.js`. Bundles the entry point with esbuild and creates a merged worker that re-exports both SvelteKit's default handler and the named DO/Workflow exports.

2. **Dev plugin** (`add-worker-exports-dev`, `apply: 'serve'`): Reads the project's wrangler config, creates a temporary copy with `main` overridden to the source entry point, and starts a wrangler dev server via `unstable_startWorker`. Injects `__DEV_WORKER_PORT__` as a compile-time constant.

### Dependencies

- `esbuild`, `vite`, and `wrangler` are **peer dependencies** (the consuming SvelteKit project provides them)
- `jsonc-parser` is a regular **dependency** (installed alongside the package)

## Releasing

We use [np](https://github.com/sindresorhus/np) for releases:

```bash
npx np
```

This handles version bumping, building (via `prepublishOnly`), publishing to npm, git tagging, and pushing.
