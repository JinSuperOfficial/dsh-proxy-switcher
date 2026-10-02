/**
 * Probe 10: which dispatcher placements actually work on this runtime, given
 * that Node's built-in fetch carries its OWN undici copy (7.29.0) while the
 * harness ships undici 8.11.2?
 *
 * Hypothesis under test: the global slot is version-ADAPTED by Node, so any
 * generation works there; an explicitly passed `dispatcher` is used raw, so it
 * must match the built-in copy's handler API.
 *
 * Hermetic: local fake proxies, unresolvable destination.
 */
import { appendFileSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { startHttpProxy, startSocks5Proxy } from '../test/helpers/fake-proxy.mjs'
import { resolveUndici, undiciModule, undiciOrigin } from '../lib/transport.js'

const LOG = fileURLToPath(new URL('./probe-placements.log', import.meta.url))
try { rmSync(LOG) } catch {}
const log = (m) => { appendFileSync(LOG, `${m}\n`); console.log(m) }
setTimeout(() => { log('WATCHDOG'); process.exit(9) }, 120000).unref?.()

for (const name of ['ALL_PROXY', 'all_proxy', 'HTTP_PROXY', 'http_proxy', 'HTTPS_PROXY', 'https_proxy', 'NO_PROXY', 'no_proxy', 'NODE_USE_ENV_PROXY']) {
  delete process.env[name]
}

await resolveUndici()
const undici = undiciModule()
log(`undici (as resolved) -> ${undiciOrigin()}`)
log(`built-in fetch's own undici is NOT this one; see process.versions and Node's internals`)

const http1 = await startHttpProxy({ tag: 'via-http1' })
const socks = await startSocks5Proxy({ tag: 'via-socks' })
const TARGET = 'http://example.invalid/probe'

const results = []
/** Run one placement and record whether the proxy answered. */
async function probe(label, makeDispatcher, expect) {
  let dispatcher = null
  try {
    dispatcher = makeDispatcher()
  } catch (error) {
    log(`SKIP  ${label}: could not construct (${error.message})`)
    results.push([label, null])
    return
  }
  const previous = undici.getGlobalDispatcher()
  undici.setGlobalDispatcher(dispatcher)
  let outcome
  try {
    const res = await fetch(TARGET, { signal: AbortSignal.timeout(7000) })
    outcome = await res.text()
  } catch (error) {
    outcome = `<error:${error?.cause?.code ?? error?.name}>`
  } finally {
    undici.setGlobalDispatcher(previous)
  }
  const ok = expect === null ? outcome.startsWith('<error:') : outcome === expect
  log(`${ok ? 'PASS' : 'FAIL'}  ${label} -> ${outcome} (expected ${expect ?? 'an error'})`)
  results.push([label, ok])
  try { await dispatcher.close() } catch { /* already closed */ }
}

log('\n--- A. dispatcher installed in the GLOBAL slot (what dsh itself uses) ---')
await probe('global: plain v8 Agent (direct)', () => new undici.Agent(), null)
await probe('global: v8 Agent{factory -> ProxyAgent}', () => new undici.Agent({
  factory: (origin, options) => new undici.ProxyAgent({ ...options, uri: http1.url }),
}), 'via-http1')
await probe('global: v8 ProxyAgent directly', () => new undici.ProxyAgent({ uri: http1.url }), 'via-http1')
await probe('global: v8 ProxyAgent(socks5://) — native SOCKS5?', () => new undici.ProxyAgent({ uri: socks.url }), 'via-socks')
await probe('global: v8 Agent{factory -> Pool with socks5 connector}', () => new undici.Agent({
  // The shipped Agent's factory shape, with the socks URI handled by ProxyAgent.
  factory: (origin, options) => new undici.ProxyAgent({ ...options, uri: socks.url }),
}), 'via-socks')

log('\n--- B. dispatcher passed EXPLICITLY to the built-in fetch ---')
{
  const agent = new undici.ProxyAgent({ uri: http1.url })
  try {
    const res = await fetch(TARGET, { dispatcher: agent, signal: AbortSignal.timeout(7000) })
    log(`PASS  explicit v8 ProxyAgent -> ${await res.text()}`)
    results.push(['explicit v8 dispatcher', true])
  } catch (error) {
    log(`FAIL  explicit v8 ProxyAgent -> ${error?.cause?.code ?? error?.message} (cross-generation, expected)`)
    results.push(['explicit v8 dispatcher', false])
  }
  await agent.close()
}

log('\n--- C. dispatcher passed explicitly to the SAME undici copy\'s own fetch ---')
{
  const agent = new undici.ProxyAgent({ uri: http1.url })
  try {
    const res = await undici.fetch(TARGET, { dispatcher: agent, signal: AbortSignal.timeout(7000) })
    log(`PASS  undici.fetch + v8 ProxyAgent -> ${await res.text()}  (this is what dsh-web-fetch-http does)`)
    results.push(['undici.fetch + same-instance dispatcher', true])
  } catch (error) {
    log(`FAIL  undici.fetch + v8 ProxyAgent -> ${error?.cause?.code ?? error?.message}`)
    results.push(['undici.fetch + same-instance dispatcher', false])
  }
  await agent.close()
}

log('\n--- D. built-in fetch with no dispatcher while a v8 proxy is global (the real path) ---')
await probe('global v8 proxy then plain fetch() (repeat)', () => new undici.ProxyAgent({ uri: http1.url }), 'via-http1')

log('\n--- summary ---')
for (const [label, ok] of results) log(`${ok === true ? 'PASS' : ok === false ? 'FAIL' : 'SKIP'}  ${label}`)
log('')
log(`http proxy hits=${http1.count}, socks hits=${socks.count} ${JSON.stringify(socks.hits)}`)

await http1.close()
await socks.close()
process.exit(0)
