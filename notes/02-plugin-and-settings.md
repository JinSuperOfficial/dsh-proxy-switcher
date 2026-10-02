# DSH plugin architecture & adding a Settings page

Investigation report for an engineer writing a **new third-party DSH plugin that adds a settings page to the DSH Web GUI**.

Sources read:
- Source checkout: `F:\@Project\DeepSeekHarnes\deepseek-harness` (root `package.json` version **`0.1.0-rc.7`**)
- Live profile: `C:\Users\30394\.dsh\profiles\desktop` (real third-party plugins installed)
- The in-box packages the *live* GUI actually runs: `C:\Users\30394\.dsh\profiles\node_modules\@deepseek-ai\*` (**`0.2.0-rc.2`**) — resolved through the "healed flat fallback" described below.
- `C:\Users\30394\AppData\Local\Programs\DeepSeek Harness\resources\app.asar` → `dsh/node_modules/@deepseek-ai/{dsh-plugin-manager,dsh-config-editor}` (extracted read-only; these two packages exist **only** in the running 0.2.0-rc.2, not in the checkout).

---

## Summary

1. **A DSH plugin is a plain npm package with two independent halves.** The Node half is ordinary ESM loaded by the Cordis Loader. The browser half is an *optional* second entry, declared by `dsh.client` in `package.json`, exported at `exports["./client"]`, and served by `ctx.clientModules` at `/plugins/<id>/client.js`.

2. **A plugin package can be a *bundle*** — an npm package that also ships a `cordis.patch.yml` layer declaring `dsh.bundle.patch`. That is the *only* thing that makes `dsh plugin add <pkg>` mount it: the CLI appends the package name to the profile's `dsh.profile.bundles`, and app boot folds every bundle's patch over an empty entry list in list order. No hand-editing of `cordis.yml` is needed.

3. **No bundler is required.** `dsh-hot-reload` is the shipped proof: a 213-line hand-written `lib/client.js` classic script with zero build step. The browser half must be a *classic script* that calls `window.__ModuleLoader__.load({ id, factory })`; `factory` is **synchronous CJS** (`factory(require) => exports`), **not** ESM, and may `require` only the platform seed words (`react`, `react/jsx-runtime`, `react-dom`, `react-dom/client`, `@deepseek-ai/cordis`, `@deepseek-ai/dsh-client-{ui-slots,web-react,ui-primitives,ui-attachment,schema-form}`).

4. **The Settings page API is the slot system.** A plugin contributes a page with `ctx.slots.inject('settings.section', () => ctx.slots.register({ name:'settings.section', id, order, label }, Component))`. The component receives the composed props share; `settings.section` is a `list`/`root` slot whose only owner prop is `{ close: () => void }`. No import of the shell is needed — the slot is declared by `ui-settings-general`, and `inject` waits for the declaration.

5. **Cross-plugin value imports are forbidden** — enforced at build time by the client bundle purity gate and at runtime by the module table. Collaboration goes through (a) the slot system, (b) cordis services injected by *name*, or (c) an ordinary HTTP route you register on `ctx.webServer` and `fetch()` from the browser.

6. **A third-party plugin cannot add a new `@Remote`/Typert namespace.** `ctx.remote.<ns>` only exposes namespaces from `/remote` artifacts generated at *build time* by `dsh-typert-generator` and explicitly mounted by the in-box `api-remotes` client assembly. The practical alternatives are `ctx.webServer.register(...)` + `fetch`, or reusing an already-mounted `connection.api.*` face.

7. **Two persistence paths exist for a third-party plugin:**
   - `ctx.settings` (host) + `ctx.settingsScope` (client) — the *user-editable* layered document, rendered by the Plugins config tab. Available in both 0.1.0-rc.7 and 0.2.0-rc.2.
   - `ctx.configEditor` (0.2.0-rc.2 only) — persists the plugin's **complete raw Loader entry `config`** into the active profile's `cordis.patch.yml` and re-applies it through the Loader. `ctx.configEditor.edit(entry, change)` is usable by a third-party plugin, but only for a *uniquely-addressed* entry owned by the profile's root Include.

8. **Version skew is real and load-bearing.** The checkout is `0.1.0-rc.7`; the running desktop GUI is `0.2.0-rc.2`. In `0.1.0-rc.7`'s `ui-settings-plugins` the keyed slot `settings.plugin.item` exists; in the running `0.2.0-rc.2` bundle it does **not** (only `settings.section`, `settings.general.item`, `settings.plugins.tab` exist). Target `settings.section`.

---

## 1. Plugin package format

### 1.1 Two roles under the `dsh` key

`docs/user/develop/basic/publish.md:11-16`:

> - A **bundle** is an npm package that ships a configuration layer. Its manifest declares `dsh.bundle`, answering "what does this package contribute?": a patch file that inserts or overrides plugin rows.
> - A **profile** is a directory under `$DSH_HOME/profiles/<name>` describing one runnable composition. Its manifest declares `dsh.profile`, answering "which bundles compose this setup, in what order?".

The type that app boot actually reads (`packages/boot/app-boot/src/profile.ts:41-70`):

```ts
/** The bundle half of the `dsh` manifest section: what a bundle package exports. */
export interface DshBundleManifest {
  /** The patch layer this bundle exports, relative to its package root. */
  patch: string
}

/** The profile half of the `dsh` manifest section: what a profile directory composes. */
export interface DshProfileManifest {
  /** Ordered bundle layer list (package names). */
  bundles?: string[]
}

export interface DshManifestSection {
  /** Bundle metadata consumed by the profile launcher. */
  bundle?: DshBundleManifest
  /** Profile metadata consumed by the profile launcher. */
  profile?: DshProfileManifest
}

/** The slice of package.json both profiles and bundles use. */
export interface ProfileManifest {
  name?: string
  dependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  dsh?: DshManifestSection
}
```

A third field — `dsh.client` — is owned by the client-module system, not by app boot. Its validated shape (`packages/client/modules/src/index.ts:46-52`):

```ts
/** package.json `dsh.client` declaration fields, validated one by one after reading the file. */
interface DshClientDeclaration {
  inject?: string[]
  platform: string
  /** Boot phase-one prefetch mark; absent means lazy (fetched on demand). */
  immediately?: boolean
}
```

### 1.2 The minimal third-party bundle (documented, copy-pasteable)

`docs/user/develop/basic/publish.md:26-62` — the whole authoring surface:

```
hello-plugin/
├── package.json       # declares dsh.bundle
├── cordis.patch.yml   # the layer applied when a profile lists this bundle
└── index.js           # plugin modules the patch rows reference
```

```json
{
  "name": "dsh-hello-plugin",
  "version": "0.1.0",
  "type": "module",
  "main": "index.js",
  "files": ["index.js", "cordis.patch.yml"],
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
}
```

```js
export const name = 'hello-plugin'

export function apply() {
  console.log('[hello-plugin] plugin loaded!')
}
```

```yaml
- insert:
    - id: hello
      name: dsh-hello-plugin
```

> A package without the `dsh.bundle` declaration still installs, but only as a plain dependency: `dsh plugin` prints a warning and activates no layer. (`publish.md:64`)

So for a **host-only** plugin the required fields are exactly: `name`, `version`, `type: "module"`, `main`, `files`, `dsh.bundle.patch`. `exports` and `peerDependencies` are **not** required by DSH itself — they are conventions the in-box packages follow because they are TypeScript libraries and because consumers resolve subpaths.

### 1.3 What real third-party packages declare

`dsh-hot-reload@0.2.4` — the smallest complete example: host half **and** browser half, no build step (`node_modules/dsh-hot-reload/package.json`):

```json
{
  "name": "dsh-hot-reload",
  "version": "0.2.4",
  "type": "module",
  "main": "lib/index.js",
  "exports": {
    ".": "./lib/index.js",
    "./client": "./lib/client.js",
    "./package.json": "./package.json"
  },
  "files": ["lib", "cordis.patch.yml", "README.md", "README-zh.md", "CHANGELOG.md", "LICENSE"],
  "dsh": {
    "bundle": {
      "patch": "./cordis.patch.yml"
    },
    "client": {
      "platform": "web"
    }
  },
  "dependencies": { "chokidar": "^4.0.0" }
}
```

Note: **no `peerDependencies` at all**, and no `@deepseek-ai/*` dependency. Its host half imports only `chokidar` + Node builtins, and reads cordis services off `ctx`.

`dshmarket@1.66.8` — the fullest example; TypeScript, tsdown-built, with explicit peers (`node_modules/dshmarket/package.json:38-117`):

```json
"dependencies": { "js-yaml": "^4.1.0", "undici": "^7.29.0" },
"peerDependencies": {
  "@deepseek-ai/cordis": "^4.0.1",
  "@deepseek-ai/dsh-settings": "^0.1.0-rc.7 || ^0.1.1-rc.2 || ^0.1.2-alpha.2 || ^0.2.0-rc.1",
  "@deepseek-ai/schemastery": "^3.18.1"
},
"dsh": {
  "bundle": { "patch": "./cordis.patch.yml" },
  "client": {
    "inject": [
      "@deepseek-ai/dsh-client-locale",
      "@deepseek-ai/dsh-client-ui-settings",
      "@deepseek-ai/dsh-client-ui-theme"
    ],
    "platform": "web"
  }
},
"exports": {
  ".": { "types": "./lib/types/index.d.ts", "default": "./lib/index.js" },
  "./update-api-v1": { "types": "./lib/types/update-api-v1.d.ts", "default": "./lib/update-api-v1.js" },
  "./client": "./client/client.js",
  "./cordis.patch.yml": "./cordis.patch.yml",
  "./package.json": "./package.json",
  "./locale/*.json": "./locale/*.json"
},
...
"peerDependenciesMeta": {
  "@deepseek-ai/dsh-settings": { "optional": true },
  "@deepseek-ai/schemastery": { "optional": true }
}
```

`dsh-better-sidebar@0.24.1` (`node_modules/dsh-better-sidebar/package.json:15-58`) adds a `manifestVersion` and several `/client/*` subpaths that all point at the same bundle:

```json
"exports": {
  ".": { "types": "./lib/types/index.d.ts", "default": "./lib/index.js" },
  "./invariant": { "types": "./lib/types/invariant.d.ts", "default": "./lib/invariant.js" },
  "./client": { "types": "./lib/types/client/index.d.ts", "default": "./lib/client.js" },
  "./client/service": { "types": "./lib/types/client/service.d.ts", "default": "./lib/client.js" },
  "./client/api": { "types": "./lib/types/client/service.d.ts", "default": "./lib/client.js" },
  "./src/*": "./src/*",
  "./package.json": "./package.json",
  "./locale/*.json": "./locale/*.json"
},
"dsh": {
  "bundle": { "patch": "./cordis.patch.yml" },
  "client": {
    "inject": [
      "@deepseek-ai/dsh-client-locale",
      "@deepseek-ai/dsh-client-ui-slots",
      "@deepseek-ai/dsh-client-ui-conversation",
      "@deepseek-ai/dsh-client-ui-sidebar-right",
      "@deepseek-ai/dsh-client-modules"
    ],
    "platform": "web"
  },
  "manifestVersion": 1
}
```

`dsh-claude-style@0.10.3` adds a `dsh.engines` gate (checked by the plugin manager) and an `icon` field:

```json
"main": "host/index.js",
"icon": "lib/claude-mark.svg",
"exports": {
  ".": "./host/index.js",
  "./client": "./lib/client.js",
  "./package.json": "./package.json",
  "./locale/*": "./locale/*"
},
"dsh": {
  "engines": { "dsh": ">=0.1.7" },
  "bundle": { "patch": "./cordis.patch.yml" },
  "client": { "inject": [], "platform": "web" }
}
```

`dsh-whale-widget@0.3.17` is host-only — **no `dsh.client`, no `./client` export**. It injects its browser code by hand instead (see §8.3):

```json
"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
```

### 1.4 In-repo package invariants (only if you build inside the monorepo)

`docs/cookbook/adding-a-package.md:25`:

> `private: true`, a `version` matching the root `package.json`, `type: module`, `main: "lib/index.js"`, `types: "lib/types/index.d.ts"`, `exports["."].types: "./lib/types/index.d.ts"`, `exports["."].default: "./lib/index.js"`, `@deepseek-ai/cordis` in BOTH peerDependencies and devDependencies (same range). Mirror every dsh peer dependency in devDependencies. `@deepseek-ai/schemastery` goes in `dependencies` (a runtime validator)…

and `:37`:

> A `packages/client/*` package additionally extends `tsconfig.base.client.json` instead of `tsconfig.base.json`, and a client plugin package declares `dsh.client` in package.json, exports `./client`, and calls the shared tsdown preset (`packages/client/tsdown.client.ts`).

### 1.5 Required Cordis exports (`name` / `Config` / `inject` / `apply` / `Service`)

The recognized plugin surface, from the tutorials and from real packages:

| Export | Meaning | Evidence |
|---|---|---|
| `name` | Cordis plugin name (diagnostics / HMR / loader patch targeting). | `docs/cordis-tutorial/07-into-the-harness.md:16` |
| `inject` | Array of required **service keys**; the fiber stays `PENDING` until every one exists. Non-service waits go through `ctx.inject([...], cb)`. | `07-into-the-harness.md:17`; `docs/cordis-tutorial/03-services.md:51-52` |
| `apply(ctx, config?)` | Plugin body; receives the resolved `Config`. | `docs/cordis-tutorial/05-config.md:15-27` |
| `Config` | Schemastery schema validating the entry's `config:` block. | `docs/cordis-tutorial/05-config.md:22` |
| `default` | A **class extending `Service`** may be the plugin itself: `ctx.plugin(SlotRegistry)`. | `packages/client/runtime/src/client/index.ts:189` |

A real host half with `Config` and a settings namespace (`packages/client/ui-settings-general/src/index.ts:1-27`):

```ts
/** Host loader entry for the browser implementation exported from `./client`. */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'

/** Durable settings namespace for product-wide GUI onboarding facts. */
const ONBOARDING_SETTINGS_NAMESPACE = 'ui-onboarding'

interface OnboardingSettings {
  /** Last version acknowledged by the current product welcome step. */
  welcomeNoticeVersion?: string
}

const OnboardingSettingsSchema: z<OnboardingSettings> = z.object({
  welcomeNoticeVersion: z.string(),
})

/** Register the durable GUI-onboarding section when a settings provider exists. */
export function apply(ctx: Context): void {
  ctx.inject(['settings'], (settingsCtx) => {
    settingsCtx.settings.register(
      settingsNamespace(ONBOARDING_SETTINGS_NAMESPACE),
      OnboardingSettingsSchema,
    )
  })
}
```

A client-only package still needs a node-half entry — it is a no-op (`packages/client/ui-settings-models/src/index.ts:1-4`):

```ts
/** Host loader entry for the browser implementation exported from `./client`. */

/** Host plugin body — no host-side behavior for the models settings plugin. */
export function apply(): void {}
```

**`reusable`:** searched `vendor/cordis/src/*.ts`, `vendor/cordis/lib/index.js`, `vendor/cordis/lib/types/*.d.ts` and the installed `@deepseek-ai/cordis@4.0.4` (checkout `vendor/cordis/package.json`, profile `node_modules/@deepseek-ai/cordis`) — **there is no `reusable` export anywhere in this codebase's Cordis.** It is not part of the plugin contract here. Do not rely on it.

---

## 2. Declaring both a host half and a client half

### 2.1 The `dsh.client` declaration + `./client` export

Two facts must both be true for a package's browser half to load:

1. `package.json` declares `dsh.client` with a string `platform` (and optional `inject` / `immediately`).
2. `exports["./client"]` resolves to a file (string form, or an object with a string `default`).

Validation (`packages/client/modules/src/index.ts:108-142`):

```ts
/** Narrow an unknown parsed JSON value to the `dsh.client` declaration, throwing on malformed fields. */
function parseDshClient(pkgName: string, value: unknown): DshClientDeclaration | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'object' || value === null) {
    throw new Error(`client-modules: ${pkgName} has a non-object dsh.client declaration`)
  }
  const decl = value as Record<string, unknown>
  if (typeof decl.platform !== 'string') {
    throw new Error(`client-modules: ${pkgName} dsh.client.platform must be a string`)
  }
  if (decl.inject !== undefined && (!Array.isArray(decl.inject) || decl.inject.some(i => typeof i !== 'string'))) {
    throw new Error(`client-modules: ${pkgName} dsh.client.inject must be a string array`)
  }
  if (decl.immediately !== undefined && typeof decl.immediately !== 'boolean') {
    throw new Error(`client-modules: ${pkgName} dsh.client.immediately must be a boolean`)
  }
  return {
    platform: decl.platform,
    ...(decl.inject !== undefined ? { inject: decl.inject as string[] } : {}),
    ...(decl.immediately !== undefined ? { immediately: decl.immediately } : {}),
  }
}

/** Resolve `exports["./client"]` to a relative path, accepting the string and one-level conditional forms. */
function clientExportOf(pkgName: string, exportsField: unknown): string | undefined {
  if (typeof exportsField !== 'object' || exportsField === null) return undefined
  const client = (exportsField as Record<string, unknown>)['./client']
  if (client === undefined) return undefined
  if (typeof client === 'string') return client
  if (typeof client === 'object' && client !== null) {
    const fallback = (client as Record<string, unknown>).default
    if (typeof fallback === 'string') return fallback
  }
  throw new Error(`client-modules: ${pkgName} exports["./client"] must be a string or an object with a string default`)
}
```

### 2.2 How the profile resolves them

`docs/subsystems/client-modules.md:49`:

> A package joins the table by declaring `dsh.client` (`platform: 'web'`, optional `inject` edges, optional `immediately`) in its package.json and exporting its built bundle at `exports["./client"]`. Package resolution anchors at the config tree's `ctx.baseUrl` — the cordis.yml directory, whose package declares every composed plugin as a dependency — and construction throws when that anchor is unset.

`docs/subsystems/client-modules.md:57`:

> `GET`/`HEAD /plugins/<id>/client.js` serves the registered bundle from disk with `no-cache` (the rev query, not HTTP caching, anchors consistency); other methods are 405. … The index tap injects the current graph on every index render, so a reload always boots against the live composition.

The wire types (`docs/subsystems/client-modules.md:13-43`):

```ts
interface WebBootEntry {
  /** Entry name == package name. */
  id: string
  /** Bundle endpoint, '/plugins/<id>/client.js?rev=<rev>'. */
  url: string
  /** Bundle content hash (cache-busting consistency anchor). */
  rev: string
  /** Package-name dependency edges, informational (preflight display / HMR diffing). */
  inject?: string[]
  /** Stage-one prefetch mark: load the script for factory registration during module-face boot. */
  immediately?: boolean
}

/** The composed client entry graph the host injects as `window.__DSH_BOOT__`. */
interface WebBootGraph {
  rev: string
  entries: WebBootEntry[]
}
```

The row is composed in `packages/client/modules/src/index.ts:150-158`:

```ts
/** Graph row for one bundle rev (url carries the rev as its cache-busting query). */
function graphRow(id: string, rev: string, injectEdges: string[] | undefined, immediately: boolean): WebBootEntry {
  return {
    id,
    url: `/plugins/${id}/client.js?rev=${rev}`,
    rev,
    ...(injectEdges !== undefined ? { inject: injectEdges } : {}),
    ...(immediately ? { immediately: true } : {}),
  }
}
```

and injected into `index.html` at `packages/client/modules/src/index.ts:168-175`:

```ts
export function injectBootManifest(html: string, graph: WebBootGraph): string {
  const json = JSON.stringify(graph).replaceAll('<', '\\u003c')
  const script = `<script>window.__DSH_BOOT__ = ${json}</script>`
  const head = html.indexOf('<head>')
  if (head !== -1) return `${html.slice(0, head + 6)}${script}${html.slice(head + 6)}`
  return `${script}${html}`
}
```

### 2.3 The `clientModules` service

`docs/subsystems/client-modules.md:73-117` (generated catalog, source `packages/client/modules/src/index.ts:184`):

```ts cordis-catalog
graph(): WebBootGraph
clientPath(id: string): string | undefined
rebuilt(id: string): string | undefined
onRebuilt(listener: (id: string, rev: string) => void): () => void
onGraphChanged(listener: () => void): () => void
```

Its static injections (`packages/client/modules/src/index.ts:184-185`):

```ts
export class ClientModuleRegistry extends Service {
  static inject = ['webServer', 'loader']
```

`docs/subsystems/client-modules.md:53` is the operational gotcha:

> Package metadata — including the negative "not a client package" verdict — is cached per name and never expires: **plugin-set changes take effect on restart.** A fiber restart reuses its row and rev untouched; bundle content changes reach the graph only through `rebuilt()`.

### 2.4 `dsh.client.inject` is **informational only**

`packages/client/AGENTS.md:96`:

> **dsh.client manifest semantics**: `platform: 'web'` always; `immediately: true` only for stage-one-prefetch infrastructure rows. `inject` lists package-name dependency edges — they are **informational only** (preflight display, HMR diffing); they do not sequence entry activation or apply order. Activation order is cordis fiber inject waiting on *services*, nothing else.

So: listing `@deepseek-ai/dsh-client-ui-settings` in `dsh.client.inject` does **not** make anything available to your bundle. What makes the slot system, locale, connection, etc. work is declaring the *service keys* in your client half's own `inject`: `['slots', 'locale', ...]`.

---

## 3. Plain JavaScript, no build step — and the required bundle format

**Yes, a plugin can be plain JavaScript with no bundler.** `dsh-hot-reload` proves it, and its source is written as a tutorial for exactly that (`node_modules/dsh-hot-reload/lib/client.js:1-23`):

```js
// dsh-hot-reload — web half: raise a transient banner when the host half
// reloads (or fails to reload) a plugin package.
//
// This file is hand-written in the shape a built client bundle takes, because
// the package deliberately has no build step: a classic script that REGISTERS a
// factory with the browser module loader, whose body runs at materialization
// rather than at script execution. Consequences for editing it:
//
//   - no JSX (React.createElement instead) and no import/export syntax — the
//     factory takes a synchronous `require` and RETURNS its exports;
//   - only the platform seed modules may be required, under their exact keys:
//     react, react/jsx-runtime, react-dom, react-dom/client,
//     @deepseek-ai/cordis, and the @deepseek-ai/dsh-client-{ui-slots,
//     web-react, ui-primitives, ui-attachment, schema-form} set. They come from
//     the web shell's own build, so this half needs no other plugin bundle;
//   - `id` must be the package name: the loader resolves "<id>/client" and the
//     bare id to these same exports.
//
// The host half only serves this to browsers (package.json's dsh.client pins
// platform "web"), and nothing here is required for reloading to work. Every
// failure path below degrades to "no banner" — but note the shell fails its
// boot if a plugin entry never activates, so a throw at factory scope would
// cost the page: that is why the requires are guarded rather than bare.
```

### 3.1 The exact handshake

`window.__ModuleLoader__.load({ id, factory })` — the registration sink (`packages/client/modules/src/client/system.ts:86-96`):

```ts
    const win = globalThis as DshWindow
    if (win.__ModuleLoader__ !== undefined) throw new Error('client-modules: window.__ModuleLoader__ already installed (double boot?)')
    win.__ModuleLoader__ = {
      load: (handoff: ClientPluginHandoff): void => {
        // Registration is keyed by the handoff id; a duplicate means a bundle
        // executed twice without an invalidate — always a bug, always loud.
        if (this.factories.has(handoff.id)) throw new Error(`client-modules: duplicate factory registration for "${handoff.id}" (bundle executed twice without invalidate?)`)
        this.factories.set(handoff.id, handoff.factory)
      },
    }
```

and the synchronous `require` answered to factories (`system.ts:142-156`):

```ts
  private makeRequire(edges: Set<string>): (spec: string) => unknown {
    return (spec: string): unknown => {
      edges.add(spec)
      if (this.seed.has(spec)) return this.seed.get(spec)
      if (this.statics.has(spec)) return this.statics.get(spec)
      const id = stripClientSuffix(spec)
      const record = this.loadCache.get(id)
      if (record !== undefined) return record.exports
      if (this.factories.has(id)) return this.materialize(id).exports
      throw new Error(
        `client-modules: require("${spec}") missed the module table — not a platform seed word, not a shell-own module, `
        + 'and no registered factory (a build-time externals drift, or a forbidden cross-plugin value import)',
      )
    }
  }
```

`stripClientSuffix` (`system.ts:33-34`) means `require("@deepseek-ai/dsh-client-ui-slots/client")` and `require("@deepseek-ai/dsh-client-ui-slots")` resolve to the same table entry.

The repo's own tsdown preset emits exactly this shape (`packages/client/tsdown.client.ts:262-272`):

```ts
    outputOptions: {
      entryFileNames: 'client.js',
      sourcemapPathTransform: browserSourcePath,
      banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(id)}, factory: (require) => {`,
      footer: 'return module.exports; } });',
      intro: 'var module = { exports: {} }; var exports = module.exports;',
    },
```

with `format: 'cjs'` and `external: [...CLIENT_EXTERNALS]` (`tsdown.client.ts:178, 186`).

### 3.2 The platform seed allowlist (the complete list)

`packages/client/web/src/platform.ts:7-15`:

```ts
/** The module specifiers the shell shares into the frozen module table. */
export const PLATFORM_MODULES = [
  'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-web-react',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-attachment',
  '@deepseek-ai/dsh-client-schema-form',
] as const
```

`packages/client/web/src/seed.ts:25-41` is the runtime half, and it is described as *"the ONLY entities the shell shares into the frozen module table"* (`seed.ts:2-3`).

One documented extra is reachable at runtime but is not in `PLATFORM_MODULES` (`packages/client/tsdown.client.ts:52-65`):

```ts
/**
 * Documented TEMPORARY exemption, not a platform module (hence not in
 * platform.ts): the snapshot-store engine (createSnapshotStore/defineStore/
 * shallowEqual) lives in runtime pending its promotion-time rehoming, and
 * five importers (locale, ui-layout, ui-conversation ×3) ride this single
 * exemption. At runtime the lazy CJS table answers the require natively:
 * runtime is an immediately-tier row, its factory is registered before any
 * dependent bundle materializes. TODO(webload/store-rehome): remove with the
 * store-engine relocation follow-up.
 */
const RUNTIME_STORE_EXEMPTION = '@deepseek-ai/dsh-client-runtime/client'
```

### 3.3 Module format: ESM or CJS? Does it import react?

| | Host half | Client half |
|---|---|---|
| Format | **ESM** (`type: "module"`, `import`/`export`) | **CJS inside a classic script** — `factory(require) => exports`, no top-level `import`/`export` |
| React | n/a | `require('react')` / `require('react/jsx-runtime')` — **never a bare `import react from 'react'`** |
| Build | optional (plain `.js` works) | optional (hand-written CJS works; tsdown/rolldown/esbuild with the right banner also works) |

Proof from a real third-party bundle built by tsdown+rolldown (`node_modules/dshmarket/client/client.js:1-33`):

```js
window.__ModuleLoader__.load({ id: "dshmarket", factory: (require) => {


		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		//#region \0rolldown/runtime.js
		...
		let react = require("react");
		let _deepseek_ai_dsh_client_ui_primitives = require("@deepseek-ai/dsh-client-ui-primitives");
		_deepseek_ai_dsh_client_ui_primitives = __toESM(_deepseek_ai_dsh_client_ui_primitives, 1);
		let react_jsx_runtime = require("react/jsx-runtime");
		let react_dom = require("react-dom");
```

`dsh-better-sidebar` and `dsh-claude-style` use the identical wrapper (`dsh-better-sidebar/lib/client.js:1-30`, `dsh-claude-style/lib/client.js:90-99` — the latter's bundle is *hand-assembled by a build script* from `src/` fragments, per its own header at `lib/client.js:1-89`).

`dsh-hot-reload` is the hand-written variant (`lib/client.js:25-27, 209-212`):

```js
window.__ModuleLoader__.load({
  id: "dsh-hot-reload",
  factory: (require) => {
```
```js
    // The loader takes the factory's RETURN VALUE AS the module exports, so the
    // CJS `module.exports` preamble a built bundle carries is not needed here.
    return { apply, inject, name };
```

### 3.4 The bundle-purity gate (why you cannot import a sibling plugin)

`packages/client/tsdown.client.ts:208-225`:

```ts
    plugins: [{
      // Bundle purity gate (build-time mirror of the module-edge rules):
      // platform seed entries stay external, inline-safe wire layers inline,
      // and every other @deepseek-ai value import is a build error — a
      // cross-plugin value import either inlines a duplicate runtime instance
      // or requires a specifier the frozen module table cannot answer.
      // Cross-plugin collaboration goes through cordis services instead.
      name: 'dsh-client-bundle-purity',
      resolveId(source: string) {
        if (!source.startsWith('@deepseek-ai/')) return null
        if (CLIENT_EXTERNALS.includes(source)) return null // platform module: external wins
        if (VENDORED_LIBRARY.test(source)) return null // vendored library: inline, no shared identity
        if (INLINE_SAFE.test(source) || GENERATED_REMOTE.test(source)) return null // wire contribution: inline is the point
        throw new Error(
          `client bundle purity: "${source}" is not a platform module (CLIENT_EXTERNALS), an inline-safe wire layer, or a generated /remote contribution — `
          + 'cross-plugin value imports are forbidden; collaborate through cordis services (type-only imports are erased and never reach this gate)',
        )
      },
    }, {
```

The runtime mirror of this rule is the `require` miss at `system.ts:151-154`. `packages/client/AGENTS.md:36` states the same for first-party code:

> **Cross-package imports of another plugin's symbols are in principle forbidden.** The sanctioned routes are the slot system (register/renderSlot) and ctx services.

---

## 4. Host half contract (detail)

### 4.1 Plugin body and lifecycle

- `apply(ctx, config)` runs once per fiber; every registration made through `ctx.effect(...)`, `ctx.on(...)`, `ctx.slots.register(...)` etc. is disposed with the fiber. `docs/cordis-tutorial/02-lifecycle-and-effects.md:16-29`.
- Non-blocking optional dependencies use `ctx.inject(['webServer'], (webCtx) => {...})`, **not** a module-level `export const inject`. `dsh-hot-reload` documents the three-way distinction verbatim (`lib/index.js:747-760`):

```js
  // ctx.inject, NOT a module-level `export const inject`, and NOT a one-shot
  // ctx.get. The distinction matters three ways:
  //
  //  - a module-level inject is REQUIRED (Inject.resolve maps every declared
  //    name to a wait), so it would park the whole plugin forever in a profile
  //    that has no web server — tui would stop reloading anything at all;
  //  - ctx.inject parks only this CHILD fiber, leaving the reloader running;
  //  - ctx.get would be both racy and one-shot. …
```

### 4.2 What the host half can reach

Documented services relevant to a settings plugin:

| Service | Where | Use |
|---|---|---|
| `ctx.settings` | `packages/settings/settings/src/index.ts:350` | register a settings namespace, read/write layered values |
| `ctx.configEditor` | 0.2.0-rc.2 only (`app.asar → dsh/node_modules/@deepseek-ai/dsh-config-editor/lib/index.js:16-22`) | persist a plugin entry's raw `config` into the profile patch |
| `ctx.webServer` | `packages/host/webserver/src/index.ts:59` | register HTTP routes / SSE for your own browser half |
| `ctx.loader` | cordis loader | inspect entries; `dsh-hot-reload` uses `loader.internal` for module-cache invalidation |
| `ctx.logger` | cordis | logging |

### 4.3 Cordis layer composition (see §5)

---

## 5. Install / uninstall mechanics

### 5.1 `dsh plugin --profile <name> <args...>` — the documented path

`docs/user/develop/basic/publish.md:77`:

> `dsh plugin --profile <name> <args...>` forwards to pnpm in the profile directory, so every pnpm verb works.

Implementation (`apps/cli/src/plugin.ts:120-158`) — this is the whole mechanism:

```ts
export function runPlugin(profile: string, args: readonly string[]): number {
  const dir = resolveProfileDir(profile)
  if (!existsSync(join(dir, 'package.json'))) {
    initProfile(dir, PROFILE_TEMPLATES[profile] ?? DEFAULT_PROFILE_BUNDLES)
    process.stderr.write(`${NAME}: initialized profile ${profile} at ${dir}\n`)
  }
  const before = readProfileManifest(NAME, dir)
  // Windows resolves pnpm through its .cmd shim, which spawn() refuses
  // without a shell since the CVE-2024-27980 hardening.
  const result = spawnSync('pnpm', args.map(argument => anchorPathSpec(argument, process.cwd())), {
    cwd: dir,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  })
  if (result.error !== undefined) {
    const code = (result.error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') {
      process.stderr.write(`${NAME}: pnpm not found on PATH — install pnpm to manage profile plugins\n`)
      return 127
    }
    throw result.error
  }
  const exitCode = result.status ?? 1
  if (exitCode === 0) {
    reconcilePlugins(before, dir)
  } else {
    // pnpm's own diagnostics name pnpm-workspace.yaml without saying WHICH
    // one; the profile owns it, and the commonest failure here is pnpm ≥10
    // blocking a git dependency's prepare (build) script until allowlisted.
    process.stderr.write(`${NAME}: pnpm failed in profile directory ${dir}\n`)
    if (args.some(argument => /^git\+|^github:|\.git(?:#|$)/.test(argument))) {
      process.stderr.write(
        `${NAME}: git-hosted plugins build on install via their prepare script, which pnpm blocks until allowed — `
        + `add the exact key pnpm printed above under allowBuilds in ${join(dir, 'pnpm-workspace.yaml')}, then re-run\n`,
      )
    }
  }
  return exitCode
}
```

Reconciliation (`apps/cli/src/plugin.ts:59-91`):

```ts
function reconcilePlugins(before: ProfileManifest, profileDir: string): void {
  const after = readProfileManifest(NAME, profileDir)
  const beforeDeps = new Set(Object.keys(before.dependencies ?? {}))
  const dependencies = Object.keys(after.dependencies ?? {})
  const plugins = after.dsh?.profile?.bundles ?? []
  let changed = false
  for (const packageName of dependencies) {
    const isBundle = exportsPatch(packageName, profileDir)
    if (isBundle && !plugins.includes(packageName)) {
      plugins.push(packageName)
      changed = true
    } else if (!isBundle && !beforeDeps.has(packageName)) {
      process.stderr.write(
        `${NAME}: warning: ${packageName} declares no dsh.bundle — installed as a plain dependency, not a profile layer `
        + '(a later update that gains one activates it automatically)\n',
      )
    }
  }
  const dependencySet = new Set(dependencies)
  for (const packageName of [...plugins]) {
    // Only dependency-managed entries are subject to removal; template
    // bundles (dsh-base and friends) are not dependencies.
    const wasDependency = beforeDeps.has(packageName) || dependencySet.has(packageName)
    const stillBundle = dependencySet.has(packageName) && exportsPatch(packageName, profileDir)
    if (wasDependency && !stillBundle) {
      plugins.splice(plugins.indexOf(packageName), 1)
      changed = true
    }
  }
  if (!changed) return
  after.dsh = { ...after.dsh, profile: { ...after.dsh?.profile, bundles: plugins } }
  writeProfileManifest(profileDir, after)
}
```

and `exportsPatch` (`:36-45`) — the "is this a bundle?" test is literally `dsh.bundle.patch !== undefined`.

### 5.2 Exactly which files change

**Install (`dsh plugin --profile desktop add dsh-my-plugin`)** — matches the observed live profile:

| File | Change |
|---|---|
| `<profile>/package.json` → `dependencies` | pnpm writes `"dsh-my-plugin": "^1.2.3"` (or `link:`/`file:` for a path spec) |
| `<profile>/package.json` → `dsh.profile.bundles` | `reconcilePlugins` **appends** the package name (only if it declares `dsh.bundle`) |
| `<profile>/pnpm-lock.yaml` | pnpm |
| `<profile>/node_modules/` | pnpm (hoisted linker, see 5.4) |
| `<profile>/pnpm-workspace.yaml` | unchanged by DSH; pnpm adds `allowBuilds: { <pkg>: true }` when it blocks a git dependency's `prepare` and the user allows it (`publish.md:164-169`) |
| `<profile>/.plugin-manager/` | only for the *manager* path (§5.3): `run.json` during a run, `logs/` diagnostics afterwards |

The live `desktop` profile's `package.json` shows the result of six such installs:

```json
{
  "name": "dsh-profile-desktop",
  "private": true,
  "dependencies": {
    "@yuxianglin/dsh-bridge-browser": "link:./.dsh-browser-source",
    "dsh-better-sidebar": "^0.24.1",
    "dsh-claude-style": "0.10.3",
    "dsh-hot-reload": "0.2.4",
    "dsh-whale-widget": "^0.3.17",
    "dshmarket": "^1.66.8"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "@yuxianglin/dsh-bridge-browser",
        "dshmarket",
        "dsh-whale-widget",
        "dsh-better-sidebar",
        "dsh-claude-style",
        "dsh-hot-reload"
      ]
    }
  }
}
```

**Uninstall (`... remove dsh-my-plugin`)** — `publish.md:110`: *"`dsh plugin --profile demo remove dsh-hello-plugin` removes both the dependency and the layer."* The same `reconcilePlugins` loop drops the name from `dsh.profile.bundles` because `dependencySet.has(name)` becomes false. Also changed: `pnpm-lock.yaml`, `node_modules/`. **The bundle's own `cordis.patch.yml` is never touched** — deselecting the bundle is what unmounts it.

**Rollback:** the CLI path has no rollback (a failed `pnpm` just leaves whatever pnpm left, plus a diagnostic). The *plugin-manager* path does (§5.3).

### 5.3 The `plugin_manager` tool / `@deepseek-ai/dsh-plugin-manager`

**This package is not in the source checkout.** It is shipped only inside the running desktop app (`app.asar → dsh/node_modules/@deepseek-ai/dsh-plugin-manager`, `package.json` version `0.2.0-rc.2`; files `lib/index.js`, `lib/typert.host.js`, `lib/typert.remote-client.js`). Its README documents the contract precisely — the following are verbatim quotes with line numbers into `app.asar → dsh/node_modules/@deepseek-ai/dsh-plugin-manager/README.md`:

Layer/state writes (`README.md:40`):

> A plugin toggle updates only `disabled` in the last matching override in the profile's `cordis.patch.yml`, or appends an override when none matches. Matching uses the entry id and any module-name assertion. A bundle toggle changes `package.json`'s ordered `dsh.profile.bundles` list. Disabling retains the dependency; enabling appends the bundle at the end, which can change configuration precedence. Installation enables a new bundle by default. Home and invocation patches retain their higher priority.

Install streams and rollback (`README.md:54`):

> `installBundle` accepts a caller-generated `requestId`, under which `plugin-manager/install-log` streams each pnpm run's output and `plugin-manager/install-state` announces `installing`, `cancelling`, and `applying`… A run that fails, is cancelled, or adds a package without a bundle patch **restores `package.json` and `pnpm-lock.yaml` as they were**; `packageResult.kind` classifies the last run from its exit and output, `registries` names every registry asked, and `bundle` names the package a finished run added. … Every completed operation emits `plugin-manager/changed`.

Build-script approval (`README.md:58`):

> When pnpm 11 blocks dependency scripts, the failed installation reports every pending package name in the profile under `pendingBuilds`, including names left by earlier attempts; a failed run restores `package.json` and `pnpm-lock.yaml` but **deliberately not `pnpm-workspace.yaml`**, where pnpm records them. The Web plugin page offers **Allow these scripts and retry**; the tool can grant permission on the user's behalf through `approvedBuilds` on `install_bundle`, after the user approves those scripts in the conversation. … Approval persists by package name in this profile…

Run bookkeeping and lock (`README.md:92`):

> … Each operation records the pnpm run it starts in `.plugin-manager/run.json` and removes the record when the run ends. A lock whose holder process exited is taken over by the next writer… An operation that finds a record waits up to five seconds for the recorded run to stop and otherwise fails with a diagnostic that names the process and the record, without running pnpm. Dependency-only changes do not trigger configuration reloads.

Removal order and failure behaviour (`README.md:144-150`):

> | Install: pnpm or bundle validation fails | Restore `package.json` and `pnpm-lock.yaml` as snapshotted before pnpm ran; files pnpm downloaded may remain. Report installation failure. |
> | Enable: saving selection or loading fails | Keep the installed dependency and any saved selection. Report enablement failure; allow repair, disablement or removal. |
> | Remove: any step fails | Stop at the failed step. Preserve completed changes, retain remaining dependencies for retry, and report removal failure. Do not re-enable the bundle. |

> Removal proceeds in order: remove the bundle from `dsh.profile.bundles`, unload its runtime contributions, then run `pnpm remove`. A failed step prevents subsequent steps.
>
> Restoration rewrites only the two snapshotted files; user-authored patch configuration, application data, diagnostic logs and files pnpm downloaded remain untouched…

Config fields (`README.md:73-82`): `pnpmCommand`, `inspectTimeoutMs` (20000), `githubConnectionTimeoutMs` (5000), `registry`, `fallbackRegistries` (default `['https://registry.npmmirror.com/']`), `outputBytes` (16384), `lockWaitMs` (120000), `idleTimeoutMs` (600000).

Version exemptions (`README.md:65`): *"An exemption is an exact `package-name@version` mapped to a list of exact DSH runtime versions in the profile's own `compatibility.json`, beside `package.json` and `cordis.patch.yml`."*

Mount points in the live profile's `cordis.yml`:

```yaml
- id: tool-plugin-manager
  name: '@deepseek-ai/dsh-plugin-manager/tools'
  disabled: true
- id: plugin-manager
  name: '@deepseek-ai/dsh-plugin-manager'
  disabled: !!js '!ctx.get(''profileContext'')'
- id: config-editor
  name: '@deepseek-ai/dsh-config-editor'
  disabled: !!js '!ctx.get(''profileContext'')'
```

Both `/tools` and the base package are mounted with `disabled: !!js '!ctx.get(''profileContext'')'` — i.e. the manager only activates for a **profile boot**, which is the case for the desktop profile.

**Observed backup files** in `C:\Users\30394\.dsh\profiles\desktop`: `cordis.patch.yml.bak-1790866443907` and `package.json.bak-before-dsh-browser`. The `*.bak-<epoch-ms>` naming and the `-before-dsh-browser` label do **not** appear in either the plugin-manager README or the CLI code, and `dshmarket`'s package ships its own `lib/backup.js` / `lib/restore` machinery — so these are almost certainly written by the `dshmarket` third-party market plugin (or manually), **not** by DSH's own manager. Treat them as user-space artifacts, not a documented DSH rollback contract.

### 5.4 Profile layout, pnpm settings and module resolution

`initProfile` writes three files (`packages/boot/app-boot/src/profile.ts:127-168`):

```ts
const PROFILE_PATCH_TEMPLATE = `# Your patch layer for this dsh profile, applied after every bundle layer:
# a top-level YAML array of loader patch entries (id-targeted config
# overrides, disables, and insert lists; \`!!js\` expressions allowed).
[]
`

// The hoisted linker gives out-of-tree plugins a flat node_modules whose
// missing peers (cordis and friends) fall through to the healed
// profiles/node_modules installation fallback, so every plugin shares the
// installation's single cordis instance instead of a duplicate. pnpm ≥10
// reads its settings from pnpm-workspace.yaml, not .npmrc.
const PROFILE_PNPM_WORKSPACE = `packages:
  - .

nodeLinker: hoisted
autoInstallPeers: false
`
```

```ts
export function initProfile(dir: string, bundles: readonly string[]): void {
  mkdirSync(dir, { recursive: true })
  const manifestPath = join(dir, 'package.json')
  if (!existsSync(manifestPath)) {
    const manifest: ProfileManifest & { private: boolean } = {
      name: `dsh-profile-${basename(dir)}`,
      private: true,
      dependencies: {},
      dsh: { profile: { bundles: [...bundles] } },
    }
    writeFileSync(manifestPath, JSON.stringify(manifest, undefined, 2) + '\n')
  }
  const patchPath = join(dir, PROFILE_PATCH_FILENAME)
  if (!existsSync(patchPath)) writeFileSync(patchPath, PROFILE_PATCH_TEMPLATE)
  const workspacePath = join(dir, 'pnpm-workspace.yaml')
  if (!existsSync(workspacePath)) writeFileSync(workspacePath, PROFILE_PNPM_WORKSPACE)
}
```

The **two-anchor resolution** that lets a third-party plugin import nothing and still work (`profile.ts:204-220`, quoting its own doc comment):

> Maintain the flat module fallback `$DSH_HOME/profiles/node_modules`: one symlink per package in the dsh app's resolvable dependency CLOSURE (BFS over `dependencies` from the app manifest), each resolved from its own real location. Node's parent-directory walk from any profile finds this directory after the profile's own `node_modules`, so every in-box plugin resolves without pnpm ever managing it — the exact "bundles come from the installation" contract.

Confirmed live: `C:\Users\30394\.dsh\profiles\node_modules\@deepseek-ai\` holds 249 entries at version `0.2.0-rc.2`, while `C:\Users\30394\.dsh\profiles\desktop\node_modules\@deepseek-ai\` holds only `cosmokit` and `schemastery`.

### 5.5 Layer composition and the patch format

`packages/boot/app-boot/src/profile.ts:405-420`:

```ts
/**
 * Compose patch layers into the effective entry list over an empty root —
 * the same single `applyEntryPatches` call the boot include makes, so flag
 * derivation and config dumps see exactly what mounts.
 */
export function composeEntries(
  layers: readonly PatchOptions[][], warn: (message: string) => void = () => {},
): EntryOptions[] {
  return applyEntryPatches([], structuredClone(layers.flat()), (message: string, ...args: unknown[]) => {
    let index = 0
    warn(message.replace(/%C/g, () => JSON.stringify(args[index++])))
  })
}
```

The precedence order, verbatim from `docs/user/develop/basic/publish.md:114-126`:

> The effective configuration composes over an empty root by applying, in order:
>
> 1. Each bundle patch named in the profile's `dsh.profile.bundles` list, in list order — `@deepseek-ai/dsh-base` first, then each installed bundle in the order it was added.
> 2. The profile's own `cordis.patch.yml`.
> 3. The home-level `$DSH_HOME/cordis.patch.yml` — machine-local preferences shared by every profile.
> 4. Each `--patch <path>` overlay, in argv order.
>
> Later layers win per row, and a patch replaces a row's entire `config` value rather than deep-merging keys.

**`cordis.patch.yml` format** — a top-level YAML array of two entry kinds:

```yaml
# Override/target an existing row by id (config is REPLACED wholesale)
- id: ui-theme
  name: "@deepseek-ai/dsh-client-ui-theme"   # optional module-name assertion
  disabled: false                            # optional
  config:
    preference: dark

# Insert new rows
- insert:
    - id: better-sidebar
      name: 'dsh-better-sidebar'
```

`parsePatchList` (`profile.ts:320-338`) enforces only "top-level array of mappings"; every bundle patch goes through it. A patch that matches no row is a per-entry Loader warning, not an error (`profile.ts:311-313`).

Real third-party patches:

`dsh-hot-reload/cordis.patch.yml:9-16`:
```yaml
- insert:
    - id: hot-reload
      name: 'dsh-hot-reload'
      # config:
      #   # Debounce (ms) after a lockfile change before acting.
      #   debounce: 300
      #   # Absolute path to the profile dir to watch; auto-detected if omitted.
      #   profileDir: ''
```

`dshmarket/cordis.patch.yml:2-4`:
```yaml
- insert:
    - id: dsh-market
      name: 'dshmarket'
```

`dsh-better-sidebar/cordis.patch.yml:39-42` — shows the double-mount guard, whose comment block (`:1-38`) also documents the intended install UX:
```yaml
- insert:
    - id: better-sidebar
      name: 'dsh-better-sidebar'
      disabled: !!js "[...ctx.loader.entries()].some((e) => e.options.name === 'dsh-better-sidebar' && e.options.id !== 'better-sidebar' && !e.disabled)"
```

`dsh-claude-style/cordis.patch.yml:1-4`:
```yaml
# Claude Code Desktop theme bundle patch: inserts its dsh.client row into the web roster.
- insert:
    - id: ui-skin-claude-style
      name: 'dsh-claude-style'
```

The hosted bundle's own bundle-and-client recipe (`packages/bundle/web-app/cordis.patch.yml:45-47`):

```yaml
# `dsh.client` rows are the browser roster the modules node half scans into
# window.__DSH_BOOT__; the modules row is simultaneously a host row.
- insert:
```

---

## 6. Settings slot registration API

### 6.1 The slot system in one sentence

`packages/client/AGENTS.md:11`:

> **One API**: a plugin composes UI only through `ctx.slots.register({ name, children?, store?, inject? }, Component)`. There is no separate slot-definition call, no whitelist face object, no face-minting helper. The shell alone renders `'root'`.

and `:12`:

> **children = declaration + authorization**: the slots your component renders are exactly the keys of your register call's `children` object (spec values: `kind`/`scope`). Rendering a slot you didn't declare, or declaring one someone else declared, fails at load…

### 6.2 Who owns and declares `settings.section`

- **Type/contract**: `packages/client/ui-settings/src/client/contract/slots.ts:53` inside `packages/client/ui-settings` (the settings *domain base*, which itself injects nothing and only provides `ctx.settingsScope`):

```ts
    /**
     * One settings page per list entry. Registrant options carry the nav
     * identity: `id` (section key, drives `only` filtering), `order` (nav
     * position), `label` (registrant-localized display text — the registrant
     * re-registers with fresh text on locale change, so the shell never
     * subscribes locale state; the ledger bump doubles as the shell's
     * re-render trigger). Sections render inside the panel content column.
     * (`settings.general.item`, declared by ui-settings-general's General
     * entry, is typed in the locale package — the common dependency of every
     * item registrant; the shell neither declares nor renders it.)
     */
    'settings.section': { kind: 'list'; scope: 'root'; owner: SettingsSectionOwnerProps }
```

- **Runtime declaration**: the `sidebar.settings` occupant's `children` table, in `ui-settings-general/src/client/index.ts:142-153`:

```ts
  ctx.slots.inject('sidebar.settings', () => ctx.slots.register({
    name: 'sidebar.settings',
    children: {
      'settings.trigger': { kind: 'single', scope: 'root' },
      'settings.header': { kind: 'single', scope: 'root' },
      'settings.action': { kind: 'list', scope: 'root' },
      'settings.close': { kind: 'single', scope: 'root' },
      'settings.section': { kind: 'list', scope: 'root' },
      'settings.onboarding': { kind: 'list', scope: 'root' },
    },
    inject: shellInjected,
  }, SettingsRoot))
```

The platform's own live slot catalog states this (`packages/extensions/cordis-client-runner/src/client/slot-catalog.ts:1387-1396`):

```ts
    declaredBy: 'an entry in \'sidebar.settings\' (client-ui-settings-general), so it exists while that entry is mounted',
    occupants: [
      'client-ui-agent-preset AgentPresetSection id \'agent-presets\'',
      'client-ui-settings-general GeneralSection id \'general\'',
      'client-ui-settings-models ModelsSection id \'models\'',
      'client-ui-settings-plugins PluginsSettingsSection id \'plugins\'',
    ],
    replaceRisk: 'none',
    example: 'return {\n  inject: [\'slots\'],\n  apply(ctx) {\n    ctx.slots.inject(\'settings.section\', () => ctx.slots.register(\n      { name: \'settings.section\', id: \'my-entry\', order: 100, label: \'My entry\' },\n      () => React.createElement(\'div\', null, \'hello\'),\n    ))\n  },\n}',
    source: 'packages/client/ui-settings/src/client/contract/slots.ts:53',
```

**Key consequence:** you do **not** need a declaration of your own. `settings.section` is declared by an in-box row.

### 6.3 The exact call signature

The canonical real contributor, end to end (`packages/client/ui-settings-models/src/client/index.ts:54-124`):

```ts
/**
 * Required services (cordis fiber inject). The target slot is declared by
 * ui-settings' apply, whose activation order relative to this one is NOT
 * constrained; registration depends on each slot through `slots.inject()`.
 */
export const inject = ['slots', 'locale', 'connection', 'remote']

/**
 * Register the Models section once the `settings.section` declaration is on
 * the ledger, wire its store to the connection, and keep it fresh on every
 * pushed invalidation (settings, credentials, or provider topology).
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-settings-models: copy dictionaries')

  const connection = ctx.get('connection') as ConnectionHandle
  const controller = new ModelsSettingsStore(connection.api)
  const useSnapshot = bindSnapshotSelector(controller.store)
  // Registration-time text (the nav label thunk) and the inject faces share
  // one bound translate; copy freshness rides the locale revision.
  const t = ctx.locale.bind(NS) as ModelsSectionInjected['t']
  const injected = (): ModelsSectionInjected => ({
    controller,
    useSnapshot,
    api: connection.api,
    t,
  })
  ...
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'models',
    order: 10,
    label: () => t('nav'),
    inject: injected,
  }, ModelsSection))
```

So the registration options for a `list` slot (`packages/client/ui-slots/src/index.ts:474-510, 526-550`):

```ts
export type SlotLabel = string | (() => string)

    : SlotMap[K]['kind'] extends 'list' ? {
      id: string
      order?: number
      label?: SlotLabel
      /** Cell shadowing rank (ascending, default 0, lowest renders; same id + same priority throws — see {@link SlotCore.register}). */
      priority?: number
    }
```

plus the common share:

```ts
type BaseOptions<...> = {
  /** Target slot key (the entry contributes INTO this slot). */
  name: K
  /** Child-slot declaration + render authorization + runtime spec, in one table. */
  children?: D
  /** Store seat: a shared handle (apply-constructed) or an exclusive factory (framework-called per entry x scope). */
  store?: H
  /**
   * Dictionary namespace of this entry's copy. Declaring it puts the
   * framework-synthesized `t` seat (typed to the namespace's dictionary
   * union) on the component props; rendering requires an installed locale
   * face — fails loud otherwise.
   */
  locale?: N
  /** Registrant identity label for diagnostics (the runtime Service wrapper stamps the caller's fiber name). */
  registrant?: string
} & KindOptions<K, EntryKey, M>
```

Two `register` overloads exist: one **without** `inject` (`ui-slots/src/index.ts:741-757`) and one **with** an `inject` factory (`:768-785`). The `inject` factory's parameters derive from the slot declaration (`InjectParams`, `:460-467`); for a root-scope list slot with no store, it takes no arguments.

### 6.4 `ctx.slots.inject(name, callback)` — why it is mandatory

`packages/client/AGENTS.md:97`:

> **Registering into another package's slot**: apply order is unconstrained, and a business service is not a declaration barrier. Use `ctx.slots.inject(name, () => ctx.slots.register(...))`; it waits on the actual declaration, removes the contribution when that declaration collapses, reruns after redeclaration, and leaves with the caller's plugin fiber. Return a generator yielding each registration when several contributions must install and roll back atomically. **A bare `slots.register` into an undeclared slot remains an error**; keep service edges only for services the contribution actually reads.

Implementation (`packages/client/runtime/src/client/slots.ts:143-205`) — key facts: the controller is a `ctx.effect` on the *caller's* fiber; it subscribes to `subscribeDeclaration(key)`; `specDynamic(key)` gates the actual `ctx.effect(callback, ...)`; a generator callback yields each registration and disposes them in reverse transactionally.

Bare `register` into an undeclared slot throws (`packages/client/ui-slots/src/index.ts:788-791`):

```ts
    const rec = this.records.get(options.name)
    if (!rec?.spec) {
      throw new Error(`slot "${options.name}" is not declared (a parent entry's children table must declare it)`)
    }
```

### 6.5 The other settings slots (live catalogue)

| Slot | Kind / scope | Owner props | Declared by |
|---|---|---|---|
| `settings.section` | list / root | `{ close: () => void }` | entry in `sidebar.settings` (ui-settings-general) |
| `settings.general.item` | list / root | `{}` (marker only) | the `GeneralSection` entry in `settings.section` |
| `settings.plugins.tab` | list / root | `{}` (marker only) | the `PluginsSettingsSection` entry in `settings.section` |
| `settings.trigger` | single / root | `{ wide: boolean }` | entry in `sidebar.settings` |
| `settings.header` | single / root | `{}` | entry in `sidebar.settings` |
| `settings.action` | list / root | `{}` | entry in `sidebar.settings` |
| `settings.close` | single / root | `{}` | entry in `sidebar.settings` |
| `settings.onboarding` | list / root | `{ stepId, complete, openSection }` | entry in `sidebar.settings` |
| `settings.plugin.item` | keyed (`key` = settings namespace) | `{}` | the `configurable` entry in `settings.plugins.tab` — **0.1.0-rc.7 only** |

Owner props verbatim (`packages/client/ui-settings/src/client/contract/slots.ts:91-135`):

```ts
/** Owner share of a General preference row (the section supplies nothing). */
export interface SettingsGeneralItemOwnerProps {
  /** Marker field: item owner props are intentionally empty. */
  children?: never
}

/** Owner share of a Plugins tab (the section supplies nothing). */
export interface SettingsPluginsTabOwnerProps {
  /** Marker field: tab owner props are intentionally empty. */
  children?: never
}

/** Owner share of the trigger content seat: the sidebar column state. */
export interface SettingsTriggerOwnerProps {
  /** Whether the sidebar renders wide content (false = 56px rail, icon only). */
  wide: boolean
}

/** Owner share of the header title seat (the shell supplies nothing). */
export interface SettingsHeaderOwnerProps {
  /** Marker field: header owner props are intentionally empty. */
  children?: never
}

/**
 * Owner share of a settings section entry. The shell owns modal visibility
 * and navigation; a section's data arrives through its own inject faces and
 * stores. `close` is the one shell affordance a section receives, for flows
 * that leave settings altogether (starting a session from a section) — the
 * onboarding coordinator's `openSection`/`complete` precedent, inverted.
 */
export interface SettingsSectionOwnerProps {
  /** Close the settings panel (the shell owns the open state). */
  close: () => void
}

/** Owner share of the currently active settings-backed onboarding step. */
export interface SettingsOnboardingOwnerProps {
  /** Stable id of the step currently selected by the coordinator. */
  stepId: string
  /** Complete or skip this step and transfer ownership to the next entry. */
  complete: () => void
  /** Open the settings panel directly on one registered section. */
  openSection: (id: string) => void
}
```

**⚠️ Version caveat.** The keyed `settings.plugin.item` slot exists in the checkout (`packages/client/ui-settings-plugins/src/client/slot-contract.ts:19`) and is the target recommended by `docs/cookbook/adding-a-settings-card.md:60-67`. But the **running** `0.2.0-rc.2` bundle of that package declares only `settings.plugins.tab` in its `settings.section` registration, and a string scan of the installed `lib/client.js` finds no `settings.plugin.item` and no `plugins.bundle.config`:

```
dsh-client-ui-settings-plugin-inventory -> settings.plugins.tab
dsh-client-ui-settings-general -> settings.general.item, settings.section
dsh-client-ui-settings -> (none)
```

`ctx.slots.inject` on an undeclared slot **parks quietly forever** (no throw) — so a card written against `settings.plugin.item` would silently never appear. **Prefer `settings.section` for a new third-party plugin**; it is declared on both versions. (This is also what `dsh-claude-style` hedges against by registering into both `plugins.bundle.config` and `settings.section` — `lib/client.js:19931-19999`.)

---

## 7. UI component contract

### 7.1 The four props shares

`packages/client/AGENTS.md:13`:

> **Component props are the four shares, all derived**: `PropsRuntime<K>` (SlotMap: owner params + `useSession`/`sessionId` on session scope + global `useSessions`/`useWorkspaces`) & `PropsRenderSlots<S>` (children keys) & `PropsStore<H>` (store factory) & the inject face. Never hand-write a member a share already derives; never re-type a share locally.

The composition type (`packages/client/ui-slots/src/index.ts:442-450`):

```ts
export type ComposedProps<
  K extends keyof SlotMap & string,
  EntryKey extends EntryKeyOf<K>,
  S extends keyof SlotMap & string,
  H,
  I extends object,
  M = never,
  N = undefined,
> = PropsRuntime<K, EntryKey> & PropsRenderSlots<S> & PropsStore<H> & InjectFace<I> & MatchedShare<SlotMap[K], M> & PropsLocale<N>
```

For `settings.section` (list, root, no children, no store) a component therefore receives:

- `close: () => void` (owner share)
- `useSessions`, `useWorkspaces` (global standard kit, merged by `client-runtime`, `packages/client/runtime/src/client/index.ts:146-150`)
- everything your `inject` factory returns
- `t` if you declared `locale: NS`
- `renderSlot` **only if** you declared `children`

A real component's declared props (`packages/client/ui-settings-models/src/client/ModelsSection.tsx:27-43`):

```tsx
/** Injected dependencies of {@link ModelsSection} (slot `inject`). */
export interface ModelsSectionInjected {
  /** The page store (loaded on mount, refreshed on pushed invalidations). */
  controller: ModelsSettingsStore
  /** uSES subscription hook bound to the store. */
  useSnapshot: SnapshotSelectorHook<ModelsSettingsState>
  /** Wire faces the editor writes through. */
  api: Pick<IApiClient, 'settings' | 'credentials' | 'llm'>
  /** Section copy. */
  t: (key: keyof typeof en) => string
}

/**
 * Props delivered by the slot outlet: the inject face spread flat (the
 * renderer erases the share boundary at the render call).
 */
export type ModelsSectionProps = Partial<ModelsSectionInjected>
```

### 7.2 The rules a component must obey

`packages/client/AGENTS.md:14-17`:

> 4. **Hooks are framework-made only**: `useSession`, `useSessions`, `useWorkspaces`, `useStore`, `renderSlot` are the five standing seats, plus the `use<Name>` hooks the renderer binds from provide contributions and inject `hooks` compartments. Business code never creates a hook or selector as a prop value — pass plain data and callbacks.
> 5. **Live data has exactly three channels**: parent knows it → owner props at the renderSlot site; only the component knows it → local state; shared across entries or survives remounts → a store declared at register. Derived data is a pure function over framework-hook data (`useMemo`), never its own subscription.
> 6. **Stores: read `props.useStore`, write `props.actions.*`** …
> 7. **inject returns plain data and callbacks** from the apply closure's own ctx — no hand-made hooks, no ReactNode producers, no whole-service objects. A registrant-private reactive fact uses the reserved `hooks` compartment (bare observables the renderer binds to `use<Name>`; components never see the sources).

`:40` — components never see `ctx`:

> `ctx` belongs to the apply world only: the plugin body and the inject factories closed over it. Components — every `.tsx` under a feature domain — receive all data and callbacks **through the four props shares**…

`:26` — UI domains share only JSON-compatible data:

> **UI domains share only JSON-compatible data and callbacks.** Owner props, injected values, store state, and provide contributions are plain serializable data or callbacks over such data. The injected `hooks` compartment is the only place for bare observables, and components never receive those sources directly.

The `hooks` compartment pattern is how a private reactive source reaches a component as a `use<Name>` hook. Real example (`packages/client/ui-settings-general/src/client/index.ts:94-141`):

```ts
  const shellInjected = (): SettingsRootInjected => ({
    hooks: {
      sections: {
        getSnapshot: () => {
          const version = ctx.slots.getVersion('settings.section')
          const revision = ctx.locale.getSnapshot().revision
          if (version !== rowsVersion || revision !== rowsRevision) {
            rowsVersion = version
            rowsRevision = revision
            rows = ctx.slots.entries('settings.section')
              .map(e => ({
                id: e.options.id ?? '',
                order: e.options.order ?? 0,
                label: resolveSlotLabel(e.options.label) ?? '',
              }))
              .sort((a, b) => a.order - b.order)
          }
          return rows
        },
        subscribe: (listener) => {
          const offLedger = ctx.slots.subscribe('settings.section', listener)
          const offLocale = ctx.locale.subscribe(listener)
          return () => { offLedger(); offLocale() }
        },
      },
      ...
```

The component then receives `useSections` (bound from the key `sections`).

### 7.3 `export` discipline for a UI plugin package

`packages/client/AGENTS.md:32-36`:

> The `/client` entrypoint of a UI plugin package is its public browser API, not a convenience barrel. Three rules apply package-wide:
>
> 1. **A UI plugin exports no values beyond what cordis loading needs** — `apply` / `inject` (and `Config` where present), plus store factories consumed type-only by components (`ReturnType<typeof createXXXStore>`). …
> 2. **Same-package tests import internals directly** …
> 3. **Cross-package imports of another plugin's symbols are in principle forbidden.** …

So your `lib/client.js` should `return { apply, inject }` and nothing else (plus `name`, as `dsh-hot-reload` does).

---

## 8. Client ↔ Host communication options

### 8.1 Option A (only first-party): a generated `@Remote` namespace — **not available to a third-party plugin**

`docs/api-gateway.md:9`:

> Business services use `@Remote` or `@RemoteScope` to select the methods exposed to the Client. Unmarked methods do not enter the generated Client types or runtime contributions and cannot be called through `ctx.remote`.

Host side (`docs/api-gateway.md:17-54`, verbatim):

```ts
import type { Agent } from '@deepseek-ai/dsh-agent'
import { TypertRemoteService, Remote, RemoteScope } from '@deepseek-ai/dsh-typert-protocol'
import type { Context } from '@deepseek-ai/cordis'

export class GoalService extends TypertRemoteService {
  constructor(ctx: Context) {
    super(ctx, 'goals')
  }

  @Remote('create')
  createForClient(
    agent: Agent,
    request: CreateGoalRequest,
    signal: AbortSignal,
  ): CreateGoalResult {
    signal.throwIfAborted()
    return this.create(agent, request)
  }

  @RemoteScope('agent', 'current')
  currentForClient(): CreateGoalResult {
    return { accepted: true }
  }
}
```

Client side (`docs/api-gateway.md:58, 66-73`):

```ts
export const inject = ['remote', 'remote.goals']
await ctx.remote.goals.create(agentId, { objective: 'ship it' })
await agentCtx.remote.goals.create({ objective: 'ship it' })
```

**Why a third party cannot add a namespace.** `docs/api-gateway.md:76`:

> Client applications assemble **only** `@deepseek-ai/dsh-api-remotes`. That package imports the `/remote` subpaths of selected business packages as runtime values, mounts their contributions through `ctx.remote.$mount()`, and re-exports the declaration merges from the same files. **Adding a Host Remote package is an explicit choice by the Client composition owner**…

The assembly is compiled in (`packages/api/remotes/src/client/index.ts:4-11, 92-111`):

```ts
import commandsRemote from '@deepseek-ai/dsh-commands/remote'
import goalsRemote from '@deepseek-ai/dsh-goal/remote'
import dynamicRemote from '@deepseek-ai/dsh-cordis-host-runner/remote'
import pluginInventoryRemote from '@deepseek-ai/dsh-host-plugin-inventory/remote'
import messageFeedbackRemote from '@deepseek-ai/dsh-message-feedback/remote'
import type { TypertClientRemote } from '@deepseek-ai/dsh-typert-protocol'
```
```ts
    /** Generated Remote namespaces selected by this Client assembly. */
    remote: TypertClientRemote
```
```ts
      commandsRemote, goalsRemote, dynamicRemote, pluginInventoryRemote, messageFeedbackRemote,
```
```ts
      disposers.push(await ctx.remote.$mount(contribution))
```

And the artifacts only exist if generated at build time from the Host `ts.Program` (`packages/typert/generator/README.md:19-21`):

> When invoked for artifact publication, it requires host artifacts at `lib/typert.host.{js,d.ts}` exposed as `package/typert`, and client artifacts at `lib/typert.client.{js,d.ts}` exposed as `package/client/typert`. … The repository's Host tsdown runs workspace Typert generation with `tsconfig.host.json` as its only program seed; it produces both Host reflection artifacts and the `typert.remote-client.*` projection of Host Remote contracts for the Client.

There is no runtime registration path: `ctx.remote` is a namespace map merged by generated `.d.ts` files (`docs/subsystems/typert.md:133-136`). **Out of scope for a third-party plugin.**

### 8.2 Option B (recommended): your own HTTP route on `ctx.webServer`

`docs/subsystems/web-server.md:11-27`:

```ts
/** Route match kind: 'exact' matches the pathname verbatim; 'prefix' p matches p and p/<anything>. */
type WebRouteKind = 'exact' | 'prefix'

/** One named route registration. */
interface WebRoute {
  kind: WebRouteKind
  /** Absolute pathname, no trailing slash. */
  path: string
  /** Owns the full response lifecycle (may hold the response open, e.g. SSE). */
  handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
}
```

Service (`docs/subsystems/web-server.md:63-104`):

```ts cordis-catalog
register(route: WebRoute): () => void
registerUpgrade(route: WebUpgradeRoute): () => void
registerFallback(handler: WebRoute['handler']): () => void
tapIndex(transform: (html: string) => string): () => void
applyIndexTaps(html: string): string
```

> Match order is fixed: exact table first, then longest matching prefix, then the registered fallback. … a duplicate `(kind, path)` throws because route patterns are a composition-level contract and a collision is a misconfiguration.

**Real third-party example — a JSON/SSE endpoint** (`dsh-hot-reload/lib/index.js:762-796`) — note that this is the pattern to copy, including the `ctx.inject` guard:

```js
  try {
    ctx.inject(["webServer"], (webCtx) => {
      // Acquire and release in one effect, as dsh's own client-hmr channel does:
      // the disposer drops the route and every open stream when this child fiber
      // unloads — on shutdown, and before the body re-runs for a replaced server.
      webCtx.effect(() => {
        let disposeRoute;
        try {
          disposeRoute = webCtx.webServer.register({
            kind: "exact",
            path: EVENTS_ENDPOINT,
            handler: (req, res) => {
              if (req.method === "HEAD") {
                res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
                res.end();
                return;
              }
              if (req.method !== "GET") {
                res.writeHead(405);
                res.end();
                return;
              }
              res.writeHead(200, {
                "content-type": "text/event-stream",
                "cache-control": "no-cache",
                connection: "keep-alive",
              });
              res.write(": connected\n\n");
              connections.add(res);
              res.on("close", () => connections.delete(res));
            },
          });
        } catch (err) {
          log.warn?.("dsh-hot-reload: could not register the notice channel; web notices are disabled");
          log.warn?.(err);
          return () => {};
        }
        return () => {
          disposeRoute();
          for (const res of connections) {
            try { res.destroy(); } catch {}
          }
          connections.clear();
        };
      }, "dsh-hot-reload: notice channel");
    });
  } catch (err) {
```

and the browser half consumes it with a plain `EventSource` (`lib/client.js:46, 104-155`):

```js
    const EVENTS_ENDPOINT = "/dsh-hot-reload/events";
```
```js
        const connect = () => {
          const es = new EventSource(EVENTS_ENDPOINT);
```

**Real third-party example — `prefix` routes** (`dsh-better-sidebar/lib/index.js:944-945, 4232-4233, 4354-4355, 4430-4443`):

```js
        return ctx.webServer.register({
          kind: "prefix",
```
```js
      ctx.effect(() => ctx.webServer.register({
        kind: "prefix",
```
```js
      ctx.effect(() => ctx.webServer.registerUpgrade({
```

**Minimal concrete example for a settings page:**

Host (`src/index.ts`):

```ts
import type { Context } from '@deepseek-ai/cordis'

const ROUTE = '/my-plugin/state'

export const name = 'my-plugin'

export function apply(ctx: Context, config: { endpoint?: string } = {}) {
  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(() => webCtx.webServer.register({
      kind: 'exact',
      path: ROUTE,
      async handler(req, res) {
        if (req.method === 'GET') {
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ endpoint: config.endpoint ?? null }))
          return
        }
        res.writeHead(405); res.end()
      },
    }), 'my-plugin: state route')
  })
}
```

Browser (inside the factory; see §11 for the full file):

```js
      const res = await fetch('/my-plugin/state')
      const state = await res.json()
```

### 8.3 Option C: no `dsh.client` at all — inject your own script from the host half

`dsh-whale-widget` is host-only and injects a `<script>` tag by hand (`lib/index.js:3929-3946`):

```js
          disposers.push(registerRoute({
      kind: 'exact',
      path: '/dsh-whale/widget.js',
      handler: (req, res) => {
        res.writeHead(200, {
          'Content-Type': 'application/javascript; charset=utf-8',
          'Cache-Control': 'no-store',
        })
        res.end(loadWidgetJs())
      },
    }))

    disposers.push(ctx.webServer.tapIndex((html) => {
      if (html.indexOf('/dsh-whale/widget.js') !== -1) return html
      const tag = '<script defer src="/dsh-whale/widget.js"></script>'
      if (html.indexOf('</body>') !== -1) return html.replace('</body>', tag + '</body>')
      return html + tag
    }))
```

Its own comment (`lib/index.js:3948-3955`) records the important limitation: *"the desktop shell's index.html is read straight off disk from the install package (`dsh-app://app/`), never through the host's `renderIndex()`, so the `tapIndex` above does not take effect on desktop"* — the only desktop channel is the structured `webserver/index-inject` row. **Use `dsh.client` instead**; that path works on desktop too, because `dsh-client-modules` taps the index through the host webserver, and the desktop shell requests `/plugins/<id>/client.js` over HTTP.

### 8.4 Option D: reuse an already-mounted wire face

`ctx.get('connection').api` is the first-party `IApiClient` (an object of domain controllers). Real third-party usage of an ambient face is unusual, but first-party settings code does exactly this (`packages/client/ui-settings/src/client/settings-scope.ts:119-133`):

```ts
        response = await this.api.settings.mutate({
          ns: this.spec.namespace,
          ops: [op],
          ...(revision === undefined ? {} : { expectedRevision: revision }),
        })
```

`ctx.remote.$on('<forwarded-event>', listener)` is the one generic subscription channel a plugin *can* use without generating anything — but the event name must be on the Host assembly's allowlist (`packages/api/remotes/src/remote-events.ts`), so it is closed to third-party additions too.

**Recommendation: Option B (own `webServer` route).** It is version-stable, needs no generator, and is proven by three real third-party plugins in this very profile.

---

## 9. Styling tokens

`docs/web-styling.md:9-21`:

> [`ui-theme`] owns the `--dsw-*` static scale, semantic aliases, typography, motion, gradients, shadows, scrollbar styles, and light/dark preference. [`ui-layout`] applies the resolved theme snapshot to the document. Feature packages consume semantic aliases and do not define another global theme.
>
> ## Component rules
>
> - Use CSS Modules and `clsx`; do not add a component library or Tailwind.
> - Use `--dsw-alias-*` semantic tokens in feature components. Do not copy static palette values or write literal colors there.
> - Keep theme selectors out of feature component CSS. Light/dark overrides belong to the theme owner.
> - Pair font sizes with line heights and use the theme typography variables when an existing role matches.
> - Keep source text, terminal output, and diff lines unwrapped when their component contract requires column preservation; use the shared scrollbar styles rather than component-specific scrollbar selectors.
> - Put presentation in CSS. Inline React styles may pass component-local custom-property values but must not encode theme branches.
> - Preserve keyboard focus visibility and reduced-motion behavior when adding transitions or hover-only controls.

Token definitions live in `packages/client/ui-theme/src/styles/` — `design-platform.css` (static scale), `gradient-shadow-text.css` (aliases, gradients, shadows, typography), `scrollbar.css`, `shiki.css`, `base.css`.

### 9.1 Concrete token names a plugin can safely use

**Semantic aliases — colours (the recommended set; both light and dark are defined for every one):**

```
--dsw-alias-bg-base               --dsw-alias-bg-layer-1
--dsw-alias-bg-layer-2            --dsw-alias-bg-layer-3
--dsw-alias-bg-overlay            --dsw-alias-bg-module-platform
--dsw-alias-bg-skeleton           --dsw-alias-bg-multi-select
--dsw-alias-bg-mask-1             --dsw-alias-bg-mask-2
--dsw-alias-bg-mask-3             --dsw-alias-bg-mask-drop
--dsw-alias-bg-mask-photo

--dsw-alias-border-l1             --dsw-alias-border-l2
--dsw-alias-border-l3             --dsw-alias-border-l4
--dsw-alias-border-l2-darkmode-thin
--dsw-alias-border-inverted       --dsw-alias-border-inverted2

--dsw-alias-label-primary         --dsw-alias-label-secondary
--dsw-alias-label-tertiary        --dsw-alias-label-caption
--dsw-alias-label-dimmed          --dsw-alias-label-primary-dimmed
--dsw-alias-label-primary-bluish  --dsw-alias-label-primary-inverted
--dsw-alias-label-primary-foreground

--dsw-alias-brand-primary         --dsw-alias-brand-primary-invert
--dsw-alias-brand-text

--dsw-alias-button-primary-fill    --dsw-alias-button-primary-hover
--dsw-alias-button-primary-dimmed  --dsw-alias-button-ghost-active-fill
--dsw-alias-button-ghost-active-hover --dsw-alias-button-ghost-active-border
--dsw-alias-button-elevated-fill   --dsw-alias-button-floating-fill
--dsw-alias-button-floating-hover  --dsw-alias-button-contrast-fill
--dsw-alias-button-info-fill       --dsw-alias-button-info-hover
--dsw-alias-button-tool-bar-fill   --dsw-alias-button-tool-bar-hover
--dsw-alias-button-tool-bar-fill-invisible

--dsw-alias-interactive-bg-hover        --dsw-alias-interactive-bg-active
--dsw-alias-interactive-bg-hover-solid  --dsw-alias-interactive-bg-hover-accent
--dsw-alias-interactive-bg-hover-danger

--dsw-alias-state-business-primary   --dsw-alias-state-business-tertiary
--dsw-alias-state-success-primary    --dsw-alias-state-success-secondary
--dsw-alias-state-success-tertiary
--dsw-alias-state-warn-primary       --dsw-alias-state-warn-secondary
--dsw-alias-state-warn-tertiary      --dsw-alias-state-warn-label
--dsw-alias-state-error-primary      --dsw-alias-state-error-secondary

--dsw-alias-markdown-inline-code     --dsw-alias-markdown-code-block
--dsw-alias-markdown-code-block-banner
--dsw-alias-markdown-code-segment-selected
--dsw-alias-markdown-code-segment-unselected
--dsw-alias-markdown-citation        --dsw-alias-markdown-tag
--dsw-alias-markdown-placeholder
--dsw-alias-toast-bg                 --dsw-alias-tooltip-bg
--dsw-alias-scrollbar-bg-l1          --dsw-alias-scrollbar-hover-l1
--dsw-alias-scrollbar-bg-l2          --dsw-alias-scrollbar-hover-l2
```

**`--dsw-specific-*`** (domain-specific but stable): `--dsw-specific-sidebar-fill`, `--dsw-specific-sidebar-nav-item-hover`, `--dsw-specific-sidebar-nav-item-active`, `--dsw-specific-sidebar-nav-item-active-accent`, `--dsw-specific-input-major`, `--dsw-specific-selector`, `--dsw-specific-menu`, `--dsw-specific-tip`, `--dsw-specific-bubble`, `--dsw-specific-bubble-highlight`, `--dsw-specific-login-input`.

**Typography** — pair the shorthand with a role, or use the sub-properties:

```
--dsw-font-family
--dsw-font-xl-24            (+ -font-family, -font-size, -font-weight, -line-height, -font-style)
--dsw-font-l-20
--dsw-font-m-18
--dsw-font-base-16          --dsw-font-base-strong-16
--dsw-font-s-14             --dsw-font-s-strong-14
--dsw-font-xs-13            --dsw-font-xs-strong-13
--dsw-font-xxs-12           --dsw-font-xxs-strong-12
--dsw-font-xxxs-11          --dsw-font-xxxs-strong-11
--dsw-font-markdown-base / -small / -h1..-h4 / -table / -table-head / -code / -code-block / -code-block-small
```

**Elevation / motion / misc:** `--dsw-shadow-lv1`, `--dsw-shadow-lv1-blur`, `--dsw-shadow-lv2`, `--dsw-shadow-lv3`, `--dsw-mask-blur`, `--dsw-linear-gradient-think`, `--dsw-linear-think-select`.

**Static palette** (only if a semantic alias genuinely does not exist): `--dsw-static-{neutral,neutral-bluish,deepseek,blue,green,amber,red}-<step>`, e.g. `--dsw-static-deepseek-500`, `--dsw-static-neutral-bluish-950`.

**Focus ring:** feature CSS in the shipped packages references `--dsw-focus-ring-width` and `--dsw-focus-ring-color` **with a fallback**, e.g. from the built `ui-settings-plugins` CSS:

```css
outline: var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));
outline-offset: 2px;
```

I found no definition of `--dsw-focus-ring-*` in `packages/client/ui-theme/src/styles/` or `apps/web`. Copy the **fallback form** rather than assuming the token exists.

A real example of a plugin's own section CSS, from the built `dsh-client-ui-settings-plugins/lib/client.js:11` (the palette-free, alias-only convention):

```css
.section { max-width: 760px; color: var(--dsw-alias-label-primary); flex-direction: column; gap: 12px; display: flex }
.heading { margin: 0; font-size: 18px; font-weight: 600 }
.intro   { color: var(--dsw-alias-label-tertiary); margin: 0; font-size: 13px }
.tabs    { border-bottom: .5px solid var(--dsw-alias-border-l2); align-items: flex-end; gap: 22px; margin-top: 2px; display: flex }
.tab     { color: var(--dsw-alias-label-tertiary); font: inherit; cursor: pointer; background: 0 0; border: 0; padding: 7px 1px 9px; font-size: 13px; line-height: 20px; position: relative }
```

Since a third-party plugin has no CSS-Modules compiler unless it builds, the simplest styling route is to append a `<style data-plugin="<id>">` tag yourself at factory time, or write inline `style` objects using only `var(--dsw-*)` values. Class-name collisions are the reason to prefer a `data-plugin`-scoped style tag or a unique prefix.

**Product copy:** `packages/client/AGENTS.md:69` — *"Product copy is Chinese; code comments are English."*

---

## 10. Config persistence options

### 10.1 Option 1 — `ctx.settings` (host) + `ctx.settingsScope` (client)

This is the sanctioned "user-editable subset" path. `docs/subsystems/settings.md:5`:

> The user-settings seam of [dsh-settings] holds one user-owned document of per-namespace sections and resolves each registered namespace as schema defaults, then the registrant's composition `base`, then the user section. … **Composition config stays in `cordis.yml` — a namespace carries only the user-editable subset.**

**Host — the one-liner for a plugin that already has a `cordis.yml` entry** (`docs/cookbook/adding-a-settings-card.md:11-41`):

```ts
import type { Context } from '@deepseek-ai/cordis'
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
import z from '@deepseek-ai/schemastery'

declare function assertReachable(endpoint: string | undefined): void
declare function rebuildFromSettings(config: Config): void

export const MY_PLUGIN_NS = settingsNamespace('my-plugin')

export interface Config {
  endpoint?: string
  retries?: number
}

export const Config: z<Config> = z.object({
  endpoint: z.string(),
  retries: z.number().step(1).min(0).default(3),
})

export function apply(ctx: Context, config: Config) {
  let source = () => config
  installSettingsSection(ctx, MY_PLUGIN_NS, Config, config, {
    // Constraints the schema cannot express refuse the write, not the next use.
    validate: value => void assertReachable(value.endpoint),
    setSource: (current) => { source = current },
    onChange: () => { rebuildFromSettings(source()) },
  })
}
```

The helper's implementation (`packages/settings/settings/src/index.ts:863-897`):

```ts
export function installSettingsSection<T>(
  ctx: Context,
  ns: SettingsNamespace,
  schema: z<T>,
  entry: T,
  hooks: SettingsSectionHooks<T>,
): void {
  ctx.inject(['settings'], (sctx) => {
    const scope = sctx.settings.register(ns, schema, {
      base: entry,
      ...hooks.validate === undefined ? {} : { validate: hooks.validate },
    })
    hooks.setSource(() => scope.get())
    sctx.effect(() => () => {
      // This disposer runs for two different reasons. A settings provider
      // detaching leaves the consumer running, so it must fall back to its
      // composition entry and re-judge what it derived. …
      if (isUnloading(ctx)) return
      hooks.setSource(() => entry)
      hooks.onChange()
    })
    hooks.onChange()
    scope.watch(() => {
      if (isUnloading(ctx)) return
      hooks.onChange()
    })
  })
}
```

Namespace id rules (`packages/settings/settings/src/index.ts:26`): `settingsNamespace(value)` validates **lowercase kebab-case**. `role('secret')` on a schema field keeps its value off every response (`adding-a-settings-card.md:44`).

**Owner scope** (`docs/subsystems/settings.md:67-93`):

```ts
interface SettingsScope<T> {
  /** Current resolved value: schema defaults, then `base`, then the user layer. */
  get(): T
  watch(callback: (next: T, prev: T) => void | Promise<void>): () => void
  update(patch: object): Promise<void>
  replace(section: object): Promise<void>
}
```

**Client** — `ctx.settingsScope`, provided by `packages/client/ui-settings` (`src/client/index.ts:33-35`):

```ts
export function apply(ctx: ClientContext): void {
  new SettingsScopeBinder(ctx)
}
```

Bind + read + write (`packages/client/ui-settings/src/client/settings-scope.ts:235-269`):

```ts
  /**
   * Bind one namespace scope to settings and connection invalidations on the
   * CALLER's plugin lifecycle — the service proxy binds `this.ctx` to the
   * caller at call time, so the scope's disposer belongs to the calling fiber.
   * … The caller injects `connection` for the transport and `remote` for the
   * forwarded settings invalidation.
   */
  bind<T>(spec: SettingsScopeSpec<T>): SettingsScope<T> {
    const ctx = this.ctx
    const connection = ctx.get('connection') as ConnectionHandle
    const controller = new SettingsScopeController<T>(
      connection.api,
      spec,
      connection.isLoopback ? 'host' : 'memory',
    )
    ctx.effect(() => {
      const refresh = (namespace?: string): void => {
        if (namespace !== undefined && namespace !== spec.namespace) return
        void controller.load()
      }
      const disposers = [
        (ctx.get('remote') as Context['remote']).$on('settings/document-updated', refresh),
        ctx.on('connection/reset', () => { refresh() }),
      ]
      void controller.load()
      return async () => {
        for (const dispose of disposers) dispose()
        await controller.dispose()
      }
    }, `ui-settings: ${spec.namespace} settings scope`)
    return controller
  }
```

Write path (`settings-scope.ts:100-136`) — `set(field, value)` / `unset(field)` go over the wire as `settings.mutate({ ns, ops, expectedRevision })`:

```ts
  set(field: string, value: unknown): Promise<void> {
    return this.write({ op: 'set', path: [field], value })
  }

  unset(field: string): Promise<void> {
    return this.write({ op: 'unset', path: [field] })
  }

  private write(op: SettingsPathOpView): Promise<void> {
    this.readGeneration += 1
    const generation = ++this.writeGeneration
    return this.enqueue(async () => {
      const revision = this.getSnapshot().revision
      let response: Awaited<ReturnType<SettingsFace['settings']['mutate']>>
      try {
        response = await this.api.settings.mutate({
          ns: this.spec.namespace,
          ops: [op],
          ...(revision === undefined ? {} : { expectedRevision: revision }),
        })
      } catch (_settingsWriteFailure) {
        if (!this.disposed && generation === this.writeGeneration) await this.read(++this.readGeneration)
        return
      }
      if (!response.result.ok) {
        if (!this.disposed && generation === this.writeGeneration) await this.read(++this.readGeneration)
        return
      }
      this.accept(response.result.value, generation === this.writeGeneration)
    })
  }
```

The snapshot shape (`SettingsScopeSnapshot<T>`) carries `status` (`loading` | `ready` | `unavailable`), `value`, `base`, `user`, `revision`, `writable`, `mode`. Field-level override detection uses **key presence in `user`** (`adding-a-settings-card.md:70`).

**Prerequisites** (both are in-box and mounted by default in this profile):

- Host: `@deepseek-ai/dsh-settings` + a provider such as `@deepseek-ai/dsh-settings-file` (the profile has `dsh-settings-file` in `profiles/node_modules`, and `settings.yaml.imported` in `$DSH_HOME`).
- Client: `@deepseek-ai/dsh-api-settings-controller` (`cordis.yml` id `settings-controller`) so `connection.api.settings` exists; and `@deepseek-ai/dsh-client-ui-settings` so `ctx.settingsScope` exists.

Minimal client code:

```ts
export const inject = ['slots', 'locale', 'connection', 'remote', 'settingsScope']

export function apply(ctx: ClientContext): void {
  const scope = ctx.settingsScope.bind({ namespace: 'my-plugin' })
  const useScope = bindSnapshotSelector(scope)          // or scope.subscribe in your own store
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'my-plugin',
    order: 100,
    label: () => 'My Plugin',
    inject: () => ({ scope, useScope }),
  }, MySection))
  void scope.load()
}
```

### 10.2 Option 2 — `ctx.configEditor` (persist the raw Loader entry config)

**Availability: `0.2.0-rc.2` only.** `@deepseek-ai/dsh-config-editor` does not exist in the `0.1.0-rc.7` checkout (`grep configEditor` across the checkout returns nothing). It is present in the running desktop runtime and mounted by the live `cordis.yml`:

```yaml
- id: config-editor
  name: '@deepseek-ai/dsh-config-editor'
  disabled: !!js '!ctx.get(''profileContext'')'
```

Its README (`app.asar → dsh/node_modules/@deepseek-ai/dsh-config-editor/README.md:12, 26-33, 69-71`):

> Save plugin configuration in the active profile's patch and apply it immediately. Writes validate the complete candidate before touching disk and serialize with profile changes and HMR. Invalid values and higher-layer overrides leave the file unchanged.
>
> Mount this service in a profile application with Loader and `profileContext`. It has no configuration fields.
> …
> Use [settings] for forms restricted to live fields. Callers that edit complete configuration can use `ctx.configEditor.edit()`; ordinary fields retain Loader's normal lifecycle.
> …
> - Edits target the active profile patch. Home patches and command-line overlays are read for precedence but are not write targets.
> - A complete config override preserves ordinary fields but pins their current raw values at the profile layer.
> - **Only uniquely addressed entries owned by the profile's root Include are editable.**

The service (`app.asar → …/dsh-config-editor/lib/index.js:15-83`, de-minified excerpt):

```js
/** Persist complete raw configs and apply them through the normal Loader path. */
var ConfigEditor = class extends Service {
	ownerContext;
	static inject = ["loader", "profileContext"];
	constructor(ownerContext) {
		super(ownerContext, "configEditor");
		this.ownerContext = ownerContext;
	}
	/** The profile patch edited by this service. */
	get documentPath() {
		return this.ownerContext.profileContext.patchPath;
	}
	/** Addressable profile rows; nested Includes have independent configuration ownership.
	* @returns Active entries with unique profile patch ids.
	*/
	entries() {
		const candidates = [...this.ownerContext.loader.entries()].filter((entry) => entry.parent.tree.ctx.fiber.entry?.id === "include");
		const counts = /* @__PURE__ */ new Map();
		for (const entry of candidates) counts.set(entry.options.id, (counts.get(entry.options.id) ?? 0) + 1);
		return candidates.filter((entry) => counts.get(entry.options.id) === 1);
	}
	/** Read inherited and explicit profile values for the active entries. */
	configuration() { ... }
	inherited(entry, loaded) { ... }
	/** Validate, persist, and reconcile a plugin's next config; ordinary fields keep normal lifecycle rules.
	* @param entry Current Loader entry, also used to detect replacement during the write.
	* @param change Derive a raw config from the current entry and its inherited layer.
	* @returns Fulfillment after Loader reconciliation completes.
	*/
	async edit(entry, change) {
		const run = async () => {
			const path = this.documentPath;
			await withFileLock(join(this.ownerContext.profileContext.dir, "package.json"), async () => {
				if (!this.entries().includes(entry) || entry.fiber === void 0) throw new Error("Configuration entry is no longer available");
				const beforePatches = readProfilePatches("dsh", this.ownerContext.profileContext);
				await reconcileProfilePatches(this.ownerContext.root, beforePatches, "dsh");
				if (!this.entries().includes(entry)) throw new Error("Configuration entry changed during reload");
				const current = structuredClone(entry.options.config ?? {});
				const inherited = this.inherited(entry, loadProfileDirectory("dsh", this.ownerContext.profileContext.dir, this.ownerContext.profileContext.installAnchor));
				const next = change(current, inherited);
				const fiber = entry.fiber;
				if (fiber.state !== 2) throw new Error("Configuration plugin is no longer active");
				const resolved = fiber.ctx.waterfall(fiber, "internal/config", next, () => next);
				resolveConfig(fiber.runtime, resolved);
				...
```

**Can a third-party plugin use it?** Yes, with constraints:

1. You need `ctx.configEditor` — inject it: `export const inject = ['configEditor']` (or `ctx.inject(['configEditor'], ...)` so the plugin still loads on `0.1.0-rc.7`/headless where the service does not exist).
2. The service's own static `inject` is `['loader','profileContext']`, so it is only present in a **profile boot**.
3. You must obtain your own Loader entry and be *uniquely addressed* under the root Include. Since your bundle's `cordis.patch.yml` inserts a row with an explicit `id`, and no other row reuses it, `entries()` will include it. Recovering the entry is a lookup over `ctx.loader.entries()` by id/name, then passing it to `edit(entry, (current, inherited) => nextConfig)`.
4. The write target is the **profile's** `cordis.patch.yml` (`documentPath` = `profileContext.patchPath`) — not your package's own patch. So the persisted override lives next to the user's own layer and wins over your bundle defaults.
5. Rollback is inherent: `edit` snapshots the document, validates the whole candidate, and restores the prior document + reloads prior patches if reconciliation fails. Its own README: *"A failed reconciliation restores the prior document and reloads the prior patches."*

**Which to choose?**

| | `ctx.settings` | `ctx.configEditor` |
|---|---|---|
| Storage | the user settings document (`settings.yaml`) | the profile's `cordis.patch.yml` |
| Shape | a schema-declared **subset**, layered over composition `base` | the **complete raw `config`** of one Loader entry |
| UI integration | rendered by the Plugins config tab / `settingsScope` | rendered by whatever you write; applied through the real Loader path |
| Availability | 0.1.0-rc.7 **and** 0.2.0-rc.2 | **0.2.0-rc.2 only** |
| Cross-version risk | low | high (service may be absent) |
| Applies | live (or `applies: 'restart'`) | whatever the Loader does on reconciliation (usually live via HMR) |

For a settings page that must work on the widest range of DSH versions, use `ctx.settings` + `ctx.settingsScope`. Use `ctx.configEditor` only when you must edit fields the settings schema cannot express, and guard it behind `ctx.inject`.

---

## 11. Minimal end-to-end skeleton (annotated)

Goal: a package `dsh-my-plugin` that (a) mounts through a bundle patch, (b) adds a **My Plugin** page to Settings, and (c) reads/writes one persisted preference via `ctx.settings` + own HTTP route for extra state. **No build step.**

```
dsh-my-plugin/
├── package.json
├── cordis.patch.yml
├── lib/
│   ├── index.js          # host half, ESM
│   └── client.js         # browser half, hand-written classic script (CJS factory)
└── README.md
```

### `package.json`

```json
{
  "name": "dsh-my-plugin",
  "version": "0.1.0",
  "type": "module",
  "main": "lib/index.js",
  "exports": {
    ".": "./lib/index.js",
    "./client": "./lib/client.js",
    "./cordis.patch.yml": "./cordis.patch.yml",
    "./package.json": "./package.json"
  },
  "files": ["lib", "cordis.patch.yml", "README.md"],
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": { "platform": "web" }
  }
}
```

*`dsh.bundle.patch` is what makes `dsh plugin add dsh-my-plugin` append the package to `dsh.profile.bundles` (`apps/cli/src/plugin.ts:36-45, 66-69`).* `dsh.client.platform` is what makes `clientModules` scan the row (`packages/client/modules/src/index.ts:109-129`). `exports["./client"]` is where the bundle is read from (`:132-142`). No `peerDependencies` are needed because the client half requires nothing but platform seed words and the host half imports nothing.

### `cordis.patch.yml`

```yaml
# Mounted when a profile lists this bundle in dsh.profile.bundles.
# Layer order: this patch is applied in bundle-list order; the profile's own
# cordis.patch.yml and $DSH_HOME/cordis.patch.yml win over it.
- insert:
    - id: my-plugin
      name: 'dsh-my-plugin'
      # Users can override any of these from their profile layer, e.g.
      #   - id: my-plugin
      #     config: { greeting: '你好' }
      # config:
      #   greeting: 'Hello'
```

*The row's `id` must be unique across all layers — `ctx.configEditor.entries()` and the plugin-manager's enable/disable both address rows by `id` (`profile.ts:320-338`; plugin-manager README:40).*

### `lib/index.js` — the host half (ESM, plain JS)

```js
// Host half: registers a durable settings namespace and serves one JSON route
// the browser half reads. Plain ESM; no dependencies on @deepseek-ai/*.

/** Cordis plugin name (diagnostics, loader patch targeting). */
export const name = 'my-plugin'

/** The settings namespace. Lowercase kebab-case is validated by settingsNamespace(). */
export const MY_NS = 'my-plugin'

/** Route the browser half fetches. Must match the constant in lib/client.js —
 *  the two halves ship separately and share no module. */
const STATE_ROUTE = '/my-plugin/state'

// ---- Composition config (cordis.yml / the bundle patch) --------------------
// A schemastery-typed Config is optional. export const Config = z.object({...})
// would give the entry a validated `config:` block. Here we accept a plain
// object so the package needs no @deepseek-ai/schemastery dependency.

export function apply(ctx, config = {}) {
  const log = ctx.logger ?? console
  const greeting = String(config.greeting ?? 'Hello')

  // 1) Persisted, user-editable preference.
  //    ctx.settings may be absent (headless / no provider): ctx.inject keeps
  //    this plugin alive and only parks the child fiber.
  ctx.inject(['settings'], (sctx) => {
    const scope = sctx.settings.register(MY_NS, MY_NS_SCHEMA, { base: { greeting } })
    // scope.get() is the resolved value; scope.watch(cb) observes commits.
    log.info?.(`my-plugin: greeting = ${JSON.stringify(scope.get().greeting)}`)
  })

  // 2) A plain HTTP route for state the settings schema does not model.
  //    webServer is optional too; ctx.inject re-runs if a replaced server
  //    comes back (see dsh-hot-reload/lib/index.js:747-760 for why ctx.get
  //    and module-level `inject` are both wrong here).
  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(() => webCtx.webServer.register({
      kind: 'exact',
      path: STATE_ROUTE,
      handler(req, res) {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          res.writeHead(405)
          res.end()
          return
        }
        const body = JSON.stringify({ greeting, pid: process.pid })
        res.writeHead(200, {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
          'content-length': Buffer.byteLength(body),
        })
        res.end(req.method === 'HEAD' ? undefined : body)
      },
    }), 'my-plugin: state route')
  })
}

// A schemastery schema is the canonical form; this minimal hand-written object
// stands in when @deepseek-ai/schemastery is not a dependency. With schemastery:
//   import z from '@deepseek-ai/schemastery'
//   const MY_NS_SCHEMA = z.object({ greeting: z.string().default('Hello') })
const MY_NS_SCHEMA = {
  // schemastery schema surface: toJSON() drives the rendered form; a plain
  // object with a `default` per key is accepted by the shipped settings service
  // only if you also pass `base`. Prefer the real schemastery schema.
}
```

> ⚠️ **Do add `@deepseek-ai/schemastery` as a real dependency** (`"dependencies": { "@deepseek-ai/schemastery": "^3.18.1" }`) and use `z.object({...})` — `installSettingsSection` and `ctx.settings.register` are typed on `z<T>`, and the Plugins config tab rehydrates the schema to render inputs (`packages/client/ui-settings/src/client/settings-scope.ts:197-211`). The hand-written stand-in above only illustrates where the schema sits.

With schemastery, the registration becomes:

```js
import z from '@deepseek-ai/schemastery'
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'

const NS = settingsNamespace('my-plugin')
const Schema = z.object({ greeting: z.string().default('Hello') })

export function apply(ctx, config = {}) {
  let source = () => config
  installSettingsSection(ctx, NS, Schema, config, {
    setSource: (current) => { source = current },
    onChange: () => { /* re-derive anything built from source() */ },
  })
}
```

### `lib/client.js` — the browser half (hand-written, no build)

```js
// dsh-my-plugin — web half.
//
// Hand-written in the shape a built client bundle takes (same as
// dsh-hot-reload/lib/client.js): a classic script that REGISTERS a factory with
// the browser module loader. Consequences:
//   - no `import`/`export` and no JSX (React.createElement instead): the factory
//     takes a synchronous `require` and RETURNS its exports;
//   - only platform seed words may be required: react, react/jsx-runtime,
//     react-dom, react-dom/client, @deepseek-ai/cordis, and
//     @deepseek-ai/dsh-client-{ui-slots,web-react,ui-primitives,ui-attachment,
//     schema-form};
//   - `id` MUST be the package name (the loader resolves "<id>/client" and the
//     bare id to the same exports);
//   - a throw at factory scope costs the whole page: the shell fails its boot
//     if an entry never activates, so guard every require.

window.__ModuleLoader__.load({
  id: "dsh-my-plugin",
  factory: (require) => {
    // Guarded requires: degrade to a no-op plugin rather than killing the page.
    let React = null
    let seedError = null
    try {
      React = require("react")
      // Optional in-box primitives; absent on some builds.
      // var primitives = require("@deepseek-ai/dsh-client-ui-primitives")
    } catch (error) {
      seedError = error
    }

    /** Must match STATE_ROUTE in lib/index.js (the halves share no module). */
    const STATE_ROUTE = "/my-plugin/state"

    /** The list slot owned by ui-settings-general; see
     *  packages/client/ui-settings/src/client/contract/slots.ts:53. */
    const SLOT = "settings.section"

    /** Cordis plugin name. */
    const name = "dsh-my-plugin"

    /**
     * Required CLIENT services, by cordis service KEY (not package name).
     *   slots          - the slot registry (required to register into SLOT)
     *   locale         - ctx.locale.register / ctx.locale.bind, for copy
     *   connection     - the wire handle (its .api carries the shipped faces)
     *   remote         - ctx.remote.$on for forwarded invalidations
     *   settingsScope  - provided by in-box dsh-client-ui-settings; binds a
     *                    namespace scope to the Host settings transport
     * Declaring these by name is the ONLY sanctioned way to reach another
     * plugin: a value import would fail the client bundle purity gate.
     */
    const inject = ["slots", "locale", "connection", "remote", "settingsScope"]

    /** Copy namespace owned by this plugin. ctx.locale.register(NS, dict) and
     *  locale: NS at register give the component a typed `t` seat. */
    const NS = "myPlugin"
    const dict = {
      zh: { nav: "我的插件", title: "我的插件", intro: "示例设置页。", greeting: "问候语" },
      en: { nav: "My Plugin", title: "My Plugin", intro: "An example settings page.", greeting: "Greeting" },
    }

    /**
     * The section component. Props received:
     *   close        - SettingsSectionOwnerProps (the one shell affordance)
     *   useSessions, useWorkspaces - GlobalStandardProps from client-runtime
     *   t            - because `locale: NS` was declared
     *   scope, useScope, api - from this plugin's inject factory
     * No ctx, no services, no subscription machinery: plain data + callbacks.
     */
    function MySection(props) {
      const { t, close, useScope, scope } = props
      const snapshot = useScope((value) => value) // uSES selector hook
      const [state, setState] = React.useState(null)
      const [error, setError] = React.useState(null)

      React.useEffect(() => {
        let cancelled = false
        fetch(STATE_ROUTE, { headers: { accept: "application/json" } })
          .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
          .then((value) => { if (!cancelled) setState(value) })
          .catch((err) => { if (!cancelled) setError(String(err && err.message || err)) })
        return () => { cancelled = true }
      }, [])

      const greeting = snapshot && snapshot.value ? snapshot.value.greeting : undefined

      return React.createElement("div", { style: sectionStyle },
        React.createElement("h2", { style: headingStyle }, t("title")),
        React.createElement("p", { style: introStyle }, t("intro")),
        React.createElement("label", { style: rowStyle },
          React.createElement("span", null, t("greeting")),
          React.createElement("input", {
            type: "text",
            value: greeting === undefined ? "" : greeting,
            disabled: !snapshot || snapshot.status !== "ready" || !snapshot.writable,
            onChange: (event) => { void scope.set("greeting", event.target.value) },
          }),
        ),
        React.createElement("p", { style: captionStyle },
          error !== null ? `state: ${error}` : `host pid: ${state ? state.pid : "…"}`),
      )
    }

    // Inline styles may pass component-local values but must not encode theme
    // branches (docs/web-styling.md:20). Colours come only from --dsw-* aliases.
    const sectionStyle = { display: "flex", flexDirection: "column", gap: "12px", maxWidth: "760px",
      color: "var(--dsw-alias-label-primary)" }
    const headingStyle = { margin: 0, fontSize: "18px", fontWeight: 600 }
    const introStyle = { margin: 0, fontSize: "13px", color: "var(--dsw-alias-label-tertiary)" }
    const rowStyle = { display: "flex", gap: "8px", alignItems: "center", fontSize: "13px" }
    const captionStyle = { margin: 0, fontSize: "12px", color: "var(--dsw-alias-label-caption)" }

    /**
     * Client plugin body.
     * @param ctx - client root context (apply world only; components never see it).
     */
    function apply(ctx) {
      if (seedError !== null) {
        ctx.logger?.warn?.("dsh-my-plugin: a platform module is unavailable — settings page disabled")
        ctx.logger?.warn?.(seedError)
        return
      }

      // 1) Copy dictionaries (an effect on this plugin's fiber).
      ctx.effect(() => ctx.locale.register(NS, dict), "dsh-my-plugin: dictionaries")
      const t = ctx.locale.bind(NS)

      // 2) Bind the settings namespace scope. The service proxy binds `this.ctx`
      //    to THIS caller at call time, so the disposer belongs to our fiber.
      const scope = ctx.settingsScope.bind({ namespace: "my-plugin" })
      const useScope = ctx.get("connection").api // placeholder; see note below
      void scope.load()

      // 3) Register the page. slots.inject waits for the declaration, removes
      //    the contribution when it collapses, and disposes with this fiber.
      //    A bare register into an undeclared slot throws — always use inject.
      ctx.slots.inject(SLOT, () => {
        try {
          return ctx.slots.register({
            name: SLOT,
            id: "my-plugin",
            order: 100,
            label: () => t("nav"),
            locale: NS,
            inject: () => ({ scope, useScope, t }),
          }, MySection)
        } catch (error) {
          ctx.logger?.warn?.("dsh-my-plugin: could not mount the settings page")
          ctx.logger?.warn?.(error)
          return () => {}
        }
      })
    }

    // The loader takes the factory's return value AS the module exports.
    return { apply, inject, name }
  },
})
```

**Note on `useScope`.** `bindSnapshotSelector` lives in `@deepseek-ai/dsh-client-web-react`, which *is* a platform seed word — so within the factory you can do:

```js
const webReact = require("@deepseek-ai/dsh-client-web-react")
const useScope = webReact.bindSnapshotSelector(scope)
```

If you would rather not depend on that helper, build the selector yourself with `React.useSyncExternalStore(scope.subscribe, scope.getSnapshot)` and pass the resulting values as plain data (the component then holds no subscription machinery of its own — matching `packages/client/AGENTS.md:24`).

### Enabling it in the live profile

```sh
dsh plugin --profile desktop add ./dsh-my-plugin
# or from a registry:
dsh plugin --profile desktop add dsh-my-plugin
```

That runs `pnpm add` in `C:\Users\30394\.dsh\profiles\desktop`, then appends `dsh-my-plugin` to `dsh.profile.bundles`. Boot merges the bundle's `cordis.patch.yml`, mounting the `my-plugin` row; `clientModules` then scans that row, finds `dsh.client`, and serves `lib/client.js` at `/plugins/dsh-my-plugin/client.js`. **A restart is required** for a newly added bundle (client-module package metadata is cached per name and never expires, `docs/subsystems/client-modules.md:53`).

Removal: `dsh plugin --profile desktop remove dsh-my-plugin`. To disable without uninstalling, add to the profile's `cordis.patch.yml`:

```yaml
- id: my-plugin
  disabled: true
```

---

## 12. Open questions / residual risk

1. **Exact version the live GUI is running.** The desktop app reports `desktopVersion 0.2.0-rc.2` (`resources/runtime/primary-runtime/runtime.json`) and the resolved in-box packages in `$DSH_HOME/profiles/node_modules/@deepseek-ai` are `0.2.0-rc.2`, while the provided source checkout is `0.1.0-rc.7`. I treated the checkout as the documented contract and verified every client-side claim against both. **Any slot or configEditor claim should be re-verified against the running build before shipping.**

2. **`settings.plugin.item` / `plugins.bundle.config` are absent from the running `0.2.0-rc.2` `ui-settings-plugins`.** The checkout's cookbook (`docs/cookbook/adding-a-settings-card.md`) recommends `settings.plugin.item`, and `dsh-claude-style` also targets `plugins.bundle.config`. Both `ctx.slots.inject` calls park silently when the slot is undeclared, so this failure mode is invisible. I could not determine whether these slots are declared by another live package (my scan covered only `dsh-client-ui-settings{,-general,-plugin-inventory,-plugins}` client bundles). **A live `cordis_inspect_query` on the Client `Slots` provider would settle it — my attempts timed out because no browser extension was connected.** Target `settings.section` until confirmed.

3. **`ctx.configEditor` behavioural detail beyond `edit()`.** I read the de-minified head of `lib/index.js` (through line ~90 of the emitted file) and its README; the remainder of `edit()` (document rewrite, comment/`!!js` preservation, failure restore) and any additional public methods are not fully transcribed. The README names only `edit()`, `entries()`, `configuration()`, and `documentPath`.

4. **The exact `SettingsScopeSpec<T>` shape** (`{ namespace, decode? }`) is documented in `packages/client/runtime/src/client/contract/settings-scope.ts`, which I did not open. `bind()` calls pass `{ namespace: '<ns>' }` only in every example I read (`settings-scope.ts:246-252`, `ui-settings-plugins/src/client/index.ts:63-65`).

5. **Whether the `--profile desktop` plugin-manager instance actually validates `dsh.engines.dsh`** (as `dsh-claude-style`'s manifest implies) — the plugin-manager README only describes DSH **peer dependency** compatibility and version exemptions, not `dsh.engines`. The `engines` field may be informational or consumed by a different (market) component.

6. **Origin of the `.bak-*` files** in the live profile is unattributed (see §5.3). `dshmarket` ships `lib/backup.js`, so it is the likely author, but I did not confirm.

7. **`reusable` is nowhere in this codebase's Cordis** (`vendor/cordis`, installed `@deepseek-ai/cordis@4.0.4`). If the intent behind the question was "can one package ship several independent plugin rows", the answer here is: yes, by inserting multiple rows in `cordis.patch.yml` with distinct `id`s, each pointing at a different subpath export of the same package (`@deepseek-ai/dsh-plugin-manager/tools` and `@deepseek-ai/dsh-tool-subagent-control/list-agents` in the live `cordis.yml` are real precedents).
