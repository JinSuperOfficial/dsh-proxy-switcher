/**
 * Probe 7 (hermetic + isolated env): same question as probe 6, but the ambient
 * proxy variables are cleared before the FIRST fetch so nothing ambient can
 * mask the answer. Two local fake proxies name the winner.
 *
 * Only this probe process's env is touched.
 */
import { createServer } from 'node:http'
import { appendFileSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const LOG = fileURLToPath(new URL('./probe-env3.log', import.meta.url))
try { rmSync(LOG) } catch {}
const log = (m) => { appendFileSync(LOG, `${m}\n`); console.log(m) }
setTimeout(() => { log('WATCHDOG'); process.exit(9) }, 60000).unref?.()

// --- clear ambient proxy configuration BEFORE any fetch ---------------------
const CLEARED = ['ALL_PROXY', 'all_proxy', 'HTTP_PROXY', 'http_proxy', 'HTTPS_PROXY', 'https_proxy', 'NO_PROXY', 'no_proxy']
for (const name of CLEARED) delete process.env[name]
process.env.NODE_USE_ENV_PROXY = '1'

function startFakeProxy(tag) {
  return new Promise((resolve) => {
    const hits = []
    const server = createServer((req, res) => {
      hits.push(`${req.method} ${req.url}`)
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end(tag)
    })
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, hits, tag }))
  })
}

const p1 = await startFakeProxy('via-p1')
const p2 = await startFakeProxy('via-p2')
log(`fake proxies: p1=127.0.0.1:${p1.port} p2=127.0.0.1:${p2.port}`)
log(`ambient proxy vars cleared: ${CLEARED.length}; NODE_USE_ENV_PROXY=${process.env.NODE_USE_ENV_PROXY}`)

const TARGET = 'http://example.invalid/probe'

process.env.HTTP_PROXY = `http://127.0.0.1:${p1.port}`
process.env.http_proxy = `http://127.0.0.1:${p1.port}`
log(`set HTTP_PROXY=http://127.0.0.1:${p1.port}`)

async function attempt(label) {
  try {
    const res = await fetch(TARGET, { signal: AbortSignal.timeout(6000) })
    const body = await res.text()
    log(`  ${label} -> body="${body}"`)
    return body
  } catch (error) {
    const c = error?.cause
    log(`  ${label} -> ERROR ${error?.name}: ${error?.message}${c ? ` / ${c.code ?? c.message}` : ''}`)
    return `<error:${error?.name}:${c?.code ?? ''}>`
  }
}

const first = await attempt('fetch #1 (env -> p1)')

process.env.HTTP_PROXY = `http://127.0.0.1:${p2.port}`
process.env.http_proxy = `http://127.0.0.1:${p2.port}`
log(`repointed HTTP_PROXY -> p2 (127.0.0.1:${p2.port})`)
const second = await attempt('fetch #2 (env -> p2)')

log('')
log(`p1 hits=${p1.hits.length} ${JSON.stringify(p1.hits)}`)
log(`p2 hits=${p2.hits.length} ${JSON.stringify(p2.hits)}`)
log('')
if (second === 'via-p2') log('VERDICT: env proxy configuration is re-read per request (LIVE)')
else if (second === 'via-p1') log('VERDICT: env proxy configuration is FROZEN after first use (restart required)')
else log(`VERDICT: inconclusive (first="${first}" second="${second}")`)

p1.server.close()
p2.server.close()
process.exit(0)
