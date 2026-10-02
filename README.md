# dsh-proxy-switcher

在 **dsh 运行过程中** 热切换出站代理：直连 / 跟随系统环境变量 / 使用已保存的多个代理
（HTTP · HTTPS · SOCKS5）。切换入口在 **dsh 设置 → Proxy**，改完立即生效，**不需要重启 dsh**。

---

## 1. 这个插件解决什么问题

dsh 的出站请求（LLM 对话、网页搜索、`web_fetch`、模型发现、MCP over HTTP）都走宿主进程的
全局 `fetch`。它背后的代理是 Node 的 `NODE_USE_ENV_PROXY` + `HTTP(S)_PROXY`，而 **这个选择在
进程内只会被解析一次**：

- 启动后修改 `process.env.HTTP_PROXY` → 无效（实测：指向一个死端口仍然照常走原代理）；
- 启动时若没有代理变量、之后再设置 → 同样无效（实测：直接 DNS 失败）。

所以过去换代理只能重启 dsh。本插件把「用哪个代理」从 *启动时决定* 变成 *请求时决定*。

## 2. 热切换原理

### 2.1 唯一的切换点：undici 全局 dispatcher

Node 内置 `fetch` 从 `globalThis[Symbol.for('undici.globalDispatcher.1')]` 取传输层；npm 版
`undici` 的 `setGlobalDispatcher()` 写的正是这个槽位（以及 `.2`）。因此：

```
node_modules/undici 的 setGlobalDispatcher(agent)  →  内置 fetch 立即改走 agent
```

实测（`probe/probe-dispatcher-placements.mjs`，Electron-as-Node 24.18.1）：

| 放置方式 | 结果 |
|---|---|
| 全局槽位 + `Agent` / `Agent{factory}` / `ProxyAgent` | ✅ 全部生效 |
| 全局槽位 + `ProxyAgent("socks5://…")` | ✅ SOCKS5 生效 |
| 显式 `fetch(url, { dispatcher })` + 8.x dispatcher | ❌ `UND_ERR_INVALID_ARG: invalid onRequestStart` |
| `undici.fetch(url, { dispatcher })` 同实例 | ✅ 生效（`dsh-web-fetch-http` 用的就是这种） |

原因：内置 `fetch` 自带一份 undici（24.18.1 内是 7.29.0），而宿主 `undici` 是 8.11.2。
**全局槽位由 Node 做版本适配**，显式传入则原样使用，跨代就报错。所以本插件 **只通过全局槽位**
切换，不包装 `fetch`。

### 2.2 复用 dsh 自带的官方 seam

0.2.x 的 dsh 已经自带 `@deepseek-ai/dsh-http-proxy`（README 明说"SOCKS/PAC/系统代理检测不支持"）。
插件优先调用它导出的 `installProxyFromEnvironment(env, report)`：

- **http/https/直连** → 委托给它。这样三件事同步一致：undici 全局 dispatcher、
  `proxyRouteFor()`（`dsh-web-fetch-http` 靠它决定是否 pin 地址）、子进程继承的代理环境变量。
- **SOCKS5** → 它按设计拒绝 SOCKS，插件改用自己装的全局 dispatcher（8.x 的 `ProxyAgent` 原生支持
  SOCKS5；7.x 则回退到内置的手写 SOCKS5 connector）。

没有 `dsh-http-proxy` 的老版本 dsh（例如本地 0.1.0-rc.7 检出）会全部走自建路径，插件仍可用。

### 2.3 已建立的连接

切换时旧的 dispatcher 用 `close()` 释放（不是 `destroy()`）：**已在途的请求在旧传输上跑完**
（流式回答不会被打断），新请求用新策略。

### 2.4 为什么「系统代理」模式需要点一下 "Re-read env & apply"

安装的传输层是**策略快照**（这也是官方 seam 的设计，保证只有一个真值来源）。所以改了
`http_proxy` 之后，点设置页的 **Re-read env & apply**（或 `/proxy on`）即可，无需重启。

## 3. 安装

```powershell
pwsh -File install.ps1                 # 默认 desktop profile
pwsh -File install.ps1 -Profile web
```

脚本做三件事，全部可逆：备份 profile 的 `package.json` → 在
`<profile>/node_modules/` 建一个指向本目录的 junction → 把包名写入 `dependencies` 和
`dsh.profile.bundles`。**不跑 pnpm、不联网、不动 lockfile。**

安装后需要让 dsh 重新加载 loader，插件才会出现在 **设置 → Proxy**。在此之前它只是磁盘上的文件，
不影响任何行为。

> 也可以用 dsh 官方安装器：`dsh plugin --profile desktop add link:<本目录>`，它会用 pnpm 接管
> 同样的三个步骤。

## 4. 卸载与回滚

```powershell
pwsh -File uninstall.ps1                    # 删 junction + 撤销 package.json 改动
pwsh -File uninstall.ps1 -RestoreBackup     # 另外还原安装前的 package.json
```

卸载后同样需要 dsh 重载 loader。**卸载不影响 dsh 原有功能**：插件在 unload 时会把启动时的
dispatcher 和代理环境变量原样放回（有测试覆盖，见验收 8）。

若要彻底忘记保存的代理，删掉 `$DSH_HOME/proxy-switcher.json` 即可。

**升级**：直接用新版本覆盖本目录（junction 指向的就是它），然后重载 loader。
**回滚**：保留旧版本目录，把 junction 重新指过去，或用 `-RestoreBackup` 还原 profile。

## 5. 设置界面

**Settings → Proxy** 一个页面，包含：

- **Currently in force**：当前生效模式/代理、判定原因、传输策略、no_proxy、切换次数与耗时、
  配置文件路径、上次错误（含时间）。
- **Mode**：`Use a proxy` 总开关 + 三选一（Direct / System / Saved proxy）。
- **Saved proxies**：列表 + 单选切换 + 每项 `Test` / `Edit`；`Add proxy` 新增。
- **编辑器**：协议（HTTP/HTTPS/SOCKS5）、主机、端口、用户名、密码（掩码输入）、
  密码来源环境变量、该代理独立的 `no_proxy`。可单独 `Test this proxy`。
- **Advanced**：全局 `no_proxy`、探测 URL、超时、代理缺失时的行为（拒绝请求 / 直连）、
  连续失败自动回退。
- **Recent activity**：脱敏的操作与错误历史。
- **Save and apply** / **Discard changes** / **Test current** / **Re-read env & apply** / **Refresh**。

一键切换（开关、模式单选、代理单选）会**立即生效并保存**；编辑器里的改动需要 `Save and apply`。
页面上的 `temporary` 语义由 API 的 `persist:false` 提供（当前进程内生效，不写入文件）。

## 6. 配置

配置文件：`$DSH_HOME/proxy-switcher.json`（可用 `DSH_PROXY_SWITCHER_CONFIG` 覆盖）。
示例见 [`config.example.json`](config.example.json)。

字段：`enabled` · `mode`(`direct|system|custom`) · `activeProfile` · `profiles[]`
(`id`,`name`,`protocol`,`host`,`port`,`username`,`password`,`passwordEnv`,`noProxy`) ·
`noProxy` · `bypassLoopback` · `probeUrl` · `timeoutMs` · `onMissingProfile`(`block|direct`) ·
`fallback{mode,failureThreshold}` · `historyLimit`。

### 优先级

```
运行时设置（设置页 / /proxy / API）  >  环境变量  >  配置文件  >  默认值
```

环境变量：

| 变量 | 作用 |
|---|---|
| `DSH_PROXY_SWITCHER_ENABLED` | `1/0` 总开关 |
| `DSH_PROXY_SWITCHER_MODE` | `direct` / `system` / `custom` / `off`（=关闭代理） |
| `DSH_PROXY_SWITCHER_PROFILE` | 选择已保存代理的 id |
| `DSH_PROXY_SWITCHER_URL` | 直接用一条代理 URL（最高优先，隐式 custom） |
| `DSH_PROXY_SWITCHER_NO_PROXY` | 覆盖 no_proxy |
| `DSH_PROXY_SWITCHER_CONFIG` | 配置文件路径 |

### 其它管理方式

- **`/proxy` 命令**：`status` · `on` · `off` · `direct` · `system` · `use <id>` · `temp <id>` · `test [id]`
- **插件 API**（其它 Cordis 插件可用）：`ctx.proxySwitcher.status()/config()/configure(patch)/applyRuntime(patch)/reset()/test(candidate)`
- **HTTP**（设置页用的就是它，同源校验）：`GET state|status`，`POST apply|reset|reapply|test`
  于 `/dsh-proxy-switcher/*`

## 7. 安全

- **密码永不回传浏览器**：接口返回 `password: ""` + `hasPassword` + 掩码预览
  （`socks5://user:***@host:port`），未重填时回传哨兵值表示"保持不变"。
- **日志/状态/历史全部脱敏**：`redactProxyUrl()` 统一处理，含错误的 `cause` 链。
  （这一条是实测发现并修掉的真实缺陷：状态曾把实时代理环境变量原样带出。）
- **推荐用 `passwordEnv`**：密码留在环境变量里，配置文件不落盘，且每次请求重新读取，轮换无需重启。
  写文件时用 `0600` 权限（Windows 上依赖用户目录 ACL）。
- 请求接口做**同源 + loopback 校验**，拒绝跨站调用。

## 8. 兼容性

| 项 | 支持范围 |
|---|---|
| dsh | 0.2.0-rc.1+（自动复用 `dsh-http-proxy`）；更早版本走自建路径 |
| 运行时 | Node 22.19+ / 24+（实测 Electron 44 ↔ Node 24.18.1，bundled Node 24.21.0） |
| 操作系统 | Windows 实测；实现只用 `node:net` / `node:tls` / `undici`，无平台专属代码 |
| 代理协议 | `http` · `https` · `socks5` / `socks5h`（域名远端解析） |
| 覆盖的流量 | 所有走全局 `fetch` 的路径：LLM（deepseek / pi-ai）、web search、`web_fetch`、MCP HTTP |

## 9. 已知限制

1. **OTLP 遥测不走代理**。它用 `node:http` 自建 agent（dsh 官方也这么记录）。需要时用
   `DSH_TELEMETRY_MODE=DISABLED` 关掉。
2. **SOCKS5 下 `web_fetch` 会直连**。`dsh-http-proxy` 按设计拒绝 SOCKS，于是
   `proxyRouteFor()` 报"未代理"，`web_fetch` 就用它自己 pin 地址的 agent 直连。其他链路
   （LLM、搜索）在 SOCKS5 下正常。要覆盖它必须改 dsh 自身。
3. **`system` 模式不是每请求重读**环境变量（见 2.4）。
4. **切换瞬间有一个极短窗口**：先还原再安装，窗口内新请求使用启动时的策略；在途请求不受影响。
5. **`onMissingProfile` 默认 `block`**（宁可明确报错也不静默直连，避免误以为走了代理）。
6. **模型自编程序 / worker 拿不到代理**（dsh 有意为之，避免把带密码的 URL 交给它们）。

## 10. 实测记录（本机，2026-10-02）

安装后 **无需重启**：loader 直接把插件挂进了运行中的 dsh。实测接口返回：

```
GET /dsh-proxy-switcher/status
  ready=true  configuredMode=system  effectiveKind=proxied
  effectiveProxy=http://127.0.0.1:7890   reason="env proxy"
  transport.strategy=delegate
  transport.capabilities.dshHttpProxyVersion=0.2.0-rc.2
  transport.capabilities.undiciSource=dsh-http-proxy -> ...\undici\index.js
  transport.capabilities.undiciVersion=8.11.2   nativeSocks5=true
```

即插件确实复用了官方 seam，并且取的是**宿主那份 undici 8.11.2**（不是 profile 提升的 7.30.0）。

热切换：`POST /apply {persist:false, override:{mode:'direct'}}` → 14ms 内 `effectiveKind` 变为
`direct`；`POST /reset` → 立即回到 `http://127.0.0.1:7890`，无错误、无回退。切换全程未重启 dsh。

**未能确证的一点**：切到 direct 后，用 dsh 自己的 `web_fetch` 访问 Google 仍然成功。可能原因是本机
直连 Google 本来就可通（或 `web_fetch` 有缓存），因此「切 direct 后连接真的走直连」这一条
**没有在本机得到决定性验证**。单测里有决定性的等价验证（`test/transport.test.mjs`
用本地假代理证明请求确实换了出口），但真机上的这最后一步需要你在能直连/不能直连的网络里各试一次。

## 11. 测试

```powershell
pwsh -File test/run-tests.ps1
```

42 个用例 / 4 个文件，全部用本地假代理，不联网、不碰真实代理：

| 文件 | 覆盖 |
|---|---|
| `test/config.test.mjs` | 代理 URL 解析、优先级链、no_proxy 匹配、脱敏、密码哨兵、原子落盘 |
| `test/transport.test.mjs` | 运行时热切换、直连、恢复、SOCKS5（含鉴权与拒绝）、凭证、no_proxy、undici 实例选择、直连 dispatcher 回归 |
| `test/switcher.test.mjs` | 逐条验收（1–8）：开关/模式/保存生效/状态/错误提示/重启恢复/停止还原 |
| `test/plugin-contract.test.mjs` | 宿主半：路由/命令/服务/卸载；浏览器半：`__ModuleLoader__` 契约、slot 注册、可渲染、缺 primitive 降级 |

`probe/` 下保留四个决定性探针（环境变量是否可变、全局槽位是否可热切换、dispatcher 放置组合、
undici 实例选择），它们是本文件所有机制断言的原始证据。

## 12. 源码结构

```
lib/
  proxy.js       代理规格解析、no_proxy 匹配、SOCKS5 connector、脱敏
  config.js      默认值/校验/四层优先级/原子持久化
  transport.js   全局 dispatcher 安装（委托官方 seam 或自建）、环境变量发布、undici 实例选择
  switcher.js    策略解析、应用、状态、历史、连通性测试
  routes.js      设置页的 HTTP 接口（同源校验、脱敏）
  index.js       宿主半：Cordis 生命周期、路由、/proxy 命令、plugin API
  client.js      浏览器半：设置页（手写 classic script，无需构建）
cordis.patch.yml 挂载行
notes/           两篇实现分析报告（代理路径 / 插件与设置扩展机制）
```
