/**
 * Probe 9 (hermetic, decisive): does `setGlobalDispatcher` from the npm `undici`
 * package retarget Node's BUILT-IN `globalThis.fetch`, and can it be swapped
 * hot — repeatedly — while the process keeps running?
 *
 * This is the mechanism the whole plugin rests on, so it is asserted directly
 * rather than inferred. Uses local fake proxies only; no external network.
 */
import { appendFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { startHttpProxy } from '../test/helpers/fake-proxy.mjs'

const LOG = 'F:/@Project/DeepSeekHarnes/dsh-proxy-switcher/probe/probe-global2.log'
try { rmSync(LOG) } catch {}
const log = (m) => { appendFileSync(LOG, `${m}\n`); console.log(m) }
setTimeout(() => { log('WATCHDOG'); process.exit(9) }, 90000).unref?.()

for (const name of ['ALL_PROXY', 'all_proxy', 'HTTP_PROXY', 'http_proxy', 'HTTPS_PROXY', 'https_proxy', 'NO_PROXY', 'no_proxy', 'NODE_USE_ENV_PROXY']) {
  delete process.env[name]
}

const profileDir = process.env.DSH_PROFILE_DIR ?? 'C:/Users/30394/.dsh/profiles/desktop'
const require = createRequire(`${profileDir}/package.json`)
const undici = require('undici')
log(`npm undici -> ${require.resolve('undici')}`)

const p1 = await startHttpProxy({ tag: 'via-p1' })
const p2 = await startHttpProxy({ tag: 'via-p2' })
log(`fake proxies: p1=${p1.url} p2=${p2.url}`)

const direct = new undici.Agent()
const agent1 = new undici.ProxyAgent(p1.url)
const agent2 = new undici.ProxyAgent(p2.url)

const TARGET = 'http://example.invalid/probe'
async function attempt(label) {
  try {
    const res = await fetch(TARGET, { signal: AbortSignal.timeout(6000) })
    const body = await res.text()
    log(`  ${label} -> "${body}"`)
    return body
  } catch (error) {
    const c = error?.cause
    log(`  ${label} -> ERROR ${error?.name}${c ? ` / ${c.code ?? c.message}` : ''}`)
    return `<error:${c?.code ?? error?.name}>`
  }
}

log('--- 1. no dispatcher: target does not resolve, so this must fail ---')
const baseline = await attempt('fetch, default dispatcher')

log('--- 2. install p1 as the global dispatcher ---')
undici.setGlobalDispatcher(agent1)
const viaP1 = await attempt('built-in fetch() after setGlobalDispatcher(p1)')

log('--- 3. hot-swap to p2 (no restart, no wrapper) ---')
undici.setGlobalDispatcher(agent2)
const viaP2 = await attempt('built-in fetch() after setGlobalDispatcher(p2)')

log('--- 4. hot-swap to direct ---')
undici.setGlobalDispatcher(direct)
const viaDirect = await attempt('built-in fetch() after setGlobalDispatcher(direct)')

log('--- 5. hot-swap back to p1 ---')
undici.setGlobalDispatcher(agent1)
const backToP1 = await attempt('built-in fetch() after switching back to p1')

log('--- 6. swap mid-flight stability: two more rapid swaps ---')
undici.setGlobalDispatcher(agent2)
undici.setGlobalDispatcher(agent1)
const rapid = await attempt('built-in fetch() after two rapid swaps')

log('')
log(`p1 hits=${p1.count} ${JSON.stringify(p1.hits)}`)
log(`p2 hits=${p2.count} ${JSON.stringify(p2.hits)}`)
log('')
const checks = [
  ['baseline fails (no dispatcher)', baseline.startsWith('<error:')],
  ['p1 reached after install', viaP1 === 'via-p1'],
  ['p2 reached after hot swap', viaP2 === 'via-p2'],
  ['direct after swap to Agent', viaDirect.startsWith('<error:')],
  ['p1 reached after swapping back', backToP1 === 'via-p1'],
  ['last writer wins after rapid swaps', rapid === 'via-p1'],
]
for (const [name, ok] of checks) log(`${ok ? 'PASS' : 'FAIL'}  ${name}`)
log(checks.every(([, ok]) => ok)
  ? 'VERDICT: the npm-undici global dispatcher retargets built-in fetch and is hot-swappable.'
  : 'VERDICT: NOT confirmed — do not build on this.')

await agent1.close()
await agent2.close()
await direct.close()
await p1.close()
await p2.close()
process.exit(0)
