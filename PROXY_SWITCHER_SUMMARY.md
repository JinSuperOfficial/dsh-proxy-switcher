# dsh-proxy-switcher — 关键结论 · 实现方案 · 测试结果（总结）

> 工作区：`F:\@Project\DeepSeekHarnes\dsh-proxy-switcher`
> 目标：让运行中的 dsh 能热切换出站代理，入口集成在 dsh 设置里，**无需重启**
> 日期：2026-10-02

---

## 0. 一句话结论

dsh 的代理之所以"必须重启才能改"，是因为它依赖 Node 的 `NODE_USE_ENV_PROXY`，而**这份配置在进程内只解析一次**。
本插件把"用哪个代理"从*启动时决定*改成*请求时决定*，做法是**安装/替换 undici 的全局 dispatcher**——
这是 Node 内置 `fetch` 唯一会读取、且**唯一能跨 undici 版本工作**的注入点。
插件已安装进 `desktop` profile，并且**已经在运行中的 dsh 里生效**（没有重启任何东西）。

---

## 1. 关键结论（全部有实测证据）

### 1.1 代理来源：Node 的内置 env-proxy，不是 dsh 自己的代码

运行环境：

| 项 | 值 |
|---|---|
| 桌面应用 | DeepSeek Harness（Electron 44.0.0，以 `ELECTRON_RUN_AS_NODE=1` 跑 Node） |
| 宿主 Node | **24.18.1** |
| bundled 独立 Node | 24.21.0（`resources/runtime/primary-runtime/dependencies/node/bin/node.exe`） |
| 启动时环境 | `NODE_USE_ENV_PROXY=1`、`HTTP_PROXY`/`HTTPS_PROXY`/`ALL_PROXY`/`http_proxy`/`https_proxy`=`http://127.0.0.1:7890`、`NO_PROXY=localhost,127.0.0.1,::1,[::1]` |

出站调用点（**全部是裸 `fetch`**，没有任何地方自建 dispatcher）：

| 链路 | 位置 |
|---|---|
| LLM（官方 DeepSeek） | `packages/llm/llm-deepseek/src/adapter.ts:305` |
| LLM（pi-ai 发现） | `packages/llm/llm-pi-ai/src/discovery.ts:244`（流式由 `@earendil-works/pi-ai` 内部走 `fetch`） |
| web fetch | `packages/web/web-fetch-http/src/provider.ts:105` |
| web search | `web-search-deepseek:222`、`perplexity:104`、`exa:101` |
| MCP over HTTP | `packages/mcp/mcp-client/src/transport.ts` |

例外（设计如此）：**OTLP 遥测走 `node:http` 并自建 agent**，全局 dispatcher 与 Node env-proxy 都覆盖不到它。

### 1.2 「必须重启」的根因（实测）

| 实验 | 结果 |
|---|---|
| 启动后把 `process.env.HTTPS_PROXY` 改到一个**死端口**，再 `fetch` | **仍然成功走原代理** → 环境变量不再被读取 |
| 启动时清空所有代理变量，脚本内再设置 `NODE_USE_ENV_PROXY=1` + `HTTP_PROXY`，然后 `fetch` | **ENOTFOUND**（直连失败）→ 全局 dispatcher 在 bootstrap 时已定型 |

结论：**运行期改 `process.env` 无法切换代理**。这正是必须重启的根本原因。

### 1.3 切换点：undici 全局 dispatcher（关键发现）

Node 内置 `fetch` 从 `globalThis[Symbol.for('undici.globalDispatcher.1')]` 取传输层；
npm 版 `undici` 的 `setGlobalDispatcher()` 写的正是这个槽位（以及 `.2`）。
所以 **userland undici 装一个 dispatcher，就能让 Node 内置 `fetch` 改道**。

实测（`probe/probe-global-dispatcher2.mjs`，Electron-as-Node 24.18.1）：
装 p1 → 走 p1；换 p2 → 走 p2；换 direct Agent → 直连；换回 p1 → 走 p1；连续两次快速替换 → **最后写入者生效**。全部 PASS。

### 1.4 决定性边界：**只有全局槽位能跨 undici 版本**（重要）

宿主自带的 undici 是 **8.11.2**，而 Node 24.18.1 内置 `fetch` 自带的 undici 是 **7.29.0**。
两者 handler API 不同代：

| 放置方式 | 结果 |
|---|---|
| 全局槽位 + `Agent` | ✅ |
| 全局槽位 + `Agent{factory → ProxyAgent}` | ✅ |
| 全局槽位 + `ProxyAgent` 直接 | ✅ |
| 全局槽位 + `ProxyAgent("socks5://…")` | ✅（undici 8 原生支持 SOCKS5） |
| **显式** `fetch(url, { dispatcher })` + 8.x dispatcher | ❌ `UND_ERR_INVALID_ARG: invalid onRequestStart` |
| `undici.fetch(url, { dispatcher })`（同实例） | ✅ ← `dsh-web-fetch-http` 用的就是这种 |

原因：**全局槽位由 Node 做版本适配，显式传入则原样使用**。

**据此的架构决定：插件不包装 `fetch`，只通过全局槽位切换。**
（曾经写过一个 fetch 包装器，正是这个实验证明它会引入跨代错误，已删除。）

### 1.5 复用 dsh 自带的官方 seam

0.2.x 的 dsh 自带 `@deepseek-ai/dsh-http-proxy@0.2.0-rc.2`，公开 4 个函数：

```
installProxyFromEnvironment(env, report) -> Promise<disposer>
proxyRouteFor(url) -> { proxied: true, proxy, dispatcher } | { proxied: false }
proxyEnvironmentForChild()
clearedProxyEnv()
```

启动器在 `dsh/lib/profile-boot-BZ2ZjNWi.js:225` 调用它安装全局 dispatcher。
其 README 明说：**不支持 SOCKS/PAC/操作系统代理检测**。

插件策略：**http/https/直连 → 委托给它**（这样 undici 全局 dispatcher、`proxyRouteFor()`、
子进程环境变量三者同步一致）；**SOCKS5 → 自建全局 dispatcher**（它按设计拒绝 SOCKS）。

### 1.6 两个 undici 副本是真实陷阱

profile 里同时存在多份 undici：宿主那份 8.11.2（经 junction 指向 launcher 的 node_modules），
`desktop` profile 又为第三方插件提升了一份 7.30.0。
本机已安装的 `dshmarket` 在其 `lib/net.js:1-31` 里记录了真实事故：Node 25 上 userland
`setGlobalDispatcher` 不再驱动全局 `fetch`；Node 22 上 undici 8 的 `.1/.2` 槽位处理会损坏响应体。

**插件因此固定"经 `@deepseek-ai/dsh-http-proxy` 解析 undici"**，保证自己造的 dispatcher 与
宿主安装的 dispatcher 来自同一实例。运行中实测确认：

```
capabilities.undiciSource = "dsh-http-proxy -> C:\...\@deepseek-ai\dsh\node_modules\undici\index.js"
capabilities.undiciVersion = "8.11.2"
```

### 1.7 版本错位（分析前提，必须记住）

本地检出 `F:\@Project\DeepSeekHarnes\deepseek-harness` 是 **0.1.0-rc.7**，而运行的是 **0.2.0-rc.2**。
0.1.0-rc.7 **完全没有代理实现**（`packages/llm/llm-deepseek/README.md:113` 明确写着 raw `fetch`、
无共享代理/拦截配置）；代理层是 0.2.0 才加的。
所以对"运行中的代码"的任何判断，都必须以 `~/.dsh/profiles/node_modules/@deepseek-ai/*` 为准。

另外：`settings.plugin.item` / `plugins.bundle.config` 这两个 slot 在**运行中的 0.2.0-rc.2 里没有声明**
（虽然 0.1.0-rc.7 的 cookbook 推荐用它）。而 `ctx.slots.inject` 对**未声明的 slot 会静默永久挂起**，
所以选错 slot 是"装上了但永远不显示"。本插件用 **`settings.section`**——已通过实时 Slots inspect 确认它在运行中的 dsh 里是 declared 且已有 7 个占用者。

---

## 2. 实现方案

### 2.1 架构

```
lib/
  proxy.js       代理规格解析 · no_proxy 匹配 · SOCKS5 connector(7.x 回退) · 脱敏
  config.js      默认值 · 校验 · 四层优先级 · 原子持久化(0600)
  transport.js   全局 dispatcher 安装（委托官方 seam / 自建）· 环境变量发布 · undici 实例选择
  switcher.js    策略解析 · 应用 · 状态 · 历史 · 连通性测试
  routes.js      设置页 HTTP 接口（同源校验 · 脱敏）
  index.js       宿主半：Cordis 生命周期 · 路由 · /proxy 命令 · plugin API
  client.js      浏览器半：设置页（手写 classic script，**无需构建步骤**）
cordis.patch.yml 挂载行
```

### 2.2 切换机制

```
每次 apply(policy):
  1. restore()        —— 把上一个传输放下（close()，不是 destroy()）
  2. strategyFor()    —— http/https/direct → delegate；socks5 或老 dsh → own
  3. delegate: installProxyFromEnvironment(envLookupFor(policy), report)
     own:      setGlobalDispatcher(createOwnDispatcher(policy)) + writeEnv(policy)
  4. 记录 installedDispatcher / bootEnv，供 restore 校验与还原
```

关键设计点：

- **一次切换 = 重新安装一个全局 dispatcher**。`restore()` 用 `close()`（优雅）：**已在途的请求
  （流式回答）在旧传输上跑完**，新请求走新策略。实测切换耗时 **14–29ms**。
- **委托时 `proxyRouteFor()` 同步更新** → `dsh-web-fetch-http` 的 `web_fetch` 也会跟着切。
- **`Agent{factory}` 每 origin 决策**：bypass 的 origin 走 `Pool`，其余走 `ProxyAgent`，
  所以 no_proxy 与协议差异是按请求判定的，与状态页展示一致。
- **直连策略必须显式短路**：`kind !== 'proxied'` 时全部返回 `Pool`。否则会落到
  `ProxyAgent({uri: undefined})` → `InvalidArgumentError: Proxy uri is mandatory`，
  表现为请求失败于 `UND_ERR_INVALID_ARG`。（这是实测中发现的**真实 bug**，已修 + 已加回归测试。）

### 2.3 插件打包（dsh 第三方插件规范）

- 纯 npm 包，`type: module`，`main: lib/index.js`，`exports` 提供 `.` 与 `./client`。
- `dsh.bundle.patch: ./cordis.patch.yml` → 提供 loader 插入行 `{id: proxy-switcher, name: dsh-proxy-switcher}`。
- `dsh.client: { platform: "web" }` → 客户端模块系统扫描已启用的 loader 行，按 `./client` 下发。
- **浏览器半是手写 classic script**：`window.__ModuleLoader__.load({ id, factory })`，
  `factory` 是**同步 CJS**（`factory(require) => exports`），只能 `require` 平台 seed 模块：
  `react`、`@deepseek-ai/dsh-client-ui-primitives`（本插件只用这两个）。
  所有 `require` 都做了 try/catch 降级——factory 里抛异常会让**整页启动失败**。
- 设置页通过 `ctx.slots.inject('settings.section', …)` 注册：
  `{ name:'settings.section', id:'proxy', order:60, label:()=>'Proxy', inject:()=> ({}) }`。
- 第三方插件**无法新增 `@Remote`/typert 命名空间**（那是构建期生成的），所以宿主↔浏览器
  通信用 `ctx.webServer.register({kind:'prefix', path:'/dsh-proxy-switcher', handler})` + 浏览器 `fetch`，
  与 `dsh-hot-reload`、`dsh-whale-widget`、`dsh-better-sidebar` 同一套路。

### 2.4 设置界面（Settings → Proxy）

- **Currently in force**：生效模式/代理、判定原因、传输策略、no_proxy、切换次数与耗时、
  配置文件路径、上次错误（含时间）、启动环境代理、"Re-read env & apply" / "Test current" / "Refresh"。
- **Mode**：`Use a proxy` 开关 + 三选一（Direct / System / Saved proxy）。
- **Saved proxies**：列表 + 单选即时切换 + 每项 Test / Edit + Add proxy。
- **编辑器**：协议(HTTP/HTTPS/SOCKS5)、主机、端口、用户名、**密码（type=password 掩码）**、
  密码来源环境变量、该代理独立 no_proxy、Test this proxy / Delete。
- **Advanced**：全局 no_proxy、探测 URL、超时、"代理缺失时"（拒绝请求 / 直连）、连续失败自动回退 + 阈值。
- **Recent activity**：脱敏历史。
- **Save and apply** / **Discard changes**。

一键切换（开关、模式、代理单选）立即生效**并保存**；编辑器改动需 Save and apply；
API 支持 `persist:false` 做**仅本进程生效的临时切换**。

### 2.5 配置与优先级

配置文件 `$DSH_HOME/proxy-switcher.json`（可由 `DSH_PROXY_SWITCHER_CONFIG` 覆盖）：

```jsonc
{
  "enabled": true, "mode": "custom", "activeProfile": "clash",
  "profiles": [{ "id":"clash","name":"Clash","protocol":"http","host":"127.0.0.1","port":7890,
                 "username":"","password":"","passwordEnv":"","noProxy":"" }],
  "noProxy": "localhost,127.0.0.1,::1,[::1]", "bypassLoopback": true,
  "probeUrl": "https://www.gstatic.com/generate_204", "timeoutMs": 15000,
  "onMissingProfile": "block",
  "fallback": { "mode": "off", "failureThreshold": 3 },
  "historyLimit": 50
}
```

优先级：**运行时设置（设置页 / `/proxy` / API） > 环境变量 > 配置文件 > 默认值**

环境变量：`DSH_PROXY_SWITCHER_ENABLED` / `_MODE`(`direct|system|custom|off`) / `_PROFILE` /
`_URL`（直接用一条 URL，隐式 custom，优先级最高）/ `_NO_PROXY` / `_CONFIG`。

其它管理入口：

- **`/proxy` 命令**：`status` · `on` · `off` · `direct` · `system` · `use <id>` · `temp <id>` · `test [id]`
- **plugin API**：`ctx.proxySwitcher.status()/config()/configure(patch)/applyRuntime(patch)/reset()/test(candidate)`
- **HTTP**：`GET state|status`，`POST apply|reset|reapply|test`（同源 + loopback 校验）

### 2.6 安全

- 密码**永不回传浏览器**：返回 `password: ""` + `hasPassword` + 掩码预览（`socks5://user:***@host:port`）；
  未重填时客户端回传哨兵 `__KEEP__` 表示"保持不变"（显式空串才是清除）。
- 日志 / 状态 / 历史 / 错误 `cause` 链**统一脱敏**。
  **这是实测发现并修掉的真实缺陷**：状态曾把实时代理环境变量（含明文密码）原样带出到 HTTP 响应。
- 推荐 `passwordEnv`（密钥不落盘，且每请求重读，轮换无需重启）；写文件用 `0600`。
- 接口做同源 + loopback 校验，跨站返回 403。

### 2.7 安装 / 卸载 / 升级 / 回滚

```powershell
pwsh -File install.ps1              # 默认 desktop profile
pwsh -File uninstall.ps1            # 撤销
pwsh -File uninstall.ps1 -RestoreBackup
```

安装只做三件事，全部可逆：备份 profile `package.json` → 在 `<profile>/node_modules/` 建指向本目录的
**junction** → 把包名写入 `dependencies` 与 `dsh.profile.bundles`。
**不跑 pnpm、不联网、不动 lockfile**，因此不可能影响用户原有环境。
卸载后插件在 unload 时把启动时的 dispatcher 与代理环境变量**原样放回**（验收 8 有测试）。
升级＝覆盖本目录后重载；回滚＝把 junction 指回旧版本目录，或 `-RestoreBackup`。

---

## 3. 测试结果

### 3.1 单元 / 集成 / 验收：**42 用例 / 4 文件，全部通过**

```powershell
pwsh -File test/run-tests.ps1
```

运行器用 **DSH 自己的运行时**（Electron-as-Node 24.18.1），并**先清空本 shell 的代理环境变量**，
避免本机代理配置掩盖结果。全部用本地假代理（HTTP 代理 / SOCKS5 代理 / origin），**不联网**。

| 文件 | 用例 | 覆盖 |
|---|---|---|
| `test/config.test.mjs` | 15 | 代理 URL 解析（含 IPv6/默认端口/socks5h 别名/非法协议）、优先级链、空值不覆盖、`_MODE=off`、`_URL` 隐式 profile、no_proxy 全部形式（子域/前导点/端口/CIDR/`*`）、脱敏、密码哨兵、部分补丁、原子落盘 0600、坏文件不致命 |
| `test/transport.test.mjs` | 11 | 热切换（p1→p2→direct→p1）、恢复启动传输、SOCKS5（原生 + 401/拒绝回复）、代理凭证、no_proxy 绕过、undici 实例选择、**直连 own-dispatcher 回归** |
| `test/switcher.test.mjs` | 10 | **逐条验收 1–8**、运行时覆盖仅本进程、环境层压过文件层、密码保留、凭证不泄漏进 status/history |
| `test/plugin-contract.test.mjs` | 6 | 宿主半：契约导出、路由/命令/服务注册与卸载、路由处理器（同源 403、各 action、错误体）；浏览器半：`__ModuleLoader__` classic script 结构、只 require seed 模块、slot 注册契约、`renderToString` 可渲染、缺 primitive 降级为 no-op |

验收标准 ↔ 测试映射：

| 验收 | 覆盖用例 |
|---|---|
| 1 设置界面切换"是否使用代理" | `acceptance 1,3,4,5`（`enabled:false` → 直连） |
| 2 直连 / 系统 / 自定义 / 多代理可选 | `acceptance 2` |
| 3 切直连后目标网络允许即可连 | `acceptance 2`（本地 origin 直连成功）+ `restore` 用真实 origin 正向证明 |
| 4 切自定义代理后无需重启，新请求走新代理 | `acceptance 1,3,4,5`（切完立刻 `fetch` 走新代理） |
| 5 状态正确显示模式与代理地址 | `acceptance 1,3,4,5` 断言 `configuredMode`/`effectiveProxy`/`strategy` |
| 6 配置错误/认证失败/超时有明确错误与日志 | `acceptance 6`、`acceptance 6b` |
| 7 重启后恢复上次代理模式 | `acceptance 7`（新建实例读同一文件 → 旧代理生效；临时覆盖**不**持久化） |
| 8 安装卸载不影响原有功能 | `acceptance 8`（`stop()` 后代理消失但传输仍可用）+ 宿主半卸载移除路由 |

### 3.2 机制探针（`probe/`，保留作原始证据）

| 探针 | 结论 |
|---|---|
| `probe-env3.mjs` | 运行期改代理环境变量**无效**（bootstrap 定型） |
| `probe-global-dispatcher2.mjs` | 全局槽位**可热切换且可逆**，最后写入者生效 |
| `probe-dispatcher-placements.mjs` | 全局槽位对 Agent/ProxyAgent/SOCKS5 全通；**显式 8.x dispatcher 必失败**；`undici.fetch` 同实例可用 |
| `probe-undici-exports.mjs` | 插件确实解析到宿主那份 undici **8.11.2**，且其 CJS 导出含 `fetch` |

### 3.3 真机（运行中的 dsh）实测

安装后 **loader 直接把插件挂进了运行中的 dsh，完全没有重启**。实测：

```
GET /dsh-proxy-switcher/status
  ready=true  configuredMode=system  effectiveKind=proxied
  effectiveProxy=http://127.0.0.1:7890   reason="env proxy"
  blocked=false  fellBack=false  lastError=""
  transport.strategy=delegate
  capabilities.dshHttpProxyVersion=0.2.0-rc.2
  capabilities.undiciSource=dsh-proxy-switcher(经 dsh-http-proxy) -> ...\undici\index.js
  capabilities.undiciVersion=8.11.2   nativeSocks5=true
```

- **热切换**：`POST /apply {persist:false, override:{mode:'direct'}}` → **14ms** 后 `effectiveKind=direct`；
  `POST /reset` → 立即回到 `http://127.0.0.1:7890`，`runtimeOverride=null`、无错误、无回退。全程未重启。
- **插件管理视角**：`dsh-proxy-switcher@1.0.0` 以 `installed=true / enabled=true /
  removable=true`、行 `include:proxy-switcher` 出现在 bundle 列表中。
- **未确证的一条**：切到 direct 后，用 dsh 自己的 `web_fetch` 访问 `google.com` **仍然成功**。
  可能原因是本机直连 Google 本就可达，或 `web_fetch` 有缓存，因此
  **「真机上切 direct 后连接确实走直连」没有得到决定性验证**。
  单测里有等价的决定性验证（本地假代理 + 不可解析目标），但真机这一步建议在
  "能直连 / 不能直连"的网络里各试一次。

---

## 4. 兼容性与已知限制

| 项 | 范围 |
|---|---|
| dsh | 0.2.0-rc.1+（自动复用 `dsh-http-proxy`）；更早版本（如 0.1.0-rc.7）走自建路径 |
| 运行时 | Node 22.19+ / 24+（实测 Electron 44 ↔ 24.18.1，bundled 24.21.0） |
| 操作系统 | Windows 实测；实现只用 `node:net` / `node:tls` / `undici`，无平台专属代码 |
| 协议 | `http` · `https` · `socks5`/`socks5h`（域名远端解析） |
| 覆盖流量 | 所有走全局 `fetch` 的路径（LLM、搜索、`web_fetch`、MCP HTTP） |

限制：

1. **OTLP 遥测不走代理**（`node:http` 自建 agent，dsh 官方也这么记录）。可用 `DSH_TELEMETRY_MODE=DISABLED`。
2. **SOCKS5 下 `web_fetch` 会直连**：官方 seam 拒绝 SOCKS → `proxyRouteFor()` 报"未代理" →
   `web_fetch` 用它自己 pin 地址的 agent 直连。其它链路在 SOCKS5 下正常。要覆盖它必须改 dsh 本身。
3. **`system` 模式不是每请求重读环境变量**：装上的传输是策略快照（官方 seam 的设计，保证单一真值来源）。
   改 `http_proxy` 后点设置页 **Re-read env & apply**（或 `/proxy on`）即可，无需重启。
4. **切换瞬间有极短窗口**（先还原再安装），窗口内新请求用启动时策略；在途请求不受影响。
5. **`onMissingProfile` 默认 `block`**：宁可明确报错也不静默直连（避免误以为走了代理）。
6. **模型自编程序 / worker 拿不到代理**（dsh 有意为之）。
7. 插件依赖**宿主已装 `dsh-http-proxy`** 才能覆盖 `web_fetch`；缺失时仅直连全局传播层。

---

## 5. 交付物清单

| 文件 | 说明 |
|---|---|
| `README.md` | 原理、安装/卸载/升级/回滚、配置、限制、实测记录 |
| `lib/index.js` | 宿主半：Cordis 生命周期、路由、`/proxy` 命令、plugin API |
| `lib/client.js` | 浏览器半：Settings → Proxy 页面（手写 classic script，无需构建） |
| `lib/transport.js` | 全局 dispatcher 安装、策略→传输、undici 实例选择、环境变量发布 |
| `lib/switcher.js` | 策略解析、应用、状态、历史、连通性测试 |
| `lib/config.js` | 默认值、校验、四层优先级、原子持久化、脱敏 |
| `lib/proxy.js` | 代理规格解析、no_proxy 匹配、SOCKS5 connector、脱敏工具 |
| `lib/routes.js` | 设置页 HTTP 接口（同源校验、脱敏、优雅错误） |
| `cordis.patch.yml` | loader 插入行 |
| `package.json` | dsh 插件元数据（`dsh.bundle.patch` / `dsh.client` / optional peers） |
| `config.example.json` | 多代理配置示例 |
| `install.ps1` / `uninstall.ps1` | 安装与回滚（备份 package.json，仅建 junction） |
| `test/`（4 文件 + 假代理 helper + 运行器） | 42 个用例 |
| `probe/`（4 个探针） | 机制断言的原始证据 |
| `notes/01-proxy-analysis.md` | 代理加载路径分析（455 行） |
| `notes/02-plugin-and-settings.md` | 插件与设置扩展机制分析（1950 行） |

---

## 6. 后续建议（3 条）

1. **刷新一次 dsh 页面**：宿主半已热挂载，浏览器半的 bundle 需页面重新拉取才会出现 Proxy 页。
2. **让 dsh 重载 loader**：运行中的进程里还是"修复前"的代码——直连策略退化为
   `ProxyAgent(undefined)` 的 bug（影响 `Test current` 在 direct 下的表现，以及老 dsh 的直连模式）
   已在源码与测试中修复，但需要重载才生效。当前已把运行态恢复为 `system` 代理，无不良影响。
3. **真机复核第 3 条验收**：在"不能直连"的网络里切 direct，确认连接确实失败，即可补齐唯一未确证的环节。
