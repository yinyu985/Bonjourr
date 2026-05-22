# Bonjourr Development Guide

Bonjourr is a minimalist new tab browser extension (Chrome, Edge, Firefox, Safari) and web app. This fork is privacy-focused, built around browser-native bookmarks. No frontend framework — plain TypeScript, HTML, CSS bundled with esbuild.

## Workflow rules

1. **Deno only.** Never invoke `npm`, `pnpm`, `yarn`, or `node` directly. If a Deno task fails, stop and ask rather than reaching for npm. (`nodeModulesDir: "auto"` in `deno.json` lets Deno hydrate `node_modules/` itself for `npm:` imports.)
2. **No new dependencies.** Find a native solution before adding one. Allowed external imports are pinned in `deno.json` `imports`; the `no-external-import` lint rule enforces this.
3. **Prefer repetition over cleverness.** Repeat yourself rather than write difficult or unreadable code.
4. **Run `deno task check` after finishing changes** (format + lint + type check + tests). No need to run it between edits.

如果是一些简单的编辑任务，你可以让我的另外一个 agent 来执行。下面是一个样例，你可以这样调用它：

```bash
claude -p "你好" --dangerously-skip-permissions
```

## Common commands

```bash
deno task online           # dev server on :8000 (web build, watches src/)
deno task chrome           # dev build to release/chrome (also: edge, firefox, safari)
deno task build            # production build of all platforms into release/<platform>
deno task check            # fmt + lint + type-check + test (CI parity)
deno task test             # run all Deno tests (--allow-read --allow-env)
deno task types            # type-check src/ tasks/ tests/
deno task translate        # regenerate _locales after adding translation keys
deno task archive          # produce bonjourr-<platform>.zip via Docker (release artifacts)
```

Run a single test file: `deno test --allow-read --allow-env tests/init.test.ts`. Filter by name: add `--filter "<substring>"`.

CI (`.github/workflows/ci.yml`) runs `deno task build`, `deno task test`, `deno check`, and `deno lint` independently — passing `deno task check` locally covers all four.

## Architecture

### Build pipeline (`tasks/build.ts`)

A single esbuild-driven script builds five platforms (`chrome`, `edge`, `firefox`, `safari`, `online`) from the same source. Each output goes to `release/<platform>/`. Per-platform variation is handled by:

- **HTML token replacement.** `src/index.html` contains comment markers (`<!-- default icon -->`, `<!-- webext-storage -->`, `<!-- settings -->`, `<!-- help-mode -->`); the build replaces them differently per platform. `settings.html` and `help-mode.html` are inlined into `index.html` at build time.
- **Manifest selection.** `src/manifests/<platform>.json` → `release/<platform>/manifest.json`. The web build instead emits `manifest.webmanifest` + a `service-worker.js` with `__VERSION__` substituted from `src/scripts/version.ts`.
- **Bundle entry points.** Scripts: `src/scripts/index.ts` → `main.js`. Styles: `src/styles/style.css` → `style.css`. The `online` platform is minified; extension builds keep readable output. `define.ENV` is set to `"DEV"` / `"PROD"` so runtime can branch.
- **Watch mode.** `dev` builds invoke `watcher()`, which re-runs the relevant sub-task (html / styles / scripts / assets / manifests / locales) on file changes.

### Runtime entry (`src/scripts/index.ts`)

Boot sequence is fixed and order-sensitive:

1. `restoreBackgroundCache()` paints the cached background from `localStorage` synchronously to avoid a flash.
2. `storage.init()` resolves both `sync` (user settings) and `local` (caches/state) state. If absent, defaults from `defaults.ts` are cloned.
3. Each feature's entry function is invoked once with `(sync, local?)` — see the `startup()` body for the order. `synchronization(local)` runs last, kicking off the Gist auto-fetch (throttled by `gistLastFetchedAt`).

> There is **no** version-migration step. The fork is single-user; old victrme schemas aren't supported. `compatibility/apply.ts` only does `mergeImportedConfig` (used when restoring a backup or pasting JSON in settings) and strips a few hardcoded deprecated fields. If you need to evolve the `Sync` shape, edit `defaults.ts` and `types/sync.ts` directly and update tests.

### Storage abstraction (`src/scripts/storage.ts`)

Two backends behind one API: `webext-local` (uses `chrome.storage.local` even for the "sync" namespace — the extension stores sync data under a `syncStorage` key inside local storage) and `localstorage` (web build, JSON-encoded under `localStorage.bonjourr`). The type is selected at startup based on `globalThis.chrome?.storage`. All feature code reads/writes through `storage.sync.*` / `storage.local.*` and never touches the platform APIs directly. `storage.init()` also handles a wait-for-`webextstorage`-event handshake when the extension's `services/webext-storage.js` content script populates `globalThis.startupStorage` before the bundle loads.

### Feature module pattern

Every feature in `src/scripts/features/` exports one entry function that switches on its argument shape:

```ts
export function feature(init?: FeatureSync, update?: FeatureUpdate): void {
  if (update) { /* live update from settings */ return }
  if (init)   { /* initial render on startup */ }
}
```

`settings.ts` wires HTML inputs to features by calling `feature(undefined, { property: value })` — passing `undefined` as the first arg signifies a live update. Settings UI never manipulates feature DOM directly. State is persisted via `eventDebounce({ feature })` for high-frequency inputs (sliders) to limit storage writes. Full convention table is in `docs/TECHNICAL.md` § 6.

### Type contracts (`src/types/`)

`sync.ts` (synced user settings, the `Sync` type), `local.ts` (browser-local caches incl. backgrounds, the `Local` type), `shared.ts` (cross-cutting types like `Langs`, `Navigator`). Adding a new feature setting almost always means updating `Sync` in `sync.ts` and the corresponding default in `defaults.ts` `SYNC_DEFAULT`.

### Compatibility (`src/scripts/compatibility/apply.ts`)

Only `mergeImportedConfig(current, target)` and `removeDeprecatedFields(data)` live here. Used by the import-JSON / restore-backup paths, not by startup. No per-version migration table — the fork doesn't carry that baggage.

### Styles (`src/styles/`)

`style.css` is the manifest; it imports `_global.css` first, feature/component files in the middle, `_responsive.css` last. Theming is done via `[data-theme='light'|'dark']` selectors on `<html>` toggling CSS custom properties. Don't introduce `!important` or deep selector chains — see `docs/TECHNICAL.md` § 7 for the full styling convention.

### i18n (`_locales/`)

Each locale has `translations.json` (in-app strings) and `messages.json` (extension manifest strings, web build skips this). `traduction(node, lang)` translates a DOM subtree at startup; `tradThis(string)` translates literals at runtime. After adding new keys, run `deno task translate` to propagate them across locale files.

## Conventions

- **Imports must include the `.ts` extension** (Deno requirement). External deps must use the `npm:` / `jsr:` prefixes already declared in `deno.json` `imports`.
- **Filenames are `kebab-case` or lowercase**; entry-point function names are `camelCase` matching the feature.
- **Constants are `UPPER_SNAKE_CASE`** (e.g. `SYNC_DEFAULT`, `CURRENT_VERSION`).
- **Lint includes `explicit-function-return-type` and `verbatim-module-syntax`** — annotate return types on exported functions, and use `import type` for type-only imports.
- **DOM state via `dataset` and CSS variables**, not stateful JS objects: e.g. `document.documentElement.dataset.theme = 'dark'`, `style.setProperty('--feature-width', ...)`.

## Reference docs

- `docs/TECHNICAL.md` — extended conventions for build, feature pattern, settings wiring, CSS architecture.
- `tests/README.md` — manual QA checklist run before releases (automated tests don't cover UI flows).
- `CHANGELOG.md` — release history; tagging `v*` triggers `.github/workflows/release.yml` to publish zip archives.
