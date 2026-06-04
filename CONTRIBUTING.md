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

## Commit messages

This repository follows [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/). The commit type determines the next version bump and the section the change appears under in `CHANGELOG.md`:

| Type | Bump | Changelog section |
|------|------|-------------------|
| `feat:` | minor | Features |
| `fix:` | patch | Bug Fixes |
| `perf:` | patch | Performance |
| `refactor:` / `docs:` / `chore:` / `test:` / `build:` / `ci:` / `style:` | none | hidden by default |
| `feat!:` / `fix!:` / footer `BREAKING CHANGE:` | major | Breaking Changes |

Scope is optional (`feat(dev): ...`). Use the imperative mood in the subject.

## Releasing

We use [release-it](https://github.com/release-it/release-it) with the [`@release-it/conventional-changelog`](https://github.com/release-it/conventional-changelog) plugin. It determines the version bump from the commits since the last tag, prepends a new entry to `CHANGELOG.md`, runs `pnpm build`, publishes to npm, tags, pushes, and creates a GitHub release with the same notes:

```bash
GITHUB_TOKEN=$(gh auth token) pnpm release
```

`GITHUB_TOKEN` is required for the GitHub release step. `gh auth token` reuses your `gh` CLI login; set it via your shell profile or alias if you don't want to type it every time.

Dry-run first to preview the bump and changelog entry without touching anything:

```bash
pnpm release --dry-run
```

Force a specific bump if needed: `pnpm release patch`, `pnpm release minor`, `pnpm release major`.
