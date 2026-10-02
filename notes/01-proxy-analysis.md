# 01 — How DSH outbound network requests resolve proxies

Analysis date: 2026-10-02 (session workdir `<workspace>`).

Sources inspected:

- **Checkout** — `<checkout>` (git tag `dsh-v0.1.0-rc.7`).
- **Installed / running runtime** — `%APPDATA%\npm\node_modules\@deepseek-ai\dsh@0.2.0-rc.2`, reached from the profile through junctions at `%USERPROFILE%\.dsh\profiles\node_modules\@deepseek-ai\*`.
- **Desktop runtime** — `%LOCALAPPDATA%\Programs\DeepSeek Harness\resources\runtime`.
- **Live process facts** — measured with the runtime's own Node binaries (read-only probes; no environment variable of the user's shell was modified).

> ⚠️ **Read the Summary's first bullet before acting on any file:line below.** The checkout is a *newer-published-but-older-versioned* snapshot that does **not** contain the running code's proxy layer.

---

## Summary

1. **The checkout and the running runtime are different versions, and the difference is exactly this topic.** The checkout is `0.1.0-rc.7` (`package.json:2` `"version": "0.1.0-rc.7"`); the process actually serving the Web GUI runs `@deepseek-ai/dsh@0.2.0-rc.2` (`%USERPROFILE%\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh\package.json` → `name: @deepseek-ai/dsh, version: 0.2.0-rc.2`).
2. **In the checkout, DSH has *no* outbound proxy support at all.** There is no `getProxyForUrl`, no `proxy-from-env`, no `ProxyAgent`, no `EnvHttpProxyAgent`, no `setGlobalDispatcher`, no `undici` dependency anywhere in `packages/`, `apps/`, `vendor/` or `patches/`. The only code that *mentions* proxy variables deliberately **refuses** them from `.env` files (`packages/boot/app-boot/src/index.ts:111`), and `packages/llm/llm-deepseek/README.md:113` records the omission as a known limitation.
3. **In the running `0.2.0-rc.2` runtime, a dedicated, supported, process-wide seam exists**: `@deepseek-ai/dsh-http-proxy` — *"Process-wide outbound HTTP proxy policy for DeepSeek Harness: resolve it from the launch environment and install it as undici's global dispatcher"*. The launcher installs it once per profile boot, before any plugin mounts.
4. **Every in-process outbound call that uses global `fetch` is therefore already proxied** — the DeepSeek LLM adapter, the pi-ai adapter stack, web search (DeepSeek/Exa/Perplexity), `web-fetch-http`, and MCP-over-HTTP — with **no per-call-site code**.
5. **Two real exceptions exist**: (a) the OTLP telemetry exporter builds its **own `http(s).Agent`** and is *direct by design*; (b) `web-fetch-http` deliberately bypasses address pinning when a proxy is in play. Spawned children (including the `pnpm` plugin-install path and the codex/claude-code subagents) are handled through `proxyEnvironmentForChild()`.
6. **The hot-switch point is real but narrow.** The proxy policy is resolved **once at install time** from a launch-environment snapshot and captured in a closure; `process.env` is *not* read per request and Node's own `NODE_USE_ENV_PROXY` is read only at bootstrap. The supported runtime lever is to call the exported `installProxyFromEnvironment(env, report)` again (it returns a disposer) or to replace undici's global dispatcher yourself.
7. **Measured on this machine's exact runtime** (Electron-as-Node 24.18.1 + `undici@8.11.2`): `undici.setGlobalDispatcher(...)` **does** steer global `fetch`. Node's `http.setGlobalProxyFromEnv(...)` **does** re-route `node:http`/`node:https` at runtime *without* the startup flag — but it does **not** touch `fetch`. Changing `process.env.*_PROXY` alone changes nothing.
8. **A hazard is already documented in the field**: the installed third-party marketplace plugin `dshmarket` measured that `setGlobalDispatcher` from userland undici **failed** to steer global fetch on Node 25 and can corrupt Node 22's shared dispatcher symbol, so it calls undici's own `fetch` with its own per-request dispatcher instead. My own probe reproduced a request storm (2133 requests) when installing a **`undici@7.30.0`** dispatcher from the desktop profile, while **`undici@8.11.2`** (the instance the host itself uses) worked cleanly. **Use the host's undici instance, not the profile's.**

---

## 0. Runtime topology (needed to read the rest correctly)

| Fact | Evidence |
|---|---|
| Harness host process is `@deepseek-ai/dsh-desktop-host` run as Electron-as-Node | `Get-CimInstance Win32_Process` PID 11864: `"...\DeepSeek Harness.exe" --expose-internals "...\app.asar\dsh\node_modules\@deepseek-ai\dsh-desktop-host\lib\index.js" "...app.asar\dsh" "%USERPROFILE%\.dsh\profiles\desktop" "...\runtime\primary-runtime" "...\runtime\pnpm\bin\pnpm.mjs" "...\runtime\bin"` |
| Electron version | `<install>\version` = `44.0.0` |
| Node inside that process | measured: `24.18.1` (`process.versions.node`), internal undici `7.29.0` |
| Bundled standalone Node / pnpm | `<install>\resources\runtime\versions.json` → `"node": "24.21.0", "pnpm": "11.7.0"` |
| `node` shim | `<install>\resources\runtime\bin\node.cmd:1-3` → `set ELECTRON_RUN_AS_NODE=1` + `"%DSH_DESKTOP_NODE_EXECUTABLE%" --expose-internals %*` |
| Where plugins resolve from | `%USERPROFILE%\.dsh\profiles\node_modules\@deepseek-ai\<pkg>` are **junctions** into `%USERPROFILE%\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai\<pkg>` |
| User-profile-only deps (hoisted for third-party plugins) | `%USERPROFILE%\.dsh\profiles\desktop\node_modules\` contains `undici@7.30.0`, `dshmarket`, `dsh-better-sidebar`, `dsh-claude-style`, `dsh-hot-reload`, `dsh-whale-widget` |
| Mounted plugins (relevant rows) | `%USERPROFILE%\.dsh\profiles\desktop\cordis.yml` → `llm`, `llm-deepseek`, `llm-deepseek-account`, `llm-pi-ai`, `web` (`searchProvider: deepseek-official`, `fetchProvider: http`), `web-search-deepseek`, `web-fetch-http`, `tool-web`, `session-telemetry-otel`, `desktop-product-telemetry` (`@deepseek-ai/dsh-host-product-telemetry-otel`), `mcp-resources`, `subprocess`, `subagent-*` |

**Consequence:** every `file:line` from the checkout below describes `0.1.0-rc.7`, i.e. *what upstream looked like before the proxy layer landed*. Where I cite installed code I say so explicitly.

---

## 1. Env var readers

### 1.1 Checkout (`0.1.0-rc.7`) — the only proxy env reader is a *rejection* list

`packages/boot/app-boot/src/index.ts:92-114` — names no discovered `.env` file may set:

```ts
/** Exact names no discovered file may set. */
const BOOTSTRAP_NAMES = new Set([
  ...
  // Network reach and trust.
  'DEEPSEEK_BASE_URL', 'DEEPSEEK_SEARCH_BASE_URL',
  'SSL_CERT_FILE', 'SSL_CERT_DIR',
  'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY',
  'REQUESTS_CA_BUNDLE', 'CURL_CA_BUNDLE',
  'NODE_TLS_REJECT_UNAUTHORIZED',
])
```

- ``:125-128`` `isBootstrapOnly()` upper-cases the name and matches exact names + `DSH_`/`XDG_`/`DYLD_`/`BASH_FUNC_` prefixes ("匹配不区分大小写，因此 `https_proxy` 不是绕过手段").
- ``:155-162`` the loud refusal: `throw new Error(\`${binName}: ${path} sets "${name}", which only the launching environment may set\` + ' (it decides how this process starts, where its code and instructions load from, or how it reaches the network); export ${name} instead of putting it in a .env file')`.
- Tested at `packages/boot/app-boot/tests/app-boot.spec.ts:129-149`, including `['a network proxy', 'HTTPS_PROXY=http://attacker.example\n']` and the lowercase variant.
- ``:177-198`` `loadLayeredEnv()` builds the frozen `LaunchEnvironmentSnapshot` (`process` → `project-env` → `user-env`). The snapshot is the *only* sanctioned env plane; see `packages/util/launch-environment/src/index.ts:106-117` (`DSH_LAUNCH_ENVIRONMENT_KEY`, `launchEnvironmentOf(ctx)`), provided at `apps/cli/src/profile-boot.ts:252`.

There is **no other proxy-env reader in the checkout**. Concretely absent: `NODE_USE_ENV_PROXY`, `no_proxy` logic, `getProxyForUrl`, `proxy-from-env`, `EnvHttpProxyAgent`, `ProxyAgent`, `setGlobalDispatcher`, `http-proxy-agent`, `https-proxy-agent`, `node-fetch`, `axios`, `got`. (`dispatcher` matches in `packages/core/agent/src/dispatch.ts:2`, `packages/api/gateway/src/types.ts:38` and `packages/llm/llm-pi-ai/src/stream.ts:37` are the Cordis event dispatcher and an upstream-pi-ai comment — unrelated to undici.)

Documentation acknowledgement: `apps/cli/reference/README.md:84` — *"The process inherits the launch environment; set `NODE_USE_ENV_PROXY=1` when a supporting Node version must honor `HTTP_PROXY` and `HTTPS_PROXY`."* The same sentence appears in `.agents/notes/implemented/simplification/2026-08-10-source-run-without-managed-installer.md:15`. This is the **whole** of `0.1.0-rc.7`'s proxy story: "let Node do it".

### 1.2 Running runtime (`0.2.0-rc.2`) — `@deepseek-ai/dsh-http-proxy`

`%USERPROFILE%\.dsh\profiles\node_modules\@deepseek-ai\dsh-http-proxy\package.json`:

```json
"name": "@deepseek-ai/dsh-http-proxy",
"description": "Process-wide outbound HTTP proxy policy for DeepSeek Harness: resolve it from the launch environment and install it as undici's global dispatcher",
"version": "0.2.0-rc.2",
"repository": { ... "directory": "packages/util/http-proxy" },
"dependencies": { "undici": "^8.10.0" }
```

It is a real dependency of the installed launcher (`@deepseek-ai/dsh@0.2.0-rc.2` dependency list contains `@deepseek-ai/dsh-http-proxy=0.2.0-rc.2`).

Compiled implementation `…\dsh-http-proxy\lib\index.js`:

- ``:19-24`` loopback bypass constant:
  ```js
  const LOOPBACK_NO_PROXY = ["localhost","127.0.0.1","::1","[::1]"];
  ```
- ``:29-43`` the env names it owns and publishes:
  ```js
  const POLICY_ENV_NAMES = { httpProxy:["http_proxy","HTTP_PROXY"], httpsProxy:["https_proxy","HTTPS_PROXY"], noProxy:["no_proxy","NO_PROXY"] };
  const PROXY_ENV_NAMES = [...Object.values(POLICY_ENV_NAMES).flat(), "all_proxy","ALL_PROXY"];
  ```
  `ALL_PROXY` is **read** as a fallback but **never written back**.
- ``:68-76`` `readEnv()` — lowercase first, uppercase fallback, blank treated as unset.
- ``:243-264`` `resolveProxyPolicy(env)` — `http = http_proxy ?? all_proxy`; `https = https_proxy ?? all_proxy ?? http`; a rejected scheme keeps that scheme **direct**; `noProxy: withLoopback(...)`.
- ``:275-280`` `proxyForUrl(policy, url)` — the single matcher shared by the dispatcher and `web-fetch-http`.
- ``:334-347`` `applyPolicyEnv()` **rewrites `process.env`** for `http_proxy/HTTP_PROXY/https_proxy/HTTPS_PROXY/no_proxy/NO_PROXY` to the resolved policy (this is why the live process env shows `NO_PROXY=localhost,127.0.0.1,::1,[::1]`, byte-identical to `LOOPBACK_NO_PROXY`).
- ``:532-534`` `clearedProxyEnv()` — one `undefined` per proxy name, for replay isolation.

Launcher install site (installed launcher): `…\@deepseek-ai\dsh\lib\profile-boot-BZ2ZjNWi.js:6` `import { installProxyFromEnvironment } from "@deepseek-ai/dsh-http-proxy";` and ``:225-227``

```js
const disposeProxy = await installProxyFromEnvironment(options.environment, (message) => {
    process.stderr.write(`${NAME}: ${message}\n`);
});
```

with ``:232`` folding `disposeProxy` into the shutdown disposal list and ``:274`` `hostCtx.provide(DSH_LAUNCH_ENVIRONMENT_KEY, options.environment)`. **It reads the launch-environment snapshot, not `process.env`.**

Documented policy (README):

- `README.md:50` — *"`http_proxy`, `https_proxy`, `no_proxy`, and `all_proxy`, lowercase first and uppercase as the fallback, with a blank value treated as unset. `ALL_PROXY` backs both schemes, and HTTPS falls back to the HTTP proxy last — neither Node nor undici derives the first of these on its own."*
- `README.md:52` — loopback is always bypassed (`localhost`, all of `127.0.0.0/8`, `::1`, `0.0.0.0`, IPv4-mapped spellings).
- `README.md:56` — unusable proxy values (SOCKS/PAC/unparseable) are *reported and skipped*, that scheme connects directly.
- `README.md:65` — *"undici's `EnvHttpProxyAgent` cannot serve here: with no `HTTPS_PROXY` present it reuses the HTTP proxy for `https:`…"* (hence the custom `Agent` factory).

### 1.3 `NODE_USE_ENV_PROXY`

- **Reference to it in source (checkout):** none. Only the CLI README (above) and the source-launch decision note.
- **Runtime consumer:** `dsh-http-proxy` *sets* it for children — `lib/index.js:495` `const overlay = { NODE_USE_ENV_PROXY: "1" };`, withheld at ``:501`` when a refused (e.g. SOCKS) value would make a child Node exit at bootstrap.
- **`NODE_USE_ENV_PROXY` in the live desktop process** is in the user's exported environment (known fact) and is *not* rewritten by the package.

### 1.4 Third-party proxy readers already installed (not DSH core)

`%USERPROFILE%\.dsh\profiles\desktop\node_modules\dshmarket\lib\net.js` resolves proxies itself, per request:

- ``:59-82`` `configuredProxy()` / `proxyFromEnv()` — reads `process.env.https_proxy ?? process.env.HTTPS_PROXY`, `http_proxy ?? HTTP_PROXY`, falling back to `npm_config_https_proxy` / `npm_config_proxy`; scheme-less `host:port` gets `http://` prefixed.
- ``:95-110`` `marketFetch()` builds/reuses `new EnvHttpProxyAgent({httpProxy, httpsProxy})` or `new Agent()`, and calls undici's **own** `fetch` with `dispatcher`.
- ``:83-132`` of `lib\dsh-cli.js` (`proxyEnvForPnpm`) translates the standard variables into `npm_config_proxy` / `npm_config_https_proxy` / `npm_config_noproxy` so that **pnpm** (npm-config-only) and **git** (standard-vars-only) both route.

---

## 2. HTTP client inventory

### 2.1 Checkout (`0.1.0-rc.7`)

Nothing in the checkout imports an HTTP client library. Every outbound request is a bare **global `fetch`** (Node's undici-backed fetch), or a third-party SDK that ends up there.

| Path (checkout) | Transport | Evidence |
|---|---|---|
| DeepSeek chat adapter | global `fetch` | `packages/llm/llm-deepseek/src/adapter.ts:305` `response = await fetch(\`${connection.baseURL}/chat/completions\`, {` |
| pi-ai model discovery | global `fetch` | `packages/llm/llm-pi-ai/src/discovery.ts:244` `response = await fetch(url, {` |
| pi-ai streaming | `@earendil-works/pi-ai` SDK → global `fetch` | `packages/llm/llm-pi-ai/src/provider.ts:22-26` `import { createProvider } from '@earendil-works/pi-ai'` … `openAICompletionsApi` / `anthropicMessagesApi` / `openAIResponsesApi` |
| `web-fetch-http` | global `fetch` | `packages/web/web-fetch-http/src/provider.ts:105` `return await fetch(url, {` |
| `web-search-deepseek` | global `fetch` POST `/messages` | `packages/web/web-search-deepseek/src/provider.ts:222` `response = await fetch(endpoint, {` |
| `web-search-exa` | global `fetch` | `packages/web/web-search-exa/src/provider.ts:101` |
| `web-search-perplexity` | global `fetch` | `packages/web/web-search-perplexity/src/provider.ts:104` |
| MCP over HTTP | MCP SDK `StreamableHTTPClientTransport` | `packages/mcp/mcp-client/src/transport.ts:11,45-48` |
| OTLP telemetry | `@opentelemetry/exporter-logs-otlp-http` → `node:http(s)` | `packages/session/session-telemetry-otel/src/index.ts:34,215` |
| SSE parsing (response side only) | `eventsource-parser/stream` | `packages/llm/llm-deepseek/src/sse.ts:14,34` |
| Browser/client side (not egress) | `globalThis.fetch` | `packages/client/connection/src/client/web-api-client.ts:15`, `.../client/rpc.ts:30`, `packages/session-query/session-log-export/src/client/controller.ts:69` |

`packages/llm/llm-deepseek/src/adapter.ts:301-302` is the explicit statement of the gap:

```ts
// TODO(http): adopt the Cordis HTTP service when shared transport configuration
// outweighs its additional runtime dependencies.
```

and `packages/llm/llm-deepseek/README.md:113`:

> - **Requests use raw `fetch`, not `@cordisjs/plugin-http`** — no shared proxy/interception configuration; adoption is deferred until a second adapter wants it (`TODO(http)`).

Also relevant to how thoroughly `fetch` is the only transport: `packages/llm/llm-deepseek/src/adapter.ts:314-317` already documents that *"fetch wraps every transport failure (DNS, refused connection, TLS, **proxy**) in a bare `TypeError: fetch failed`"* — i.e. operators already understood proxying was in play, with no code to configure it.

### 2.2 Running runtime (`0.2.0-rc.2`) — same call sites, different routing

- `…\dsh-llm-deepseek\lib\index.js:2188` `const response = await fetch(\`${messagesApiRoot(connection.baseURL)}/messages\`, {` — no `dispatcher` argument. (The `0.2.0-rc.2` adapter speaks the Messages API only: the installed bundle contains no `/chat/completions` call site, whereas the checkout's `adapter.ts:305` still does.)
- `…\dsh-web-search-deepseek\lib\index.js:132` `response = await fetch(endpoint, {` — no `dispatcher`.
- `…\dsh-llm-pi-ai\lib\index.js:2313` `response = await fetch(url, {` — no `dispatcher`.
- `…\dsh-mcp-client\lib\index.js:4,46` `import { Client, StreamableHTTPClientTransport, specTypeSchemas } from "@modelcontextprotocol/client";` / `case "streamable-http": return new StreamableHTTPClientTransport(new URL(config.url), { requestInit: { headers: config.headers } });`

**Which modules are proxy-aware (import `dsh-http-proxy`)?** Exhaustive scan of `…\profiles\node_modules\@deepseek-ai\*\lib\*.js`:

| Package | Line |
|---|---|
| `dsh` (launcher) | `lib\profile-boot-BZ2ZjNWi.js:6` |
| `dsh-subprocess` | `lib\index.js:2` `import { proxyEnvironmentForChild } from "@deepseek-ai/dsh-http-proxy";` |
| `dsh-web-fetch-http` | `lib\index.js:4` `import { proxyRouteFor } from "@deepseek-ai/dsh-http-proxy";` |

Everything else is covered *implicitly* by the process-wide global dispatcher. That is the design (`README.md:32`): *"Plain `fetch()` is proxied, and so is any SDK that reaches `globalThis.fetch` — the MCP HTTP transport and the pi-ai provider stack both do. Verify each SDK's actual transport; exceptions belong under Known Limitations."*

`dsh-subprocess\lib\index.js:53-54` is where children get the policy:

```js
for (const [name, value] of Object.entries(proxyEnvironmentForChild())) if (value === void 0) Reflect.deleteProperty(env, name);
else env[name] = value;
```

---

## 3. LLM path

**`llm-deepseek` (direct fetch adapter)**

- Checkout call site: `packages/llm/llm-deepseek/src/adapter.ts:303-310`. Connection facts arrive through a thunk resolved once per operation (`:283-299` builds the body/headers; `:287-299` headers).
- Runtime: `…\dsh-llm-deepseek\lib\index.js:2188` — plain `fetch`, **no `dispatcher`**, so it uses whatever undici global dispatcher is installed.
- **Can a dispatcher be injected?** Not through the adapter's own API. `GenerateOptions` (`packages/llm/llm/src/types.ts`) carries no transport field; the adapter signature is `abstract stream(options: GenerateOptions): AsyncIterable<StreamChunk>` (`packages/llm/llm/src/index.ts:232`). Injection must happen at the **global dispatcher** level.
- **Module-load vs per-request:** the adapter resolves *credentials and baseURL* per operation, but the *transport* is the global dispatcher, whose policy was captured at install time. In the running build the only per-request lookup is `proxyForUrl(policy, url)` inside the dispatcher factory (`dsh-http-proxy\lib\index.js:388-399`) against the **captured** `policy` object — no env read.

**`llm-pi-ai`**

- `packages/llm/llm-pi-ai/src/provider.ts:167-192` `buildProvider()` returns either the catalog provider (`reuseCatalogProvider`, `:144-159`) or `createProvider({... api: factory() })` from `@earendil-works/pi-ai`.
- Discovery probe is the only pi-ai code DSH owns: `discovery.ts:244`.
- `packages/llm/llm-pi-ai/src/stream.ts:31-38,55-58` explicitly reasons about undici: *"undici carries the actionable transport detail on `cause` (e.g. `SocketError: other side closed`) but hands the fetch wrapper a bare `terminated`"* and *"If pi-ai ever forwards the original Error (or a fetch/dispatcher hook that lets us capture the cause ourselves), classify on `code`/`cause` instead of text."* → **pi-ai exposes no dispatcher hook today**.
- Runtime: `…\dsh-llm-pi-ai\lib\index.js:2313` plain `fetch` for discovery; the streaming path goes through the SDK, which per `dsh-http-proxy\README.md:32` reaches `globalThis.fetch`.

**The `llm` base service adds no transport seam.** `packages/llm/llm/src/index.ts`:

- ``:174-178`` — *"Every provider HTTP request must include `attributionHeaders()`… The direct-fetch DeepSeek and library-backed pi-ai adapters meet this contract through different internals."*
- ``:180-233`` — `abstract class LlmAdapter` = `providerInfo`, `providerRetryPolicy`, `listModels`, `resolveModel`, `stream`. **No transport option, no agent, no dispatcher.**
- ``:338-367`` — `registerAdapter(providers, adapter)` returns `AdapterRegistrationHandle` with `replace(next)`; duplicates throw `DUPLICATE_ADAPTER` (`:379-381`).
- ``:64`` — the only interception seam: `'llm/stream'(this: LlmRuntime, options: GenerateOptions, next: () => AsyncIterable<StreamChunk>)` (waterfall). It wraps the *chunk stream*, so it can re-issue a call through another adapter but cannot re-route an in-flight request's socket.

**Adapter registration seam for a plugin (checkout `0.2.0` equivalent is unchanged in shape):** register your own adapter for provider ids you own; you cannot shadow an existing provider (`DUPLICATE_ADAPTER`), and `handle.replace([])` legally vacates routes.

---

## 4. Web fetch / search path

**Interfaces (identical in checkout and runtime):** `packages/web/web/src/types.ts:101-119`

```ts
export interface WebSearchProvider {
  readonly id: string
  available(): boolean
  search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult>
}
export interface WebFetchProvider {
  readonly id: string
  available(): boolean
  fetch(request: WebFetchRequest, signal?: AbortSignal): Promise<WebFetchResult>
}
```

**Registration + selection:** `packages/web/web/src/index.ts`

- ``:55-60`` `WebRuntimeConfig { searchProvider?, fetchProvider? }` with the JSDoc: *"Operational overrides such as environment variables must feed these same fields rather than introduce a hidden priority chain."*
- ``:92-93`` `this.searchProviderId = config.searchProvider ?? process.env.DSH_WEB_SEARCH_PROVIDER` / same for `DSH_WEB_FETCH_PROVIDER` — **read once in the constructor**, i.e. at plugin load.
- ``:103-116`` `registerSearchProvider` / `registerFetchProvider`; duplicates throw `WEB_DUPLICATE_PROVIDER` (``:119-121``); the disposer is fiber-scoped via `ctx.effect` (``:122-128``).
- ``:140-163`` `search()`/`fetch()` resolve the provider **at call time** through `resolveProvider` (``:172-194``): configured id → that provider (missing ⇒ `WEB_PROVIDER_CONFIGURED_MISSING`, unavailable ⇒ `WEB_PROVIDER_CONFIGURED_UNAVAILABLE`); otherwise exactly one usable provider auto-selects, several ⇒ `WEB_PROVIDER_AMBIGUOUS`, none ⇒ `WEB_PROVIDER_UNAVAILABLE`.
- Live profile config (`%USERPROFILE%\.dsh\profiles\desktop\cordis.yml`, `id: web`): `searchProvider: deepseek-official`, `fetchProvider: http`.

**`web-fetch-http`**

- Checkout: `src/provider.ts:33` `export const LOCAL_FETCH_PROVIDER_ID = 'http'`; `:103-114` `requestOnce()` does a bare `fetch(url, { method:'GET', redirect:'manual', headers, signal })`; `src/index.ts:84-100` `apply()` validates limits and calls `ctx.web.registerFetchProvider(new HttpFetchProvider(limits))`. Config (`src/index.ts:34-56`) exposes only size/time/redirect/UA limits — **no transport or proxy knob**.
- Runtime (`…\dsh-web-fetch-http\lib\index.js`) is materially different and is the one consumer that legitimately owns its transport:
  - ``:4`` `import { proxyRouteFor } from "@deepseek-ai/dsh-http-proxy";`
  - ``:501-504`` the decision:
    ```js
    const route = proxyRouteFor(url);
    if (route.proxied && !isNonPublicIpLiteral(url.hostname)) return await publicHttpNetwork.requestVia(route.dispatcher, url, headers, signal);
    const addresses = await this.resolveAddresses(url.hostname, signal);
    return await publicHttpNetwork.request(url, addresses, headers, signal);
    ```
  - ``:153-176`` `requestPinned()` builds its own `new undici.Agent({ connect: { lookup: createPinnedLookup(addresses) } })` and `fetch(url, {..., dispatcher})` — the `proxy-exempt:` case (`README.md:44`).
  - ``:192-204`` `requestVia(dispatcher, …)` uses **undici's** `fetch` with the policy dispatcher: *"No address set is pinned because none exists to pin: the proxy performs the lookup"*.

**Search providers**

- `web-search-deepseek`: `src/provider.ts:222` POST to `${options.baseURL}/messages`; `src/index.ts:127-137` registers `new DeepSeekSearchProvider(() => resolveOptions(ctx, current()))`; options are re-projected **per search** from a settings section (`provider.ts:180-187` documents the thunk rationale) — so *endpoint/model/key* are hot, but again no transport field.
- `web-search-exa` / `web-search-perplexity`: `src/provider.ts:101` / `:104`, both plain `fetch`.

**Plugin seam verdict:** yes — a plugin can register its own `WebFetchProvider`/`WebSearchProvider`, or shadow the configured id by making the existing one unavailable, but the built-in providers give **no per-request transport hook**, so reusing them still means riding the global dispatcher.

---

## 5. Telemetry path

**`session-telemetry-otel`** (checkout `packages/session/session-telemetry-otel/src/index.ts`):

- ``:34`` `import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-http'`
- ``:100-103`` `exporter?: OTLPExporterNodeConfigBase & { url?: string }` — *"Passed verbatim to the SDK's OTLP/HTTP log exporter"*
- ``:215`` `exporter: new OTLPLogExporter(config.exporter),`
- ``:170-183`` requires an `http(s)` `exporter.url`; live profile config drives it from `DSH_TELEMETRY_OTLP_URL ?? 'https://dsh-otel-collector.deepseeksvc.com/v1/logs'` with `compression: gzip`, `mode: process.env.DSH_TELEMETRY_MODE || 'FEEDBACK_ONLY'`.

**Why it is direct — proven from the installed SDK**, not just asserted:

- `…\@opentelemetry\otlp-exporter-base\build\src\configuration\otlp-node-http-configuration.js:5-17`:
  ```js
  function httpAgentFactoryFromOptions(options) {
      return async (protocol) => {
          const isInsecure = protocol === 'http:';
          const module = isInsecure ? import('http') : import('https');
          const { Agent } = await module;
          if (isInsecure) {
              const { ca, cert, key, ...insecureOptions } = options;
              return new Agent(insecureOptions);
          }
          return new Agent(options);
      };
  }
  ```
  and ``:34-39`` `agentFactory: httpAgentFactoryFromOptions({ keepAlive: true })`.
- `…\build\src\transport\http-exporter-transport.js:16-31` passes that agent explicitly: `const { agent, request } = await this._loadUtils();` → `sendWithHttp(request, url, headers, compression, userAgent, agent, data, timeoutMillis)`; `http-transport-utils.js:39-41` puts `agent` into the request options.

Because the exporter supplies **its own `https.Agent`**, Node's built-in env-proxy support (which configures `https.globalAgent`) never applies, and undici's global dispatcher never applies either. The runtime package documents this as deliberate (`dsh-http-proxy\README.md:110`):

> **Telemetry is direct by design** — the OTLP exporter posts through `node:http`, which no global dispatcher reaches. Routing it would need either an `http.Agent` whose `proxyEnv` option post-dates the lowest supported Node, or the SDK's `fetch` transport, which has no compression while the shipped profile enables gzip. Telemetry is the one channel whose loss costs the user nothing, so it stays where it was; `DSH_TELEMETRY_MODE=DISABLED` turns it off.

Installed `dsh-session-telemetry-otel\lib\index.js:126-127` still spreads the config verbatim (`exporter: { ...config.exporter, ... }`), so a **static** proxy could be injected at config time via the SDK's legacy `httpAgentOptions` (which `convertLegacyHttpOptions` funnels into `httpAgentFactoryFromOptions`) — but it is fixed when the exporter is constructed, and the checkout's `Config.exporter` is `z.any()` (`src/index.ts:122`), so no schema work is needed. There is **no runtime** switch for this channel.

`@deepseek-ai/dsh-host-product-telemetry-otel` (mounted in the desktop profile as `desktop-product-telemetry`) and `@deepseek-ai/dsh-otel` are **not present in the checkout** and not in the profile's shared `node_modules` listing; they ship only inside the desktop product payload. The runtime's own limitation list treats telemetry as one channel, so the same conclusion is expected but unverified — see Open questions.

---

## 6. Package-install path

**Checkout (`0.1.0-rc.7`)** — `apps/cli/src/plugin.ts` is a thin pnpm forwarder:

- ``:129-133``
  ```ts
  const result = spawnSync('pnpm', args.map(argument => anchorPathSpec(argument, process.cwd())), {
    cwd: dir,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  })
  ```
  **No `env` option** ⇒ `pnpm` inherits the parent's whole environment verbatim.
- ``:104-112`` `anchorPathSpec` rewrites bare/`file:`/`link:` relative specs against the invoking cwd.
- ``:36-45,59-91`` `exportsPatch`/`reconcilePlugins` reconcile `dsh.profile.bundles`.
- CLI wiring: `apps/cli/src/args.ts:171-179` (`plugin` command, *"manage a profile's plugins by forwarding the remaining arguments to pnpm in the profile directory"*).

So in the checkout, whether `pnpm` reaches the registry through a proxy depends entirely on the inherited environment (and on pnpm's own `npm_config_proxy` handling — note pnpm reads npm config, not the standard variables).

**Running runtime (`0.2.0-rc.2`)** — installs go through `@deepseek-ai/dsh-plugin-manager/operations` (`…\dsh\lib\plugin-BGnVfe_D.js:6`), and the environment is now explicit:

- `…\dsh-plugin-manager\lib\types\operations.js:275`
  ```js
  const environment = { ...(options.execution === 'cli' ? process.env : scrubbedParentEnv()), ...options.env };
  ```
  - CLI path ⇒ `process.env`, which `dsh-http-proxy` has already rewritten to the resolved policy (`applyPolicyEnv`).
  - Non-CLI path ⇒ `scrubbedParentEnv()`, which applies `proxyEnvironmentForChild()` (`dsh-subprocess\lib\index.js:53-54`).
- ``:131-135`` pre-install registry lookup runs pnpm itself: `await execa(options.command ?? 'pnpm', [...], { cwd: dir, env: environment, extendEnv: false, ... })` — `extendEnv: false` means **only** the resolved environment is passed.
- ``:299`` `const registryFlags = args.filter(argument => argument.startsWith('--registry='));`

**Marketplace plugin (`dshmarket@1.66.x`, third-party, mounted in the desktop profile)** adds the npm-config translation the standard variables lack:

- `lib\dsh-cli.js:83-115` `proxyEnvForPnpm()` → sets `npm_config_https_proxy`, `npm_config_proxy`, `npm_config_noproxy` (only when the caller has not set them), and back-fills `HTTPS_PROXY`/`HTTP_PROXY`/`NO_PROXY` from npm config **only** when the standard vocabulary is empty. Its comment (`:97-103`) records the field failure: *"registry installs went through the proxy while git installs went direct and failed with 'Failed to connect to github.com:443'"*.

---

## 7. Existing seams a plugin could use

Ordered from most to least supported.

### 7.1 `@deepseek-ai/dsh-http-proxy` (the real seam; `0.2.0-rc.2`, absent from the checkout)

Public face (`lib\types\index.d.ts:16`):

```ts
export { clearedProxyEnv, installProxyFromEnvironment, proxyEnvironmentForChild, proxyRouteFor, type ProxyRoute } from './install.ts';
```

| Function | Runtime semantics | Hot-switch value |
|---|---|---|
| `installProxyFromEnvironment(env, report): Promise<() => Promise<void>>` (`lib/index.js:519-523`) | resolves policy from `env` (any `{get(name): {value} \| undefined}`), reports each rejected value, installs the dispatcher, **rewrites `process.env`**, returns a disposer restoring `{dispatcher, policy, env}` and closing the agent | **This is the switch.** Call it again with a different `env` lookup to re-point the whole process; call the previous disposer to revert. |
| `proxyRouteFor(url): ProxyRoute` (`:314-324`) | `{proxied:true, proxy, dispatcher}` or `{proxied:false}`, read from the module-level `active`/`installed` | per-request routing **with the transport already chosen**, for callers that build their own requests |
| `proxyEnvironmentForChild()` (`:491-503`) | overlay for a spawn: user's own values restored per scheme, resolved value filled in where the user named neither, `NODE_USE_ENV_PROXY=1`, loopback-merged `NO_PROXY`, flag withheld if any value is one the package refused | child-process routing |
| `clearedProxyEnv()` (`:532-534`) | every proxy name → `undefined` | isolate a replay/fixture from the machine's proxy |

Design constraints a plugin must respect:

- `README.md:28` — *"This is a library rather than a plugin: transport policy has one answer per process, so there is nothing for a composition to mount, swap, or scope."*
- `README.md:44` — *"Constructing `new Agent(...)` and passing it as `dispatcher` overrides the global one and silently bypasses the proxy. `verify-no-bare-dispatcher` rejects that outside this package."* (That gate exists only in the newer upstream; **no such gate exists in the checkout** — `scripts/` has no `no-bare-dispatcher`/`egress` match.)
- `README.md:109` — child coverage needs Node 22.21+/24+; worker threads deliberately receive nothing (`lib/index.js:407-410`: *"A worker thread has its own `globalThis` and so its own dispatcher; installing here does not reach it. No worker installs one today"*).

### 7.2 Other seams (registerable, but no transport control)

| Seam | Where | What it buys |
|---|---|---|
| `ctx.web` provider registries | `packages/web/web/src/index.ts:103-116`; interfaces `packages/web/web/src/types.ts:101-119` | replace or add a fetch/search provider — a plugin *can* implement its own transport, e.g. per-request dispatcher |
| `ctx.llm` adapter registry | `packages/llm/llm/src/index.ts:338-367` | own a **new** provider id; cannot shadow an existing one (`DUPLICATE_ADAPTER`) |
| `llm/stream` waterfall | `packages/llm/llm/src/index.ts:64` | intercept the chunk stream (retry/replay/routing) — **not** the socket |
| `session-telemetry-otel` `Config.exporter` | `packages/session/session-telemetry-otel/src/index.ts:100-103,215`; `Config.exporter` is `z.any()` (`:122`) | pass `httpAgentOptions` (legacy) → custom `Agent`; static, at plugin load |
| `ctx.settings` namespaces | `packages/settings/settings` + `installSettingsSection` (used at `packages/web/web-search-deepseek/src/index.ts:129`) | let a plugin expose its own config in the GUI (namespaces are now served without an apiproxy allowlist per `.agents/notes/implemented/architecture/2026-08-12-plugin-owned-settings-surface.md:19`) |
| `DSH_LAUNCH_ENVIRONMENT_KEY` | `packages/util/launch-environment/src/index.ts:106-107`; provided at `apps/cli/src/profile-boot.ts:252` | read the *frozen* launch env (what the proxy package consumes) |
| Subprocess env | `packages/subprocess/subprocess/src/index.ts:60-65` (`scrubbedParentEnv`); runtime adds the proxy overlay | children inherit routing |

**There is no `ctx.http` / Cordis HTTP service today.** The `TODO(http)` in `llm-deepseek` (`src/adapter.ts:301`) and its README (`README.md:113`) name `@cordisjs/plugin-http` as the deferred adoption target; grep for `ctx.http`/`httpService`/`cordis-plugin-http` across `packages/`, `vendor/` and `docs/` finds nothing. `vendor/` contains only `cordis`, `cosmokit`, `group`, `hmr`, `include`, `loader`, `logger-console`, `schemastery`, `timer` — **no HTTP plugin**.

---

## 8. Runtime mutability assessment

**Question: can env-proxy behaviour be swapped at runtime after startup?**

### 8.1 What is *not* mutable

| Mechanism | Verdict | Evidence |
|---|---|---|
| `process.env.HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY` / `NO_PROXY` | **Read once at bootstrap.** Changing them later changes nothing for Node's built-in support. | Measured: a child started with all proxy vars and `NODE_USE_ENV_PROXY` removed, then setting `process.env.HTTP_PROXY`/`http_proxy` to a live local proxy, produced `ENOTFOUND` (direct) — the local proxy never saw a request. |
| `NODE_USE_ENV_PROXY` itself | **Bootstrap-only process flag.** dshmarket measured the same: *"setting `NODE_USE_ENV_PROXY` at runtime changes nothing — it is read at startup"* (`dshmarket\lib\net.js:5-7`). | `dshmarket\lib\net.js:4-10`; my own child test (`NODE_USE_ENV_PROXY` printed `undefined` yet `http.request` was proxied after an explicit API call — see below). |
| `dsh-http-proxy`'s policy | **Captured at install time in a closure.** `resolveProxyPolicy(env)` runs inside `installProxyFromEnvironment`; the dispatcher factory then calls `proxyForUrl(policy, …)` against that captured object (`lib/index.js:388-399`). No per-request `process.env` read. | `lib/index.js:243-264,388-399,519-523` |
| OTLP telemetry transport | **Fixed at exporter construction**, because the exporter builds its own `Agent`. | `otlp-node-http-configuration.js:5-17,34-39`; `http-exporter-transport.js:16-31` |
| Worker threads (workflow engine, PTC runtime) | **Separate `globalThis`, separate dispatcher.** | `lib/index.js:407-410`; `README.md:111` |

### 8.2 What *is* mutable (measured on this machine)

| Lever | Applies to | Measured result |
|---|---|---|
| `undici.setGlobalDispatcher(agent)` from **`undici@8.11.2`** (the instance `dsh-http-proxy` itself resolves) | global `fetch` → LLM adapters, web search, `web-fetch-http`'s non-pinned path, MCP HTTP, pi-ai | ✅ **Works.** Probe under Electron-as-Node 24.18.1, cwd `…\.dsh\profiles` (undici 8.11.2): `undici.setGlobalDispatcher(new Agent({factory: () => new ProxyAgent(uri)}))` then `fetch('http://probe.invalid/')` → `200 VIA-PROXY`, proxy logged `GET http://probe.invalid/`. undici's own `fetch(..., {dispatcher})` likewise. |
| `undici.setGlobalDispatcher(...)` from **`undici@7.30.0`** (what the *desktop profile* resolves for third-party plugins) | same | ⚠️ **Fragile.** Same probe with cwd `…\.dsh\profiles\desktop` (undici 7.30.0) produced **2133 proxy requests in 8 s and no result** (request storm) instead of the expected two. Cross-instance dispatcher hand-off in this stack is a real hazard; see §8.3. |
| `http.setGlobalProxyFromEnv([proxyEnv])` (**Node 24.18.1 and 24.21.0 both export it** — `typeof === 'function'`) | `node:http` / `node:https` global agents only | ✅ **Works, and works without the startup flag.** Child started with `NODE_USE_ENV_PROXY`/all proxy vars deleted, then `http.setGlobalProxyFromEnv({HTTP_PROXY:'http://127.0.0.1:PORT',...})` → `http.request` to `probe.invalid` returned `VIA-PROXY`; the local proxy saw the request. Return value is a function (restore/dispose). |
| `http.setGlobalProxyFromEnv(...)` | `fetch` | ❌ **No effect.** Child without the startup flag, proxy installed via `setGlobalProxyFromEnv`, then `fetch('http://dsh-probe-target.test/ping')` → no request ever reached the proxy (4 s timeout). Matches the Node docs note *"Global agents do not affect `fetch()`"*. |
| Per-request `dispatcher` on undici's own `fetch` | anything you write yourself | ✅ Proven by the probe and by `web-fetch-http` (`lib\index.js:192-204`) and `dshmarket\lib\net.js:95-110`. |
| Re-calling `installProxyFromEnvironment(env, report)` (the package's own exported function) | whole process | ✅ By construction: it is the same code path the launcher uses, returns a disposer, and disposes via `agent.close()` (graceful — in-flight requests finish; `install.d.ts:16-18`: *"Disposal closes that dispatcher rather than destroying it, so a request already dispatched when a policy is unmounted still finishes"*). Nesting is handled: `inheritedProxyEnv` belongs to the **outermost** install (`lib/index.js:303,335-336`), so a second install does not corrupt `proxyEnvironmentForChild()`. |

### 8.3 Why the crux is what it is

- The design intentionally puts **one answer per process** (`README.md:28`) and resolves it from the **launch** environment (first layer of `loadLayeredEnv`, `packages/boot/app-boot/src/index.ts:182-197`). `.env` files can never supply it: proxy names are bootstrap-only (`:111`, `:155-162`). So "change the config file" is not a path.
- The seam is nevertheless **hot** because `installProxyFromEnvironment` is a plain exported function with a disposer, and because the *only* per-request state is `active`/`installed` module globals (`lib/index.js:292-306`) that it rewrites atomically.
- The **safe** way to hot-switch is therefore to consume the host's own package: `import { installProxyFromEnvironment, proxyRouteFor } from '@deepseek-ai/dsh-http-proxy'`. Resolving `undici` yourself is where it goes wrong — the two userland undici instances on this machine are `8.11.2` (host, reached via the `profiles\node_modules\undici` junction into `%APPDATA%\npm\node_modules\@deepseek-ai\dsh\node_modules\undici`) and `7.30.0` (desktop profile, for third-party plugins), against Node's internal `7.29.0`.
- The field report in `dshmarket\lib\net.js:16-26` is the cautionary tale and should be treated as a design input, not an anecdote:
  > *"On Node 25, `setGlobalDispatcher` from the undici package does not steer global fetch. With a dispatcher installed that way, a global fetch produced no CONNECT at a local proxy, while undici's own fetch produced `CONNECT awesome-dsh-plugin.com:443`."*
  > *"On Node 22 the two stacks share one symbol (#742). Global fetch reads `Symbol.for('undici.globalDispatcher.1')`. The host's first import of undici 8 (`web_fetch`) finds `.2` empty, installs its dispatcher, and writes a `Dispatcher1Wrapper` onto `.1`. After that, global fetch returns gzip bodies with null headers, and `JSON.parse` fails on the catalog."*
  That plugin consequently reads `process.env` **per request** and passes an explicit `EnvHttpProxyAgent`/`Agent` dispatcher to undici's own `fetch` (`net.js:88-110`) — i.e. it chose per-request resolution *specifically to escape the global-dispatcher fragility.*

### 8.4 Practical recommendation for a proxy-switcher plugin

1. **Preferred:** call the host's `installProxyFromEnvironment` (import `@deepseek-ai/dsh-http-proxy`, do **not** bundle your own undici) with a custom `EnvLookup` object, keep the returned disposer, and call it again on each switch. This covers every `fetch`-based path and keeps `proxyEnvironmentForChild()` consistent for children.
2. **Avoid** resolving `undici` from the desktop profile (`7.30.0`) and installing *that* as the global dispatcher — measured to misbehave on this runtime.
3. For `node:http`-based egress (only the OTLP exporter today, and it owns its agent) nothing global helps; that channel needs a config-level `httpAgentOptions` or `DSH_TELEMETRY_MODE=DISABLED`.
4. If the plugin needs per-request routing guarantees, use `proxyRouteFor(url)` and pass `route.dispatcher` to undici's own `fetch` — the pattern `dsh-web-fetch-http` uses (`lib\index.js:501-504`).
5. Node's built-in `NODE_USE_ENV_PROXY` is **not** a usable switch: it is a bootstrap flag, and `http.setGlobalProxyFromEnv()` only covers `node:http(s)` global agents, never `fetch`.

---

## 9. Direct answers to the six investigation points

1. **Proxy-config readers** — checkout: only the `.env` rejection list (`packages/boot/app-boot/src/index.ts:93-114`) plus README prose. Runtime: `@deepseek-ai/dsh-http-proxy` (`lib/index.js:29-43,68-76,243-264,275-280`). No `getProxyForUrl`, `proxy-from-env`, `http(s)-proxy-agent`, `node-fetch`, or `axios` anywhere in the monorepo or in the installed package set.
2. **HTTP clients actually used** — global `fetch` everywhere (LLM adapters, web search, `web-fetch-http`, pi-ai, MCP HTTP); `node:http(s)` in the OTLP exporter; `pnpm`/`execa` for package installs; `undici`'s own `fetch` inside `dsh-http-proxy` and `web-fetch-http`.
3. **Injectability / caching** — no per-request `dispatcher` option exists on any DSH adapter; the routing decision is **cached at install time** in the dispatcher closure. `web-fetch-http` *does* accept the process dispatcher per request via `proxyRouteFor`. Env proxy behaviour is **not** re-read per request anywhere in DSH.
4. **Existing supported seam** — yes: `@deepseek-ai/dsh-http-proxy` (library, not a plugin, one answer per process). Web providers are replaceable through `ctx.web.registerFetchProvider`/`registerSearchProvider`; LLM adapters through `ctx.llm.registerAdapter` (no shadowing); there is **no** `ctx.http` service in the checkout.
5. **undici** — not a direct dependency of any package or app in the monorepo (`grep` over every `package.json` in `packages/` for `undici` → no matches). Resolvable transitively at `undici@7.28.0` (`pnpm-lock.yaml:13881-13883`), pulled in by `e2b@2.29.1` (`:17216`) and `jsdom@29.1.1` (`:17901`), present at `node_modules\.pnpm\undici@7.28.0\...` and `node_modules\.pnpm\node_modules\undici`, but **not** at the repo root (`F:\...\deepseek-harness\node_modules\undici` does not exist). Installed profile: `%USERPROFILE%\.dsh\profiles\node_modules\undici` = **8.11.2** (junction to `%APPDATA%\npm\node_modules\@deepseek-ai\dsh\node_modules\undici`), declared by `dsh-http-proxy` as `undici: ^8.10.0`; the desktop profile additionally hoists **7.30.0** for third-party plugins.
6. **Node version** — checkout `package.json:8-10` `"engines": { "node": "^22.19.0 || >=24.0.0" }`. Bundled standalone Node **24.21.0** and pnpm 11.7.0 (`resources\runtime\versions.json`), shimmed as Electron-as-Node (`runtime\bin\node.cmd:1-3`); the actual harness host process runs **Electron 44.0.0 / Node 24.18.1** (internal undici 7.29.0). `NODE_USE_ENV_PROXY` is honoured: fetch since 24.0.0 and `node:http`/`node:https` since 24.5.0, so 24.18.1 covers both ([Node.js docs — Enterprise Network Configuration](https://nodejs.org/learn/http/enterprise-network-configuration): *"This works with `node:http` and `node:https` (v22.21.0 or v24.5.0+) methods as well as `fetch()` (v22.21.0 or v24.0.0+)"*). Runtime changeability: **no** for `fetch`; **yes, via an API call** for `node:http(s)` — `http.setGlobalProxyFromEnv([proxyEnv])` exists in both 24.18.1 and 24.21.0 ([`http.setGlobalProxyFromEnv` in the Node 24 docs](https://nodejs.org/docs/latest-v24.x/api/http.html#httpsetglobalproxyfromenv), measured working at runtime without the bootstrap flag).

---

## 10. Open questions

1. **Which tree must the plugin target?** The checkout (`0.1.0-rc.7`) has no proxy layer; the running runtime (`0.2.0-rc.2`) does. If the plugin must be developed/tested against `packages/util/http-proxy`, that directory must be obtained from upstream (or the plugin must be written against the *installed* package's public API, which is stable: four functions + one type).
2. **Is the `web` fetch path really the live one?** `web-fetch-http` in the runtime pins addresses when **direct** and defers DNS to the proxy when **proxied** (`lib\index.js:501-504`), so SSRF posture changes with the switch. If the switcher turns the proxy *off*, previously-blocked private targets become reachable through the pinning path — worth confirming against `src/network.ts`/`src/policy.ts` upstream.
3. **Undici instance to use.** `dsh-http-proxy` resolves `undici@8.11.2` from the npm tree; a plugin in the desktop profile resolves `7.30.0`. My probe shows a 7.30.0 global-dispatcher install misbehaving (request storm) on this exact runtime while 8.11.2 works. Recommend confirming with the upstream `install.spec.ts` assertion (`README.md:120`) and always going through the host package.
4. **Does `dsh-host-product-telemetry-otel` behave like `session-telemetry-otel`?** Not present in the checkout or the profile's shared `node_modules`; it ships inside the desktop payload and is mounted as `desktop-product-telemetry` with `endpoint: process.env.DSH_PRODUCT_ANALYTICS_OTLP_URL`. Its transport should be checked separately before claiming "telemetry is direct" for the product-analytics channel.
5. **E2B sandbox egress.** `pnpm-lock.yaml:17216` shows `e2b@2.29.1` depends on `undici` directly; if it calls undici's `request`/`Client` rather than `globalThis.fetch`, it bypasses the global dispatcher. No E2B row is mounted in the desktop profile, so this is unverified.
6. **Worker threads.** The workflow engine (`dsh-workflow-worker-thread`) and PTC runtime deliberately receive **no** proxy settings (`dsh-http-proxy\README.md:111`). If the switcher is expected to cover model-authored scripts, that is a distinct change (each worker needs an explicit install).
7. **Does `NO_PROXY` in the live process come from the policy or the user?** The observed value `localhost,127.0.0.1,::1,[::1]` is byte-identical to `LOOPBACK_NO_PROXY` (`lib\index.js:19-24`) with no extra entries, which suggests `applyPolicyEnv` overwrote a plain `NO_PROXY` export. A definitive check needs the process's *pre-launch* environment, not the current one.
8. **`http.setGlobalProxyFromEnv` restore semantics.** It returns a function, but I did not determine whether calling it restores the pre-call agent configuration or re-reads the environment. Relevant if the switcher uses it for the `node:http` channel.
