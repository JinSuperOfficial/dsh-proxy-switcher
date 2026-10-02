/**
 * Test fixtures: local fake proxies.
 *
 * These exist so the plugin's routing can be asserted without touching the
 * network, the user's real proxy, or any external host. A fake proxy records
 * which requests reached it and in what form, which is exactly what a "did this
 * request actually go through the proxy?" assertion needs.
 *
 * Two kinds:
 *   - {@link startHttpProxy} speaks the HTTP proxy protocol: absolute-URI
 *     requests for `http:` origins and `CONNECT` tunnels for everything undici's
 *     `ProxyAgent` sends (it always tunnels, even for `http:`).
 *   - {@link startSocks5Proxy} speaks SOCKS5 (RFC 1928) with optional RFC 1929
 *     username/password auth, and then serves a canned HTTP response inside the
 *     tunnel.
 */
import { createServer } from 'node:http'
import { createServer as createTcpServer } from 'node:net'

/** A minimal canned HTTP/1.1 response used inside tunnels. */
function cannedResponse(tag) {
  const body = tag
  return `HTTP/1.1 200 OK\r\ncontent-type: text/plain\r\ncontent-length: ${Buffer.byteLength(body)}\r\nconnection: close\r\n\r\n${body}`
}

/**
 * Start a fake HTTP forward proxy.
 *
 * @param options.tag - body returned to any request that reaches this proxy.
 * @param options.username - when set, plain requests must carry Proxy-Authorization.
 * @param options.password - password for that check.
 * @param options.tunnel - serve a canned response after CONNECT (default true).
 *   Set false to accept CONNECT without replying, which simulates a hung proxy.
 * @returns a handle with its port, url, recorded hits, and a close().
 */
export async function startHttpProxy(options = {}) {
  const { tag = 'via-proxy', username, password, tunnel = true } = options
  const hits = []
  const expectedAuth = username
    ? `Basic ${Buffer.from(`${username}:${password ?? ''}`).toString('base64')}`
    : null

  const server = createServer((req, res) => {
    const authorized = expectedAuth === null || req.headers['proxy-authorization'] === expectedAuth
    hits.push({ kind: 'request', method: req.method, url: req.url, authorized })
    if (!authorized) {
      res.writeHead(407, { 'proxy-authenticate': 'Basic realm="fake"' })
      res.end('proxy auth required')
      return
    }
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end(tag)
  })

  server.on('connect', (req, clientSocket, head) => {
    const authorized = expectedAuth === null || req.headers['proxy-authorization'] === expectedAuth
    hits.push({ kind: 'connect', method: 'CONNECT', url: req.url, authorized })
    if (!authorized) {
      clientSocket.end('HTTP/1.1 407 Proxy Authentication Required\r\nproxy-authenticate: Basic realm="fake"\r\n\r\n')
      return
    }
    clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
    if (!tunnel) return
    // Consume the tunnelled request, then answer it with the canned body. The
    // real request line is not needed: any request through this tunnel succeeds.
    const answer = () => {
      if (clientSocket.destroyed) return
      clientSocket.end(cannedResponse(tag))
    }
    if (head && head.length > 0) setTimeout(answer, 5)
    else clientSocket.once('data', () => setTimeout(answer, 5))
  })

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  return {
    port,
    url: `http://127.0.0.1:${port}`,
    hits,
    get count() { return hits.length },
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

/**
 * Start a fake SOCKS5 proxy.
 *
 * Supports the no-auth and username/password flows, then serves a canned HTTP
 * response inside the tunnel. `hits` records every CONNECT target it was asked
 * to reach, which is how a test proves the SOCKS path was taken.
 *
 * @param options.tag - body returned inside the tunnel.
 * @param options.username - when set, require RFC 1929 auth.
 * @param options.password - password for that check.
 * @param options.rejectReply - force a specific SOCKS5 reply code (e.g. 0x05 refused).
 * @returns a handle with port, url, hits, and close().
 */
export async function startSocks5Proxy(options = {}) {
  const { tag = 'via-socks5', username, password, rejectReply } = options
  const hits = []

  const server = createTcpServer((socket) => {
    let stage = 'greeting'
    let buffer = Buffer.alloc(0)

    const fail = (reply) => {
      socket.write(Buffer.from([0x05, reply, 0x00, 0x01, 0, 0, 0, 0, 0, 0]))
      socket.end()
    }

    socket.on('error', () => {})
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk])

      if (stage === 'greeting') {
        if (buffer.length < 2) return
        const nmethods = buffer[1]
        if (buffer.length < 2 + nmethods) return
        const methods = [...buffer.subarray(2, 2 + nmethods)]
        buffer = buffer.subarray(2 + nmethods)
        if (username) {
          if (!methods.includes(0x02)) {
            socket.end(Buffer.from([0x05, 0xff]))
            return
          }
          socket.write(Buffer.from([0x05, 0x02]))
          stage = 'auth'
        } else {
          socket.write(Buffer.from([0x05, 0x00]))
          stage = 'request'
        }
        return
      }

      if (stage === 'auth') {
        if (buffer.length < 2) return
        const ulen = buffer[1]
        if (buffer.length < 2 + ulen + 1) return
        const plen = buffer[2 + ulen]
        if (buffer.length < 2 + ulen + 1 + plen) return
        const gotUser = buffer.subarray(2, 2 + ulen).toString('utf8')
        const gotPass = buffer.subarray(2 + ulen + 1, 2 + ulen + 1 + plen).toString('utf8')
        buffer = buffer.subarray(2 + ulen + 1 + plen)
        if (gotUser !== username || gotPass !== (password ?? '')) {
          socket.write(Buffer.from([0x01, 0x01]))
          socket.end()
          return
        }
        socket.write(Buffer.from([0x01, 0x00]))
        stage = 'request'
        return
      }

      if (stage === 'request') {
        if (buffer.length < 5) return
        const atyp = buffer[3]
        let host
        let offset
        if (atyp === 0x03) {
          const len = buffer[4]
          if (buffer.length < 5 + len + 2) return
          host = buffer.subarray(5, 5 + len).toString('utf8')
          offset = 5 + len
        } else if (atyp === 0x01) {
          if (buffer.length < 4 + 4 + 2) return
          host = [...buffer.subarray(4, 8)].join('.')
          offset = 8
        } else if (atyp === 0x04) {
          if (buffer.length < 4 + 16 + 2) return
          host = 'ipv6'
          offset = 20
        } else {
          socket.end(Buffer.from([0x05, 0x08, 0x00, 0x01, 0, 0, 0, 0, 0, 0]))
          return
        }
        const port = buffer.readUInt16BE(offset)
        hits.push({ host, port, auth: username ? `${username}:${password ?? ''}` : null })
        stage = 'tunnel'
        if (rejectReply !== undefined) {
          fail(rejectReply)
          return
        }
        socket.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]))
        // Answer the tunnelled HTTP request with the canned body.
        socket.once('data', () => setTimeout(() => { if (!socket.destroyed) socket.end(cannedResponse(tag)) }, 5))
        return
      }
    })
  })

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  return {
    port,
    url: `socks5://127.0.0.1:${port}`,
    hits,
    get count() { return hits.length },
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

/**
 * Start a trivial origin server, for tests that must prove a request went
 * DIRECT rather than through a proxy.
 *
 * @param options.tag - body returned for any request.
 * @returns a handle with port, url, hits, and close().
 */
export async function startOrigin(options = {}) {
  const { tag = 'via-origin' } = options
  const hits = []
  const server = createServer((req, res) => {
    hits.push({ method: req.method, url: req.url })
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end(tag)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  return {
    port,
    url: `http://127.0.0.1:${port}`,
    hits,
    get count() { return hits.length },
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}
