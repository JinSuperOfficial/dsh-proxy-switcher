/**
 * Proxy transport core for dsh-proxy-switcher.
 *
 * Pure, dependency-light, and free of any dsh/cordis import so it can be unit
 * tested and reasoned about on its own. It owns three things:
 *
 *   1. proxy-spec normalisation (protocol / host / port / credentials / no_proxy),
 *   2. dispatcher construction for undici — `ProxyAgent` for http(s) proxies and
 *      a hand-written SOCKS5 connector (undici has no SOCKS support of its own),
 *   3. a small dispatcher cache so switching strategies reuses sockets and
 *      retired strategies are drained (not torn down) while requests are in flight.
 *
 * SECURITY: every value that can reach a log line or an HTTP response goes
 * through {@link redactProxyUrl} / {@link describeProxy} first. Passwords never
 * appear in plain text outside {@link ProxySpec.password} and the config file.
 */
import net from 'node:net'
import tls from 'node:tls'
import { Agent, ProxyAgent } from 'undici'

/** Protocols this plugin can dial. `socks5h` is an alias of `socks5` here. */
export const PROXY_PROTOCOLS = ['http', 'https', 'socks5', 'socks5h']

/** Default port per protocol, used when a spec omits one. */
const DEFAULT_PORTS = { http: 8080, https: 8443, socks5: 1080, socks5h: 1080 }

/** Loopback host names that must never be sent through a proxy. */
const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0'])

/** Error code the connector reports when the proxy refuses to tunnel. */
const SOCKS5_REPLY_ERRORS = {
  0x01: 'general SOCKS server failure',
  0x02: 'connection not allowed by ruleset',
  0x03: 'network unreachable',
  0x04: 'host unreachable',
  0x05: 'connection refused',
  0x06: 'TTL expired',
  0x07: 'command not supported',
  0x08: 'address type not supported',
}

/**
 * Replace the password in a proxy URL with a fixed mask, leaving everything
 * else readable. Safe for logs, status payloads, and error messages.
 * @param value - a proxy URL or any string that may embed one.
 * @returns the same text with any `user:secret@` userinfo masked.
 */
export function redactProxyUrl(value) {
  if (typeof value !== 'string' || value.length === 0) return value
  // Only userinfo before an '@' in an authority is masked; a lone '@' in a path
  // is left alone because the pattern requires a scheme-ish `//` prefix or an
  // explicit user:pass pair.
  return value
    .replace(/(\/\/[^/@\s]*):([^/@\s]*)@/g, '$1:***@')
    .replace(/\b([A-Za-z][A-Za-z0-9+.-]*:\/\/)([^/@\s:]+):([^/@\s]*)@/g, '$1$2:***@')
}

/**
 * Normalise a proxy spec into a canonical, fully-defaulted shape.
 * Accepts either `{ protocol, host, port, username, password }` or a single
 * `url` string (`http://user:pass@host:3128`, `socks5://host:1080`).
 * @param input - profile-like object or URL string.
 * @returns a normalised ProxySpec, or null when the input names no host.
 * @throws {TypeError} when the protocol is not one this plugin can dial.
 */
export function normalizeProxySpec(input) {
  if (input == null) return null
  const raw = typeof input === 'string' ? { url: input } : input

  let protocol = String(raw.protocol ?? '').toLowerCase().replace(/:$/, '')
  let host = raw.host
  let port = raw.port
  let username = raw.username
  let password = raw.password
  let path = ''

  if (raw.url) {
    let parsed
    try {
      parsed = new URL(withSchemeIfMissing(String(raw.url)))
    } catch {
      // An unparseable URL names no usable host; the caller drops the profile
      // rather than failing the whole config load.
      return null
    }
    protocol = protocol || parsed.protocol.replace(':', '').toLowerCase()
    host = host || parsed.hostname
    port = port || (parsed.port === '' ? undefined : Number(parsed.port))
    if (parsed.username) username = decodeURIComponent(parsed.username)
    if (parsed.password) password = decodeURIComponent(parsed.password)
    path = parsed.pathname && parsed.pathname !== '/' ? parsed.pathname : ''
  }

  if (protocol === 'socks5h') protocol = 'socks5'
  if (!protocol) protocol = 'http'
  if (!PROXY_PROTOCOLS.includes(protocol) && protocol !== 'socks5') {
    throw new TypeError(`unsupported proxy protocol ${JSON.stringify(raw.protocol)} (expected one of ${PROXY_PROTOCOLS.join(', ')})`)
  }
  if (typeof host !== 'string' || host.length === 0) return null

  host = host.replace(/^\[|\]$/g, '')
  const numericPort = port == null || port === '' ? DEFAULT_PORTS[protocol] ?? 8080 : Number(port)
  if (!Number.isInteger(numericPort) || numericPort <= 0 || numericPort > 65535) {
    throw new TypeError(`invalid proxy port ${JSON.stringify(port)}`)
  }

  return {
    protocol,
    host,
    port: numericPort,
    username: username ? String(username) : undefined,
    password: password ? String(password) : undefined,
    path,
  }
}

/** Prefix a bare `host:port` with a scheme so `new URL` accepts it. */
function withSchemeIfMissing(value) {
  return /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(value) ? value : `http://${value}`
}

/**
 * Build the URL a dispatcher dials, including credentials when present.
 * @param spec - a normalised spec.
 * @returns the dial URL; its userinfo is the only place a password appears.
 */
export function proxyDialUrl(spec) {
  const credentials = spec.username
    ? `${encodeURIComponent(spec.username)}:${encodeURIComponent(spec.password ?? '')}@`
    : ''
  const host = spec.host.includes(':') ? `[${spec.host}]` : spec.host
  return `${spec.protocol}://${credentials}${host}:${spec.port}${spec.path ?? ''}`
}

/**
 * A display form of a proxy that is safe to log and to send to the browser.
 * @param spec - a normalised spec, or null/undefined for "no proxy".
 * @returns a short label plus its masked URL.
 */
export function describeProxy(spec) {
  if (spec == null) return { label: '直连（不使用代理）', url: '', hasAuth: false }
  const host = spec.host.includes(':') ? `[${spec.host}]` : spec.host
  const url = `${spec.protocol}://${host}:${spec.port}`
  return {
    label: url,
    url: spec.username ? redactProxyUrl(`${spec.protocol}://${spec.username}:${spec.password ?? ''}@${host}:${spec.port}`) : url,
    hasAuth: Boolean(spec.username),
  }
}

/**
 * Whether a host/port pair is exempt from proxying.
 *
 * Semantics follow the usual `no_proxy` contract: entries are comma or space
 * separated; `*` matches everything; a leading dot (or `*.`) matches the domain
 * and its subdomains; a bare domain also matches subdomains; an entry may carry
 * `:port`; IPv4 CIDR ranges and IP literals are supported; loopback is matched
 * by host name.
 *
 * @param hostname - destination host (no brackets).
 * @param port - destination port, when known.
 * @param noProxy - raw no_proxy string, or an array of entries.
 * @returns true when the request must bypass every proxy.
 */
export function matchesNoProxy(hostname, port, noProxy) {
  const entries = Array.isArray(noProxy)
    ? noProxy
    : String(noProxy ?? '').split(/[\s,]+/)
  const host = String(hostname ?? '').toLowerCase().replace(/^\[|\]$/g, '')
  if (host === '') return false

  for (const rawEntry of entries) {
    const entry = String(rawEntry ?? '').trim().toLowerCase()
    if (entry === '') continue
    if (entry === '*') return true

    // Optional :port suffix (IPv6 literals carry brackets, so only split when
    // there is exactly one colon).
    let pattern = entry
    let entryPort
    const colonCount = (entry.match(/:/g) ?? []).length
    if (colonCount === 1) {
      const [maybeHost, maybePort] = entry.split(':')
      if (/^\d+$/.test(maybePort)) {
        pattern = maybeHost
        entryPort = Number(maybePort)
      }
    }
    if (entryPort !== undefined && port != null && Number(port) !== entryPort) continue

    pattern = pattern.replace(/^\[|\]$/g, '')
    if (pattern.startsWith('*.')) pattern = pattern.slice(1)
    if (pattern.startsWith('.')) {
      if (host === pattern.slice(1) || host.endsWith(pattern)) return true
      continue
    }
    if (pattern.includes('/') && /^\d+\.\d+\.\d+\.\d+\/\d+$/.test(pattern)) {
      if (ipv4InCidr(host, pattern)) return true
      continue
    }
    if (host === pattern || host.endsWith(`.${pattern}`)) return true
  }
  return false
}

/** True when an IPv4 literal falls inside a `a.b.c.d/len` range. */
function ipv4InCidr(host, cidr) {
  const [range, bitsRaw] = cidr.split('/')
  const bits = Number(bitsRaw)
  const toInt = (ip) => ip.split('.').reduce((acc, part) => (acc << 8) + Number(part), 0) >>> 0
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(host) || !Number.isInteger(bits) || bits < 0 || bits > 32) return false
  if (bits === 0) return true
  const mask = (0xffffffff << (32 - bits)) >>> 0
  return (toInt(host) & mask) === (toInt(range) & mask)
}

/** True when the destination is loopback and therefore must never be proxied. */
export function isLoopbackHost(hostname) {
  const host = String(hostname ?? '').toLowerCase().replace(/^\[|\]$/g, '')
  if (LOOPBACK.has(host)) return true
  if (/^127\./.test(host)) return true
  if (host === '::1' || host === '0:0:0:0:0:0:0:1') return true
  return false
}

/**
 * A SOCKS5 (RFC 1928 + RFC 1929) `connect` implementation for undici.
 *
 * undici's own `ProxyAgent` speaks HTTP CONNECT only, so SOCKS5 needs a custom
 * connector. undici calls the connector with the destination and expects a
 * connected socket; for `https:` destinations the connector also owns the TLS
 * upgrade, exactly as undici's built-in `buildConnector` does.
 *
 * Domain names are always sent to the proxy (remote DNS), which is what makes a
 * SOCKS proxy usable for hosts that do not resolve locally.
 *
 * @param options.proxyHost - SOCKS5 server host.
 * @param options.proxyPort - SOCKS5 server port.
 * @param options.username - optional RFC 1929 user name.
 * @param options.password - optional RFC 1929 password.
 * @param options.timeout - handshake timeout in ms.
 * @param options.localAddress - optional local bind address.
 * @param options.tls - extra `tls.connect` options.
 * @returns an undici `connect` function.
 */
export function createSocks5Connector(options) {
  const { proxyHost, proxyPort, username, password, timeout = 15000, localAddress, tls: tlsOptions } = options

  return function socks5Connect({ hostname, host, protocol, port, servername }, callback) {
    let settled = false
    const finish = (error, socket) => {
      if (settled) return
      settled = true
      callback(error, socket)
    }

    const targetPort = port || (protocol === 'https:' ? 443 : 80)
    const targetHost = String(hostname || host || '').replace(/^\[|\]$/g, '')
    const socket = net.connect({ host: proxyHost, port: proxyPort, localAddress })
    let buffer = Buffer.alloc(0)

    const fail = (error) => {
      socket.destroy()
      finish(error)
    }

    socket.setTimeout(timeout, () => {
      fail(new Error(`与 SOCKS5 代理 ${proxyHost}:${proxyPort} 的握手在 ${timeout}ms 后超时`))
    })
    socket.on('error', (error) => fail(new Error(`无法连接 SOCKS5 代理 ${proxyHost}:${proxyPort}：${error.message}`, { cause: error })))

    /** Consume exactly `count` bytes from the rolling buffer, or wait for more. */
    const read = (count) => new Promise((resolve, reject) => {
      const take = () => {
        if (buffer.length < count) return false
        const slice = buffer.subarray(0, count)
        buffer = buffer.subarray(count)
        cleanup()
        resolve(slice)
        return true
      }
      const onData = (chunk) => {
        buffer = Buffer.concat([buffer, chunk])
        take()
      }
      const onError = (error) => { cleanup(); reject(error) }
      const onClose = () => { cleanup(); reject(new Error('SOCKS5 代理在握手过程中关闭了连接')) }
      const cleanup = () => {
        socket.off('data', onData)
        socket.off('error', onError)
        socket.off('close', onClose)
      }
      socket.on('data', onData)
      socket.on('error', onError)
      socket.on('close', onClose)
      take()
    })

    /** Perform the whole handshake, then hand the socket to undici. */
    const handshake = async () => {
      const useAuth = Boolean(username)
      socket.write(useAuth ? Buffer.from([0x05, 0x02, 0x00, 0x02]) : Buffer.from([0x05, 0x01, 0x00]))

      const greeting = await read(2)
      if (greeting[0] !== 0x05) throw new Error(`SOCKS5 代理 ${proxyHost}:${proxyPort} 返回了版本 0x${greeting[0].toString(16)}（不是 SOCKS5）`)
      const method = greeting[1]
      if (method === 0xff) throw new Error(`SOCKS5 代理 ${proxyHost}:${proxyPort} 拒绝了所有已提供的认证方式${useAuth ? '' : '（可能需要用户名 / 密码）'}`)
      if (method === 0x02) {
        if (!useAuth) throw new Error(`SOCKS5 代理 ${proxyHost}:${proxyPort} 要求用户名 / 密码认证`)
        const user = Buffer.from(String(username), 'utf8')
        const pass = Buffer.from(String(password ?? ''), 'utf8')
        if (user.length > 255 || pass.length > 255) throw new Error('SOCKS5 用户名与密码均不得超过 255 字节')
        socket.write(Buffer.concat([Buffer.from([0x01, user.length]), user, Buffer.from([pass.length]), pass]))
        const authReply = await read(2)
        if (authReply[1] !== 0x00) throw new Error(`SOCKS5 认证在 ${proxyHost}:${proxyPort} 失败`)
      } else if (method !== 0x00) {
        throw new Error(`SOCKS5 代理 ${proxyHost}:${proxyPort} 选择了不支持的认证方式 0x${method.toString(16)}`)
      }

      // CONNECT with a domain name (ATYP 0x03) so the proxy resolves it.
      const hostBytes = Buffer.from(targetHost, 'utf8')
      if (hostBytes.length === 0 || hostBytes.length > 255) throw new Error(`SOCKS5 无法寻址主机 ${JSON.stringify(targetHost)}`)
      const request = Buffer.concat([
        Buffer.from([0x05, 0x01, 0x00, 0x03, hostBytes.length]),
        hostBytes,
        Buffer.from([(targetPort >> 8) & 0xff, targetPort & 0xff]),
      ])
      socket.write(request)

      const replyHead = await read(4)
      if (replyHead[0] !== 0x05) throw new Error('SOCKS5 代理返回了格式错误的 CONNECT 响应')
      if (replyHead[1] !== 0x00) {
        throw new Error(`SOCKS5 CONNECT 到 ${targetHost}:${targetPort} 失败：${SOCKS5_REPLY_ERRORS[replyHead[1]] ?? `响应码 0x${replyHead[1].toString(16)}`}`)
      }
      // Drain the bound address so the stream is positioned at payload bytes.
      const atyp = replyHead[3]
      const addressLength = atyp === 0x01 ? 4 : atyp === 0x04 ? 16 : atyp === 0x03 ? (await read(1))[0] : 0
      if (atyp !== 0x01 && atyp !== 0x04 && atyp !== 0x03) throw new Error(`SOCKS5 代理返回了未知的地址类型 0x${atyp.toString(16)}`)
      await read(addressLength + 2)

      socket.setTimeout(0)
      socket.off('error', () => {})

      if (protocol === 'https:') {
        const secure = tls.connect({
          socket,
          servername: servername || targetHost,
          ...tlsOptions,
        })
        secure.once('secureConnect', () => finish(null, secure))
        secure.once('error', (error) => finish(new Error(`与 ${targetHost}:${targetPort} 经 SOCKS5 的 TLS 握手失败：${error.message}`, { cause: error })))
        return
      }
      finish(null, socket)
    }

    handshake().catch((error) => fail(error instanceof Error ? error : new Error(String(error))))
  }
}

/**
 * Build the undici dispatcher for one strategy.
 *
 * @param spec - normalised proxy spec, or null for a direct agent.
 * @param options.keepAliveTimeout - idle socket lifetime in ms.
 * @param options.connectTimeout - TCP connect timeout in ms.
 * @param options.tls - extra TLS options for https destinations.
 * @returns a fresh dispatcher. The caller owns its lifetime.
 */
export function createDispatcher(spec, options = {}) {
  const { keepAliveTimeout = 30_000, connectTimeout = 15_000, tls: tlsOptions } = options
  if (spec == null) {
    return new Agent({
      keepAliveTimeout,
      connect: { timeout: connectTimeout, ...(tlsOptions ? { ...tlsOptions } : {}) },
    })
  }
  if (spec.protocol === 'socks5') {
    return new Agent({
      keepAliveTimeout,
      connect: createSocks5Connector({
        proxyHost: spec.host,
        proxyPort: spec.port,
        username: spec.username,
        password: spec.password,
        timeout: connectTimeout,
        tls: tlsOptions,
      }),
    })
  }
  // ProxyAgent accepts credentials in the URI and speaks HTTP CONNECT, which
  // covers both `http://` and `https://` proxy endpoints for http and https
  // destinations.
  return new ProxyAgent({
    uri: proxyDialUrl(spec),
    keepAliveTimeout,
    connectTimeout,
    ...(tlsOptions ? { requestTls: tlsOptions } : {}),
  })
}

/**
 * A strategy-keyed dispatcher cache.
 *
 * Swapping strategies must not tear down sockets that carry in-flight requests
 * (a streaming LLM turn, for instance). Retirement therefore calls `close()`,
 * which stops accepting new work and lets undici finish what it started before
 * releasing the pool, rather than `destroy()`.
 */
export class DispatcherRegistry {
  /** @param options - forwarded to {@link createDispatcher}. */
  constructor(options = {}) {
    this.options = options
    this.entries = new Map()
    this.seq = 0
  }

  /**
   * Resolve the dispatcher for a cache key, creating it once.
   * @param key - stable identity of the strategy (URL, or `direct`).
   * @param factory - builds the dispatcher on first use.
   * @returns the cached dispatcher.
   */
  acquire(key, factory) {
    const existing = this.entries.get(key)
    if (existing !== undefined) return existing.dispatcher
    const dispatcher = factory()
    this.entries.set(key, { dispatcher, id: ++this.seq, createdAt: Date.now() })
    return dispatcher
  }

  /**
   * Get (or build) the dispatcher for a proxy spec.
   * @param spec - normalised spec, or null for direct.
   * @returns the cached dispatcher for that spec.
   */
  forSpec(spec) {
    const key = spec == null ? 'direct' : `${spec.protocol}://${spec.host}:${spec.port}${spec.username ? `#${spec.username}` : ''}`
    return this.acquire(key, () => createDispatcher(spec, this.options))
  }

  /**
   * Gracefully retire every dispatcher except the ones in `keep`.
   * @param keep - cache keys that must stay live.
   * @returns the keys that were retired.
   */
  retireExcept(keep) {
    const keepSet = new Set(keep)
    const retired = []
    for (const [key, entry] of this.entries) {
      if (keepSet.has(key)) continue
      this.entries.delete(key)
      retired.push(key)
      // Fire and forget: undici resolves once in-flight requests drain.
      Promise.resolve(entry.dispatcher.close()).catch(() => {})
    }
    return retired
  }

  /** Close every cached dispatcher (plugin unload). */
  async closeAll() {
    const all = [...this.entries.values()]
    this.entries.clear()
    await Promise.allSettled(all.map((entry) => Promise.resolve(entry.dispatcher.close())))
  }

  /** Keys currently cached, with age — the diagnostics view. */
  describe() {
    return [...this.entries].map(([key, entry]) => ({
      key,
      id: entry.id,
      ageMs: Date.now() - entry.createdAt,
    }))
  }
}
