/**
 * Transport integration tests.
 *
 * These assert the property the whole plugin exists for: a RUNNING process can
 * change which proxy its `fetch()` calls go through, with no restart. They are
 * hermetic — every destination is a name that never resolves, so the only way a
 * request can succeed is through a local fake proxy that names itself in the
 * response body.
 *
 * Run through `test/run-tests.ps1`, which launches Node with a clean proxy
 * environment so the machine's own proxy configuration cannot mask a result.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { startHttpProxy, startOrigin, startSocks5Proxy } from './helpers/fake-proxy.mjs'
import {
  TransportController,
  directPolicy,
  httpPolicy,
  mergeNoProxy,
  envLookupFor,
  bypasses,
  resolveUndici,
  socksPolicy,
  undiciModule,
  undiciOrigin,
} from '../lib/transport.js'
import { normalizeProxySpec } from '../lib/proxy.js'

/** A host that never resolves, so only a proxy can answer for it. */
const UNRESOLVABLE = 'http://example.invalid/probe'

/** Small helper: fetch and return the body, or a tagged error. */
async function bodyOf(url, timeout = 8000) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeout) })
    return await response.text()
  } catch (error) {
    return `<error:${error?.cause?.code ?? error?.name}>`
  }
}

test('a running process can switch proxy, then direct, then another proxy', async () => {
  const p1 = await startHttpProxy({ tag: 'via-p1' })
  const p2 = await startHttpProxy({ tag: 'via-p2' })
  const controller = new TransportController({ logger: { info() {}, warn() {}, error() {} } })
  await controller.detect()
  // The shipped seam is present in this profile, so the http(s) paths delegate.
  assert.equal(controller.capabilities.dshHttpProxy, true, 'expected @deepseek-ai/dsh-http-proxy to be resolvable')
  assert.equal(controller.strategyFor(httpPolicy(normalizeProxySpec(p1.url), 'localhost', 'custom')), 'delegate')

  try {
    await controller.apply(httpPolicy(normalizeProxySpec(p1.url), 'localhost', 'custom'))
    assert.equal(await bodyOf(UNRESOLVABLE), 'via-p1', 'first policy should route through p1')

    // THE hot switch: no reinstall, no restart, just a new policy.
    await controller.apply(httpPolicy(normalizeProxySpec(p2.url), 'localhost', 'custom'))
    assert.equal(await bodyOf(UNRESOLVABLE), 'via-p2', 'switching policy should route through p2')

    await controller.apply(directPolicy('localhost'))
    assert.match(await bodyOf(UNRESOLVABLE), /^<error:/, 'direct policy must not reach any proxy')

    await controller.apply(httpPolicy(normalizeProxySpec(p1.url), 'localhost', 'custom'))
    assert.equal(await bodyOf(UNRESOLVABLE), 'via-p1', 'switching back should work')

    assert.equal(p1.count >= 2, true, `expected p1 to serve at least 2 requests, saw ${p1.count}`)
    assert.equal(p2.count, 1, `expected p2 to serve exactly 1 request, saw ${p2.count}`)
  } finally {
    await controller.restore({ quiet: true })
    await p1.close()
    await p2.close()
  }
})

test('a direct own-dispatcher reaches origins instead of demanding a proxy URI', async () => {
  // Regression: a proxy-free policy has no URI, so the factory must not fall
  // through to `ProxyAgent({ uri: undefined })` — that throws
  // `ProxyAgent: Proxy uri is mandatory` and the request fails as
  // UND_ERR_INVALID_ARG rather than connecting.
  await resolveUndici()
  const origin = await startOrigin({ tag: 'via-direct-own' })
  const { createOwnDispatcher } = await import('../lib/transport.js')
  const dispatcher = createOwnDispatcher(directPolicy('localhost'))
  try {
    const response = await undiciModule().fetch(origin.url, { dispatcher, signal: AbortSignal.timeout(6000) })
    assert.equal(await response.text(), 'via-direct-own')
  } finally {
    await dispatcher.close()
    await origin.close()
  }
})

test('restore gives the process its launch transport back', async () => {
  const proxy = await startHttpProxy({ tag: 'via-proxy' })
  const origin = await startOrigin({ tag: 'via-origin' })
  const { getGlobalDispatcher } = await import('undici')
  const controller = new TransportController({ logger: { info() {}, warn() {}, error() {} } })
  const bootDispatcher = getGlobalDispatcher()

  try {
    await controller.apply(httpPolicy(normalizeProxySpec(proxy.url), 'localhost', 'custom'))
    assert.equal(await bodyOf(UNRESOLVABLE), 'via-proxy')
    const installed = getGlobalDispatcher()
    assert.notEqual(installed, bootDispatcher, 'applying a policy must change the process transport')

    await controller.restore({ quiet: true })

    // Object identity with the launch dispatcher is deliberately NOT asserted:
    // the delegating package records the dispatcher it replaced on its own side,
    // and when two copies of undici are in play the slot can legitimately hold an
    // equivalent wrapper rather than the identical object. What must hold is that
    // a closed dispatcher is never left behind, and that launch behaviour is back.
    const after = getGlobalDispatcher()
    assert.notEqual(after, installed, 'restore must not leave the switched-in dispatcher installed')
    assert.notEqual(after, undefined, 'restore must leave a dispatcher installed')

    const launchBehaviour = await bodyOf(UNRESOLVABLE)
    assert.match(launchBehaviour, /^<error:/, 'after restore the fake proxy must no longer be reachable')
    // Positive proof the restored transport is alive rather than a dead pool: a
    // real request to a real local origin must succeed.
    assert.equal(await bodyOf(origin.url), 'via-origin', 'the restored transport must still carry real requests')
  } finally {
    await controller.restore({ quiet: true })
    await proxy.close()
    await origin.close()
  }
})

test('SOCKS5 is tunneled on its own transport, and is hot-switchable too', async () => {
  const socks = await startSocks5Proxy({ tag: 'via-socks5' })
  const controller = new TransportController({ logger: { info() {}, warn() {}, error() {} } })
  await controller.detect()
  const policy = socksPolicy(normalizeProxySpec(socks.url), 'localhost', 'custom')
  // The shipped seam refuses SOCKS by design, so this must be our own transport.
  assert.equal(controller.strategyFor(policy), 'own')

  try {
    await controller.apply(policy)
    assert.equal(await bodyOf(UNRESOLVABLE), 'via-socks5', 'the SOCKS5 tunnel should carry the request')
    assert.equal(socks.hits.length >= 1, true, 'the fake SOCKS5 proxy should have seen a CONNECT')
    assert.equal(socks.hits[0].host, 'example.invalid', 'remote DNS: the proxy must receive the host name')
    assert.equal(socks.hits[0].port, 80)

    await controller.apply(directPolicy('localhost'))
    assert.match(await bodyOf(UNRESOLVABLE), /^<error:/, 'direct after SOCKS must not reach the tunnel')
  } finally {
    await controller.restore({ quiet: true })
    await socks.close()
  }
})

test('SOCKS5 with username/password authenticates (RFC 1929)', async () => {
  const socks = await startSocks5Proxy({ tag: 'via-auth-socks', username: 'alice', password: 's3cret' })
  const controller = new TransportController({ logger: { info() {}, warn() {}, error() {} } })
  const policy = socksPolicy({ ...normalizeProxySpec(socks.url), username: 'alice', password: 's3cret' }, 'localhost', 'custom')
  try {
    await controller.apply(policy)
    assert.equal(await bodyOf(UNRESOLVABLE), 'via-auth-socks')
    assert.equal(socks.hits[0]?.auth, 'alice:s3cret')
  } finally {
    await controller.restore({ quiet: true })
    await socks.close()
  }
})

test('a rejected SOCKS5 CONNECT surfaces a readable error', async () => {
  const socks = await startSocks5Proxy({ tag: 'unused', rejectReply: 0x05 })
  const controller = new TransportController({ logger: { info() {}, warn() {}, error() {} } })
  try {
    await controller.apply(socksPolicy(normalizeProxySpec(socks.url), 'localhost', 'custom'))
    const result = await bodyOf(UNRESOLVABLE)
    assert.match(result, /^<error:/, 'a refused CONNECT must fail the request')
  } finally {
    await controller.restore({ quiet: true })
    await socks.close()
  }
})

test('an HTTP proxy is reached through the shipped seam with the right credentials', async () => {
  const proxy = await startHttpProxy({ tag: 'via-auth-proxy', username: 'bob', password: 'pw' })
  const controller = new TransportController({ logger: { info() {}, warn() {}, error() {} } })
  const spec = { ...normalizeProxySpec(proxy.url), username: 'bob', password: 'pw' }
  try {
    await controller.apply(httpPolicy(spec, 'localhost', 'custom'))
    assert.equal(await bodyOf(UNRESOLVABLE), 'via-auth-proxy')
    assert.equal(proxy.hits.every((hit) => hit.authorized), true, 'every proxied request must carry the credentials')
  } finally {
    await controller.restore({ quiet: true })
    await proxy.close()
  }
})

test('no_proxy entries bypass the proxy', async () => {
  const proxy = await startHttpProxy({ tag: 'via-proxy' })
  const controller = new TransportController({ logger: { info() {}, warn() {}, error() {} } })
  try {
    const policy = httpPolicy(normalizeProxySpec(proxy.url), mergeNoProxy('example.invalid'), 'custom')
    await controller.apply(policy)
    // example.invalid is in no_proxy, so the request must go direct -> it cannot resolve.
    assert.match(await bodyOf(UNRESOLVABLE), /^<error:/, 'a no_proxy host must bypass the proxy')
    assert.equal(proxy.count, 0, 'the proxy must not have been contacted')
  } finally {
    await controller.restore({ quiet: true })
    await proxy.close()
  }
})

test('undici is resolved through the shipped proxy package, not the profile hoist', async () => {
  await resolveUndici()
  const origin = undiciOrigin()
  const undici = undiciModule()
  assert.equal(typeof undici.Agent, 'function', 'the resolved module must expose the dispatcher classes')

  // A profile can hoist a different undici than the harness uses. Mixing the two
  // is the documented way this mechanism breaks, so the resolution must go
  // through @deepseek-ai/dsh-http-proxy whenever that package is present.
  if (origin.startsWith('dsh-http-proxy -> ')) {
    assert.match(origin, /dsh-http-proxy -> /)
  } else {
    // Only acceptable when the shipped package is genuinely absent.
    const controller = new TransportController({ logger: { info() {}, warn() {}, error() {} } })
    const capabilities = await controller.detect()
    assert.equal(capabilities.dshHttpProxy, false, `fell back to '${origin}' although the shipped seam is present`)
  }
  // Whatever the source, the resolved instance must present the well-known slot.
  assert.equal(typeof undici.getGlobalDispatcher, 'function')
  assert.equal(typeof undici.setGlobalDispatcher, 'function')
})

test('envLookupFor expresses a policy for the shipped seam and stays silent when direct', () => {
  const direct = envLookupFor(directPolicy('a,b'))
  assert.equal(direct.get('http_proxy'), undefined)
  assert.equal(direct.get('https_proxy'), undefined)
  assert.deepEqual(direct.get('no_proxy'), { value: 'a,b' })

  const proxied = envLookupFor(httpPolicy(normalizeProxySpec('http://127.0.0.1:3128'), 'a,b', 'custom'))
  assert.deepEqual(proxied.get('http_proxy'), { value: 'http://127.0.0.1:3128' })
  assert.deepEqual(proxied.get('HTTPS_PROXY'), { value: 'http://127.0.0.1:3128' })
})

test('bypasses() recognises loopback ranges and no_proxy suffixes', () => {
  const policy = httpPolicy(normalizeProxySpec('http://127.0.0.1:3128'), mergeNoProxy('internal.example'), 'custom')
  assert.equal(bypasses(new URL('http://127.0.0.5/x'), policy), true, 'the whole 127/8 range is loopback')
  assert.equal(bypasses(new URL('http://[::1]/x'), policy), true)
  assert.equal(bypasses(new URL('http://api.internal.example/x'), policy), true, 'subdomains of a no_proxy entry bypass')
  assert.equal(bypasses(new URL('http://example.com/x'), policy), false)
})
