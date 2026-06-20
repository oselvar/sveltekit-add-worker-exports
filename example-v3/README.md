# example-v3

Same app as [`../example`](../example), but pinned to the **SvelteKit v3**
prerelease (`@sveltejs/kit@3.0.0-next.4` +
`@sveltejs/adapter-cloudflare@8.0.0-next.0`). It exists to exercise the plugin
against v3's build pipeline — see
[issue #5](https://github.com/oselvar/sveltekit-add-worker-exports/issues/5).

## What's different from `example/`

- **No `svelte.config.js`.** SvelteKit v3 no longer reads it; kit configuration
  is passed directly to the `sveltekit(...)` plugin in
  [`vite.config.ts`](vite.config.ts) (which is now async, hence the `await`).
- **Adapter runs in a later Vite hook.** v3 invokes the Cloudflare adapter from
  Vite's `buildApp` hook instead of `closeBundle`. The plugin handles both — see
  the repo README's "Build mode" section.

## Status

`npm run build`, `npm run dev`, and `npm run preview` all work and produce the
correct merged `_worker.js`.

`npm run check` currently reports type errors that come from the v3 **prerelease**
itself, not from this app or the plugin — `3.0.0-next.4` ships `$app/*` runtime
modules without their `types.d.ts`, so `$app/environment` (and the
`App.Platform` typing that flows from it) can't be resolved by `svelte-check`.
The identical code type-checks cleanly under SvelteKit v2 in `../example`. These
should resolve as the v3 release stabilizes.
