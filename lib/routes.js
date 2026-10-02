/**
 * The plugin's HTTP surface for the settings page.
 *
 * It runs on dsh's own web server (`ctx.webServer.register`) rather than on the
 * Cordis Remote/typert wire, deliberately: a plain route works on every dsh
 * version this plugin supports, needs no generated schema, and keeps the whole
 * feature inside one package. The page is served from the same origin, so a
 * same-origin check is the whole authorization story — the web server is
 * loopback-bound by default, and the check below refuses a cross-site caller
 * that reaches it anyway.
 *
 * Every response is `no-store` and every payload passes through the redaction
 * helpers, so a stored password is never returned to the browser: the form gets
 * `hasPassword` plus a masked preview and sends back a sentinel to keep it.
 */
import { KEEP_SECRET } from './config.js'

/** Base path every route lives under. */
export const BASE_PATH = '/dsh-proxy-switcher'

/** Largest request body accepted, in bytes. */
const MAX_BODY_BYTES = 256 * 1024

/**
 * Whether a request may reach these routes.
 *
 * A browser attaches `Origin` on cross-site and same-site non-GET requests, so
 * when it is present it must name exactly the authority we were addressed by. A
 * request with no `Origin` (a non-browser client on the loopback interface) is
 * allowed only when it was addressed to a loopback authority.
 *
 * @param req - the incoming request.
 * @returns true when the request is same-origin and locally addressed.
 */
export function isAuthorized(req) {
  const hostHeader = String(req.headers.host ?? '')
  if (hostHeader === '') return false
  const hostName = hostHeader.replace(/:\d+$/, '').replace(/^\[|\]$/g, '').toLowerCase()
  const isLoopback = hostName === 'localhost' || hostName === '127.0.0.1' || hostName === '::1'
  const origin = req.headers.origin
  if (origin === undefined) return isLoopback
  try {
    return new URL(origin).host === hostHeader
  } catch {
    return false
  }
}

/**
 * Send a JSON response that must never be cached.
 * @param res - the server response.
 * @param status - HTTP status.
 * @param payload - JSON-serializable body.
 */
export function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

/**
 * Read and parse a JSON request body within a size cap.
 * @param req - the incoming request.
 * @returns the parsed value; `{}` for an empty body.
 * @throws {Error} when the body is too large or is not valid JSON.
 */
export async function readJsonBody(req) {
  const chunks = []
  let total = 0
  for await (const chunk of req) {
    total += chunk.length
    if (total > MAX_BODY_BYTES) throw new Error(`请求体超过 ${MAX_BODY_BYTES} 字节上限`)
    chunks.push(chunk)
  }
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (text === '') return {}
  return JSON.parse(text)
}

/**
 * Build the route handler that serves the whole feature.
 *
 * @param switcher - the {@link import('./switcher.js').ProxySwitcher} instance.
 * @param options.logger - for reporting malformed requests.
 * @returns a `WebRoute` handler.
 */
export function createHandler(switcher, options = {}) {
  const logger = options.logger ?? console

  /** Dispatch one request to the matching action. */
  return async function handle(req, res) {
    try {
      if (!isAuthorized(req)) {
        sendJson(res, 403, { error: '已拒绝：该接口仅允许同源且来自回环地址的请求' })
        return
      }

      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`)
      const action = url.pathname.slice(BASE_PATH.length).replace(/^\/+|\/+$/g, '')
      const method = req.method ?? 'GET'

      if (method === 'GET' && action === 'state') {
        sendJson(res, 200, { status: switcher.status(), config: switcher.publicConfig() })
        return
      }

      if (method === 'GET' && action === 'status') {
        sendJson(res, 200, switcher.status())
        return
      }

      if (method === 'POST' && action === 'apply') {
        const body = await readJsonBody(req)
        // `persist: false` is a temporary switch confined to this process; the
        // default writes the config file so a restart restores the choice.
        const result = body.persist === false
          ? await switcher.applyRuntime(body.override ?? body)
          : await switcher.saveConfig(body.config ?? body)
        sendJson(res, 200, {
          ok: true,
          persisted: body.persist !== false,
          status: switcher.status(),
          config: switcher.publicConfig(),
          sources: result.sources ?? switcher.effectiveConfig().sources,
        })
        return
      }

      if (method === 'POST' && action === 'reset') {
        await switcher.clearRuntimeOverride()
        sendJson(res, 200, { ok: true, status: switcher.status(), config: switcher.publicConfig() })
        return
      }

      if (method === 'POST' && action === 'reapply') {
        // Re-reads the ambient proxy environment and re-installs the policy,
        // which is how a change to http_proxy/https_proxy reaches a running
        // process in `system` mode.
        await switcher.reapply()
        sendJson(res, 200, { ok: true, status: switcher.status(), config: switcher.publicConfig() })
        return
      }

      if (method === 'POST' && action === 'test') {
        const body = await readJsonBody(req)
        const result = await switcher.testConnection(body.candidate ?? body, {
          probeUrl: body.probeUrl,
          timeoutMs: body.timeoutMs,
        })
        // A failed probe is a normal result, not a transport error: report 200
        // with `ok: false` so the page can show the reason instead of a generic
        // fetch failure.
        sendJson(res, 200, result)
        return
      }

      sendJson(res, 404, { error: `未知操作 ${JSON.stringify(action)}` })
    } catch (error) {
      logger.warn?.(`dsh-proxy-switcher: 请求处理失败: ${error?.message ?? error}`)
      sendJson(res, 400, { error: String(error?.message ?? error) })
    }
  }
}

export { KEEP_SECRET }
