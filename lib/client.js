// dsh-proxy-switcher — browser half: the Proxy page in dsh Settings.
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
//     @deepseek-ai/cordis, and the @deepseek-ai/dsh-client-{ui-slots, web-react,
//     ui-primitives, ui-attachment, schema-form} set. They come from the web
//     shell's own build, so this half needs no other plugin bundle;
//   - `id` must be the package name: the loader resolves "<id>/client" and the
//     bare id to these same exports.
//
// The shell fails its boot if a plugin entry never reaches ACTIVE, so every
// require is guarded and every failure path degrades to a no-op plugin instead
// of throwing at factory scope — otherwise a missing primitive would cost the
// whole page rather than one settings page.
//
// The page talks to its host half over the plugin's own HTTP route. The response
// never contains a stored password: the form receives `hasPassword` and a masked
// preview, and sends KEEP_SECRET back when the user did not retype it.

window.__ModuleLoader__.load({
  id: "dsh-proxy-switcher",
  factory: (require) => {
    let React = null
    let primitives = null
    let seedError = null
    try {
      React = require("react");
      primitives = require("@deepseek-ai/dsh-client-ui-primitives");
    } catch (error) {
      seedError = error;
    }

    /** Must match `BASE_PATH` in lib/routes.js — the halves share no module. */
    const BASE = "/dsh-proxy-switcher";

    /** Must match `KEEP_SECRET` in lib/config.js — the halves share no module. */
    const KEEP_SECRET = "__KEEP__";

    /** Settings page seat. `order` places it after the shipped sections. */
    const SECTION_ID = "proxy";
    const SECTION_ORDER = 60;

    /** Cordis plugin name. */
    const name = "dsh-proxy-switcher";

    /**
     * Required services. Only the slot registry is mandatory: the page reads and
     * writes through `fetch`, so it needs no connection, locale, or settings
     * service, which keeps it working across dsh versions.
     */
    const inject = ["slots"];

    const h = React ? React.createElement : null;

    // ---------------------------------------------------------------- styling
    //
    // A component stylesheet rather than CSS modules, because a hand-written
    // bundle carries no CSS pipeline. Every colour is a --dsw-alias-* token and
    // no rule branches on light/dark, which is the part the styling contract
    // actually cares about.
    const STYLE_ID = "dsh-proxy-switcher-styles";
    const CSS = `
.dshps-root { display: flex; flex-direction: column; gap: 14px; }
.dshps-lede { color: var(--dsw-alias-label-secondary); font-size: 12px; line-height: 18px; margin: 0; }
.dshps-card { border: 1px solid var(--dsw-alias-border-l1); border-radius: 10px;
  background: var(--dsw-alias-bg-layer-1); padding: 14px 16px;
  display: flex; flex-direction: column; gap: 10px; }
.dshps-card-title { display: flex; align-items: center; gap: 8px;
  color: var(--dsw-alias-label-primary); font-size: 13px; font-weight: 600; }
.dshps-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.dshps-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 10px; }
.dshps-field { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.dshps-field > span { color: var(--dsw-alias-label-secondary); font-size: 11px; }
.dshps-input, .dshps-select { width: 100%; box-sizing: border-box;
  background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary);
  border: 1px solid var(--dsw-alias-border-l2); border-radius: 8px;
  padding: 6px 9px; font-size: 12px; font-family: inherit; }
.dshps-input:disabled, .dshps-select:disabled { color: var(--dsw-alias-state-idle-primary); }
.dshps-mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
.dshps-muted { color: var(--dsw-alias-label-secondary); }
.dshps-ok { color: var(--dsw-alias-state-success-primary); }
.dshps-warn { color: var(--dsw-alias-state-warn-primary); }
.dshps-err { color: var(--dsw-alias-state-error-primary); }
.dshps-banner { border-radius: 8px; padding: 8px 10px; font-size: 12px;
  border: 1px solid var(--dsw-alias-border-l1); line-height: 17px; }
.dshps-kv { display: grid; grid-template-columns: max-content 1fr; gap: 4px 12px; font-size: 12px; }
.dshps-kv > dt { color: var(--dsw-alias-label-secondary); }
.dshps-kv > dd { margin: 0; color: var(--dsw-alias-label-primary); overflow-wrap: anywhere; }
.dshps-profiles { display: flex; flex-direction: column; gap: 6px; }
.dshps-profile { display: flex; align-items: center; gap: 8px; padding: 6px 8px;
  border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px; font-size: 12px; }
.dshps-profile-active { border-color: var(--dsw-alias-brand-primary); }
.dshps-profile > .dshps-grow { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dshps-log { max-height: 150px; overflow: auto; font-size: 11px;
  display: flex; flex-direction: column; gap: 2px; }
.dshps-sep { border: 0; border-top: 1px solid var(--dsw-alias-border-l1); margin: 2px 0; }
`;

    /** Install the stylesheet once per document. */
    function ensureStyles() {
      if (typeof document === "undefined") return;
      if (document.getElementById(STYLE_ID) !== null) return;
      const style = document.createElement("style");
      style.id = STYLE_ID;
      style.textContent = CSS;
      document.head.appendChild(style);
    }

    // ------------------------------------------------------------------ wire

    /**
     * Call the host half.
     * @param action - the route suffix, e.g. "state".
     * @param options.method - HTTP method; defaults to GET.
     * @param options.body - JSON body for writes.
     * @returns the parsed JSON payload.
     */
    async function call(action, options = {}) {
      const method = options.method ?? "GET";
      const response = await fetch(`${BASE}/${action}`, {
        method,
        headers: options.body === undefined ? undefined : { "content-type": "application/json" },
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        credentials: "same-origin",
        cache: "no-store",
      });
      const text = await response.text();
      let payload = null;
      try {
        payload = text === "" ? null : JSON.parse(text);
      } catch {
        throw new Error(`${action}：宿主返回了非 JSON 响应（HTTP ${response.status}）`);
      }
      if (!response.ok) {
        throw new Error((payload && payload.error) || `${action} 请求失败，HTTP ${response.status}`);
      }
      return payload;
    }

    // -------------------------------------------------------------- helpers

    /** A copy of the redacted config that the form can edit. */
    function toDraft(config) {
      return {
        enabled: config.enabled,
        mode: config.mode,
        activeProfile: config.activeProfile,
        noProxy: config.noProxy,
        probeUrl: config.probeUrl,
        timeoutMs: config.timeoutMs,
        onMissingProfile: config.onMissingProfile,
        bypassLoopback: config.bypassLoopback,
        fallback: { mode: config.fallback.mode, failureThreshold: config.fallback.failureThreshold },
        profiles: config.profiles.map((profile) => ({
          id: profile.id,
          name: profile.name,
          protocol: profile.protocol,
          host: profile.host,
          port: profile.port,
          username: profile.username,
          // Never a stored secret: the field starts empty and an untouched field
          // is sent back as KEEP_SECRET, which the host reads as "leave it".
          password: "",
          passwordEnv: profile.passwordEnv,
          noProxy: profile.noProxy,
          hasPassword: profile.hasPassword,
          maskedUrl: profile.maskedUrl,
        })),
      };
    }

    /** Short relative time for the status line. */
    function ago(iso) {
      if (!iso) return "从未";
      const ms = Date.now() - new Date(iso).getTime();
      if (!Number.isFinite(ms) || ms < 0) return "刚刚";
      if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))} 秒前`;
      if (ms < 3_600_000) return `${Math.round(ms / 60_000)} 分钟前`;
      return `${Math.round(ms / 3_600_000)} 小时前`;
    }

    /**
     * Turn an editable draft into the document the host stores.
     *
     * The important rule is the password sentinel: an empty field on a profile
     * that already HAS a stored password means "leave it alone", not "erase it".
     * Only an explicit edit replaces or clears a secret, and the host never sends
     * the stored value to the browser in the first place.
     *
     * @param draft - the form state.
     * @returns a config patch safe to POST.
     */
    function toPayload(draft) {
      return {
        enabled: draft.enabled,
        mode: draft.mode,
        activeProfile: draft.activeProfile,
        noProxy: draft.noProxy,
        probeUrl: draft.probeUrl,
        timeoutMs: draft.timeoutMs,
        onMissingProfile: draft.onMissingProfile,
        bypassLoopback: draft.bypassLoopback,
        fallback: draft.fallback,
        profiles: draft.profiles.map((profile) => ({
          id: profile.id,
          name: profile.name,
          protocol: profile.protocol,
          host: profile.host,
          port: profile.port,
          username: profile.username,
          password: profile.password === "" && profile.hasPassword ? KEEP_SECRET : profile.password,
          passwordEnv: profile.passwordEnv,
          noProxy: profile.noProxy,
        })),
      };
    }

    /** One labelled form field wrapping a native control. */
    function Field(props) {
      return h("label", { className: "dshps-field" },
        h("span", null, props.label),
        props.children,
      );
    }

    /** One definition-list row. */
    function Kv(props) {
      return h(React.Fragment, null,
        h("dt", null, props.label),
        h("dd", { className: props.className ?? "" }, props.children),
      );
    }

    // ------------------------------------------------------------ the page

    /**
     * The Proxy settings section.
     * @param props - `{ close }` from the slot plus the inject face.
     */
    function ProxySection(props) {
      const Button = primitives.Button;
      const StateDot = primitives.StateDot;
      const Input = primitives.Input;

      const [snapshot, setSnapshot] = React.useState(null);
      const [draft, setDraft] = React.useState(null);
      const [busy, setBusy] = React.useState(null);
      const [notice, setNotice] = React.useState(null);
      const [probe, setProbe] = React.useState(null);
      const [editing, setEditing] = React.useState(null);

      React.useEffect(() => { ensureStyles(); }, []);

      /** Reload host state; the draft follows unless the user is mid-edit. */
      const reload = React.useCallback(async (options = {}) => {
        try {
          const payload = await call("state");
          setSnapshot(payload);
          setDraft((current) => (options.resetDraft === false && current !== null ? current : toDraft(payload.config)));
          if (options.quiet !== true) setNotice(null);
        } catch (error) {
          setNotice({ kind: "err", text: `无法读取代理设置：${error.message}` });
        }
      }, []);

      React.useEffect(() => { void reload(); }, [reload]);

      /** Persist the whole draft and apply it. */
      async function save() {
        setBusy("save");
        setNotice(null);
        try {
          const payload = await call("apply", { method: "POST", body: { persist: true, config: toPayload(draft) } });
          setSnapshot(payload);
          setDraft(toDraft(payload.config));
          setNotice({ kind: "ok", text: "已保存并应用。新请求立即走该代理。" });
        } catch (error) {
          setNotice({ kind: "err", text: error.message });
        } finally {
          setBusy(null);
        }
      }

      /**
       * Apply a quick change. Persisted by default so a restart restores it,
       * which is what the acceptance criteria ask for; the "temporary" toggle
       * turns it into a process-only switch.
       */
      async function quick(patch, options = {}) {
        setBusy(options.key ?? "quick");
        setNotice(null);
        try {
          const body = options.persist === false
            ? { persist: false, override: patch }
            : { persist: true, config: patch };
          const payload = await call("apply", { method: "POST", body });
          setSnapshot(payload);
          setDraft(toDraft(payload.config));
          setNotice({
            kind: "ok",
            text: options.persist === false
              ? "仅对当前运行的 dsh 生效（未保存）。"
              : "已应用并保存。",
          });
        } catch (error) {
          setNotice({ kind: "err", text: error.message });
        } finally {
          setBusy(null);
        }
      }

      /** Probe without changing anything. */
      async function test(candidate, key) {
        setBusy(key);
        setProbe(null);
        try {
          const result = await call("test", { method: "POST", body: { candidate } });
          setProbe(result);
          void reload({ quiet: true });
        } catch (error) {
          setProbe({ ok: false, message: error.message, target: "", ms: 0 });
        } finally {
          setBusy(null);
        }
      }

      /** Drop the process-only override. */
      async function resetOverride() {
        setBusy("reset");
        try {
          const payload = await call("reset", { method: "POST", body: {} });
          setSnapshot(payload);
          setDraft(toDraft(payload.config));
          setNotice({ kind: "ok", text: "临时覆盖已清除；已保存的配置重新生效。" });
        } catch (error) {
          setNotice({ kind: "err", text: error.message });
        } finally {
          setBusy(null);
        }
      }

      /**
       * Re-read the ambient proxy environment and re-install the policy. This is
       * the one action that picks up an edited http_proxy/https_proxy without a
       * restart: the installed transport follows a policy snapshot, so a new
       * environment value needs an explicit re-apply.
       */
      async function reapply() {
        setBusy("reapply");
        try {
          const payload = await call("reapply", { method: "POST", body: {} });
          setSnapshot(payload);
          setDraft(toDraft(payload.config));
          setNotice({
            kind: "ok",
            text: payload.status.systemProxy.url
              ? `已重新读取环境，并应用 ${payload.status.systemProxy.url}。`
              : "已重新读取环境：其中未设置代理，因此本进程直连。",
          });
        } catch (error) {
          setNotice({ kind: "err", text: error.message });
        } finally {
          setBusy(null);
        }
      }

      if (seedError !== null || h === null || draft === null || snapshot === null) {
        return h("div", { className: "dshps-root" },
          h("p", { className: "dshps-lede" },
            seedError !== null
              ? `dsh-proxy-switcher：当前 dsh 构建缺少一个 UI 基础组件，页面无法渲染（${String(seedError.message ?? seedError)}）。插件的 /proxy 命令与设置 API 仍可正常使用。`
              : snapshot === null && seedError === null
                ? "正在加载代理设置…"
                : "代理设置不可用。"),
        );
      }

      const { status, config } = snapshot;
      const state = status.blocked
        ? { tone: "error", label: "配置有误" }
        : !status.enabled || status.effectiveKind === "direct"
          ? { tone: "idle", label: "直连（不使用代理）" }
          : { tone: "done", label: status.effectiveProxy };
      const dotState = state.tone === "done" ? "done" : state.tone === "error" ? "error" : "warning";

      /** Patch one top-level draft field. */
      const patchDraft = (patch) => setDraft((current) => ({ ...current, ...patch }));

      /** A profile's display name, falling back to its address. */
      const profileName = (profile) => (profile.name || "").trim()
        || profile.maskedUrl
        || `${profile.protocol}://${profile.host}:${profile.port}`;

      /** Patch one profile in the draft. */
      const patchProfile = (index, patch) => setDraft((current) => ({
        ...current,
        profiles: current.profiles.map((profile, i) => (i === index ? { ...profile, ...patch } : profile)),
      }));

      /** Add a blank profile and open it for editing. */
      const addProfile = () => {
        setDraft((current) => {
          const id = `proxy-${current.profiles.length + 1}`;
          const profiles = [...current.profiles, {
            id, name: "新代理", protocol: "http", host: "127.0.0.1", port: 7890,
            username: "", password: "", passwordEnv: "", noProxy: "",
            hasPassword: false, maskedUrl: "",
          }];
          setEditing(profiles.length - 1);
          return { ...current, profiles, mode: "custom", activeProfile: id, enabled: true };
        });
      };

      /** Remove a profile from the draft. */
      const removeProfile = (index) => {
        setDraft((current) => {
          const profiles = current.profiles.filter((_, i) => i !== index);
          const activeProfile = profiles.some((p) => p.id === current.activeProfile)
            ? current.activeProfile
            : profiles[0]?.id ?? null;
          setEditing(null);
          return { ...current, profiles, activeProfile };
        });
      };

      const activeIndex = draft.profiles.findIndex((profile) => profile.id === draft.activeProfile);
      const activeProfile = activeIndex >= 0 ? draft.profiles[activeIndex] : null;

      return h("div", { className: "dshps-root" },

        // ---- lede -----------------------------------------------------------
        h("p", { className: "dshps-lede" },
          "选择当前运行的 dsh 如何访问网络。改动在下一个请求即生效——无需重启。"),

        // ---- current status -------------------------------------------------
        h("section", { className: "dshps-card" },
          h("div", { className: "dshps-card-title" },
            h(StateDot, { state: dotState, size: 10 }),
            h("span", null, "当前生效"),
          ),
          h("dl", { className: "dshps-kv" },
            h(Kv, { label: "生效目标" }, h("span", { className: "dshps-mono" }, state.label)),
            h(Kv, { label: "模式" },
              status.configuredMode,
              status.fellBack ? h("span", { className: "dshps-warn" }, " — 已自动回退为直连") : null),
            h(Kv, { label: "判定原因" }, status.reason ?? ""),
            h(Kv, { label: "传输策略" },
              `${status.transport.strategy}${status.viaSocks ? " (SOCKS5)" : ""}`),
            h(Kv, { label: "no_proxy" }, status.noProxy || "（空）"),
            h(Kv, { label: "切换次数" },
              `${status.transport.switchCount} 次（上次耗时 ${status.transport.lastSwitchMs ?? 0}ms）`),
            h(Kv, { label: "配置文件" },
              h("span", { className: "dshps-mono" }, status.configPath),
              status.configFileExists ? null : h("span", { className: "dshps-muted" }, " — 尚未创建")),
            status.systemProxy.url
              ? h(Kv, { label: "启动环境代理" }, h("span", { className: "dshps-mono" }, status.systemProxy.url))
              : null,
            h(Kv, { label: "上次错误", className: status.lastError ? "dshps-err" : "dshps-muted" },
              status.lastError ? `${status.lastError}（${ago(status.lastErrorAt)}）` : "无"),
          ),
          status.blocked
            ? h("div", { className: "dshps-banner dshps-err" },
              "请求正在被拒绝：", status.blockReason,
              " 请在下方选择一个代理，或把「选定的代理缺失时」设为「直连」。")
            : null,
          status.runtimeOverride
            ? h("div", { className: "dshps-row" },
              h("span", { className: "dshps-warn" }, "当前存在仅对本进程生效的临时覆盖。"),
              h(Button, { size: "sm", onClick: resetOverride, disabled: busy !== null }, "清除覆盖"))
            : null,
          h("div", { className: "dshps-row" },
            h(Button, {
              size: "sm",
              disabled: busy !== null,
              onClick: () => test({}, "test-current"),
            }, busy === "test-current" ? "测试中…" : "测试当前"),
            h(Button, {
              size: "sm",
              variant: "outline",
              disabled: busy !== null,
              onClick: reapply,
            }, busy === "reapply" ? "重新读取中…" : "重读环境并应用"),
            h(Button, { size: "sm", variant: "ghost", onClick: () => reload() }, "刷新")),
          probe !== null
            ? h("div", { className: `dshps-banner ${probe.ok ? "dshps-ok" : "dshps-err"}` },
              probe.ok ? "✓ " : "✗ ",
              probe.target ? `${probe.target}: ` : "",
              probe.message,
              probe.detail ? h("div", { className: "dshps-muted dshps-mono" }, probe.detail) : null)
            : null,
        ),

        // ---- master switch + mode -------------------------------------------
        h("section", { className: "dshps-card" },
          h("div", { className: "dshps-card-title" }, "模式"),
          h("div", { className: "dshps-row" },
            h("label", { className: "dshps-row", style: { gap: "6px" } },
              h("input", {
                type: "checkbox",
                checked: draft.enabled,
                disabled: busy !== null,
                onChange: (event) => {
                  const enabled = event.target.checked;
                  patchDraft({ enabled });
                  void quick({ enabled }, { key: "toggle" });
                },
              }),
              h("span", null, "使用代理")),
            h("span", { className: "dshps-muted" }, draft.enabled ? "" : "— 所有请求均直连"),
          ),
          h("div", { className: "dshps-grid" },
            ...[["direct", "直连", "完全不使用代理"],
              ["system", "系统 / 环境变量", "沿用 dsh 启动时的代理设置"],
              ["custom", "已保存的代理", "使用下方列出的代理之一"]].map(([value, label, hint]) =>
              h("label", {
                key: value,
                className: "dshps-profile" + (draft.mode === value ? " dshps-profile-active" : ""),
                style: { cursor: "pointer" },
              },
                h("input", {
                  type: "radio",
                  name: "dshps-mode",
                  checked: draft.mode === value,
                  disabled: busy !== null || !draft.enabled,
                  onChange: () => {
                    patchDraft({ mode: value });
                    void quick({ enabled: true, mode: value }, { key: `mode-${value}` });
                  },
                }),
                h("span", { className: "dshps-grow" },
                  h("div", null, label),
                  h("div", { className: "dshps-muted" }, hint)))),
          ),
          draft.mode === "system"
            ? h("div", { className: "dshps-banner" },
              status.systemProxy.url
                ? `沿用启动环境：${status.systemProxy.url}`
                : "启动环境中未设置代理（http_proxy / https_proxy / all_proxy 均未设置），因此该模式为直连。")
            : null,
        ),

        // ---- saved proxies ---------------------------------------------------
        h("section", { className: "dshps-card" },
          h("div", { className: "dshps-card-title" }, "已保存的代理"),
          draft.profiles.length === 0
            ? h("p", { className: "dshps-lede" }, "尚未保存任何代理。添加一个即可一键切换。")
            : h("div", { className: "dshps-profiles" },
              ...draft.profiles.map((profile, index) =>
                h("div", {
                  key: profile.id,
                  className: "dshps-profile" + (draft.activeProfile === profile.id && draft.mode === "custom" ? " dshps-profile-active" : ""),
                },
                  h("input", {
                    type: "radio",
                    name: "dshps-profile",
                    checked: draft.activeProfile === profile.id,
                    disabled: busy !== null,
                    onChange: () => {
                      patchDraft({ activeProfile: profile.id });
                      void quick({ enabled: true, mode: "custom", activeProfile: profile.id }, { key: `use-${profile.id}` });
                    },
                  }),
                  h("span", { className: "dshps-grow" },
                    h("div", null, profileName(profile)),
                    h("div", { className: "dshps-muted dshps-mono" },
                      profile.maskedUrl || `${profile.protocol}://${profile.host}:${profile.port}`)),
                  h(Button, {
                    size: "sm",
                    disabled: busy !== null,
                    onClick: () => test({ candidate: undefined, profileId: profile.id }, `test-${profile.id}`),
                  }, busy === `test-${profile.id}` ? "…" : "测试"),
                  h(Button, {
                    size: "sm",
                    variant: "ghost",
                    onClick: () => setEditing(editing === index ? null : index),
                  }, editing === index ? "收起" : "编辑"))),
            ),
          h("div", { className: "dshps-row" },
            h(Button, { size: "sm", variant: "outline", onClick: addProfile, disabled: busy !== null }, "添加代理")),
        ),

        // ---- editor ----------------------------------------------------------
        editing !== null && draft.profiles[editing] !== undefined
          ? (() => {
            const profile = draft.profiles[editing];
            return h("section", { className: "dshps-card" },
              h("div", { className: "dshps-card-title" }, `编辑“${profileName(profile)}”`),
              h("div", { className: "dshps-grid" },
                h(Field, { label: "名称" },
                  h("input", {
                    className: "dshps-input", value: profile.name,
                    placeholder: "例如：公司代理",
                    onChange: (e) => patchProfile(editing, { name: e.target.value }),
                  })),
                h(Field, { label: "协议" },
                  h("select", {
                    className: "dshps-select", value: profile.protocol,
                    onChange: (e) => patchProfile(editing, { protocol: e.target.value }),
                  },
                    h("option", { value: "http" }, "HTTP"),
                    h("option", { value: "https" }, "HTTPS"),
                    h("option", { value: "socks5" }, "SOCKS5"))),
                h(Field, { label: "主机" },
                  h("input", {
                    className: "dshps-input dshps-mono", value: profile.host,
                    onChange: (e) => patchProfile(editing, { host: e.target.value }),
                  })),
                h(Field, { label: "端口" },
                  h("input", {
                    className: "dshps-input dshps-mono", type: "number", value: profile.port,
                    onChange: (e) => patchProfile(editing, { port: Number(e.target.value) }),
                  })),
                h(Field, { label: "用户名" },
                  h("input", {
                    className: "dshps-input", value: profile.username, autoComplete: "off",
                    onChange: (e) => patchProfile(editing, { username: e.target.value }),
                  })),
                h(Field, { label: profile.hasPassword ? "密码（已保存 — 留空表示保持不变）" : "密码" },
                  h("input", {
                    className: "dshps-input", type: "password", value: profile.password,
                    autoComplete: "new-password", placeholder: profile.hasPassword ? "••••••••" : "",
                    onChange: (e) => patchProfile(editing, { password: e.target.value }),
                  })),
                h(Field, { label: "从环境变量读取密码（推荐）" },
                  h("input", {
                    className: "dshps-input dshps-mono", value: profile.passwordEnv,
                    placeholder: "MY_PROXY_PASSWORD",
                    onChange: (e) => patchProfile(editing, { passwordEnv: e.target.value }),
                  })),
              ),
              h(Field, { label: "该代理的 no_proxy（逗号分隔）" },
                h("input", {
                  className: "dshps-input dshps-mono", value: profile.noProxy,
                  placeholder: "localhost,127.0.0.1,*.internal",
                  onChange: (e) => patchProfile(editing, { noProxy: e.target.value }),
                })),
              h("p", { className: "dshps-lede" },
                "若不指定环境变量，密码会保存在配置文件中。",
                "指定环境变量可让密钥不落盘，并在每次请求时重新读取，因此轮换密码无需重启。"),
              h("div", { className: "dshps-row" },
                h(Button, {
                  size: "sm", disabled: busy !== null,
                  onClick: () => test({
                    candidate: {
                      protocol: profile.protocol, host: profile.host, port: profile.port,
                      username: profile.username,
                      password: profile.password === "" && profile.hasPassword ? undefined : profile.password,
                      passwordEnv: profile.passwordEnv,
                    },
                  }, `test-draft-${editing}`),
                }, busy === `test-draft-${editing}` ? "测试中…" : "测试此代理"),
                h(Button, { size: "sm", variant: "outline", onClick: () => removeProfile(editing) }, "删除"),
                h(Button, { size: "sm", variant: "ghost", onClick: () => setEditing(null) }, "收起")),
            );
          })()
          : null,

        // ---- advanced --------------------------------------------------------
        h("section", { className: "dshps-card" },
          h("div", { className: "dshps-card-title" }, "高级"),
          h(Field, { label: "全局 no_proxy（逗号分隔的主机后缀）" },
            h("input", {
              className: "dshps-input dshps-mono", value: draft.noProxy,
              onChange: (e) => patchDraft({ noProxy: e.target.value }),
            })),
          h("div", { className: "dshps-grid" },
            h(Field, { label: "用于「测试」的探测 URL" },
              h("input", {
                className: "dshps-input dshps-mono", value: draft.probeUrl,
                onChange: (e) => patchDraft({ probeUrl: e.target.value }),
              })),
            h(Field, { label: "超时（毫秒）" },
              h("input", {
                className: "dshps-input", type: "number", value: draft.timeoutMs,
                onChange: (e) => patchDraft({ timeoutMs: Number(e.target.value) }),
              })),
            h(Field, { label: "选定的代理缺失时" },
              h("select", {
                className: "dshps-select", value: draft.onMissingProfile,
                onChange: (e) => patchDraft({ onMissingProfile: e.target.value }),
              },
                h("option", { value: "block" }, "拒绝请求（更安全）"),
                h("option", { value: "direct" }, "直连"))),
            h(Field, { label: "代理连续失败时" },
              h("select", {
                className: "dshps-select", value: draft.fallback.mode,
                onChange: (e) => patchDraft({ fallback: { ...draft.fallback, mode: e.target.value } }),
              },
                h("option", { value: "off" }, "继续失败"),
                h("option", { value: "direct" }, "回退为直连"))),
            h(Field, { label: "回退前的失败次数" },
              h("input", {
                className: "dshps-input", type: "number", value: draft.fallback.failureThreshold,
                onChange: (e) => patchDraft({ fallback: { ...draft.fallback, failureThreshold: Number(e.target.value) } }),
              })),
          ),
          h("p", { className: "dshps-lede" },
            "回环地址永远不会走代理。环境变量 ",
            h("code", { className: "dshps-mono" }, "DSH_PROXY_SWITCHER_MODE"),
            "、",
            h("code", { className: "dshps-mono" }, "DSH_PROXY_SWITCHER_PROFILE"),
            " 与 ",
            h("code", { className: "dshps-mono" }, "DSH_PROXY_SWITCHER_URL"),
            " 的优先级高于本页面。"),
        ),

        // ---- history ---------------------------------------------------------
        status.history.length > 0
          ? h("section", { className: "dshps-card" },
            h("div", { className: "dshps-card-title" }, "最近活动"),
            h("div", { className: "dshps-log" },
              ...[...status.history].reverse().map((entry, index) =>
                h("div", {
                  key: `${entry.at}-${index}`,
                  className: entry.level === "error" ? "dshps-err" : entry.level === "warn" ? "dshps-warn" : "dshps-muted",
                }, `${new Date(entry.at).toLocaleTimeString()}  ${entry.message}`))))
          : null,

        // ---- save ------------------------------------------------------------
        h("div", { className: "dshps-row" },
          h(Button, { variant: "primary", onClick: save, disabled: busy !== null },
            busy === "save" ? "保存中…" : "保存并应用"),
          h(Button, { variant: "ghost", onClick: () => { setEditing(null); void reload(); }, disabled: busy !== null },
            "放弃更改"),
          activeProfile !== null && draft.mode === "custom"
            ? h("span", { className: "dshps-muted" }, `已选择：${profileName(activeProfile)}`)
            : null),
        notice !== null
          ? h("div", { className: `dshps-banner ${notice.kind === "ok" ? "dshps-ok" : "dshps-err"}` }, notice.text)
          : null,
      );
    }

    /**
     * Register the section once the settings shell has declared the slot.
     * @param ctx - the client plugin context.
     */
    function apply(ctx) {
      if (h === null) {
        ctx.logger?.warn?.("dsh-proxy-switcher: react 不可用，代理设置页面已禁用");
        return;
      }
      // slots.inject waits for the declaration and disposes with this fiber, so
      // an unknown slot parks quietly instead of throwing.
      ctx.slots.inject("settings.section", () => {
        try {
          return ctx.slots.register({
            name: "settings.section",
            id: SECTION_ID,
            order: SECTION_ORDER,
            label: () => "Proxy",
            inject: () => ({}),
          }, ProxySection);
        } catch (error) {
          ctx.logger?.warn?.("dsh-proxy-switcher: 无法挂载代理设置页面");
          ctx.logger?.warn?.(error);
          return () => {};
        }
      });
    }

    // The loader takes the factory's return value AS the module exports, so the
    // CJS `module.exports` preamble a built bundle carries is not needed here.
    return { apply, inject, name };
  },
});
