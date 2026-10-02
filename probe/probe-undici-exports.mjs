/**
 * Probe 11: which undici does the plugin resolve, and does the CJS export carry
 * `fetch`? The connectivity probe depends on that (it must use the SAME instance
 * that built the dispatcher, because Node's built-in fetch rejects a
 * newer-generation dispatcher).
 */
import { createRequire } from 'node:module'
import { resolveUndici, undiciModule, undiciOrigin, undiciVersion } from '../lib/transport.js'

await resolveUndici()
const m = undiciModule()
console.log('origin :', undiciOrigin())
console.log('version:', undiciVersion())
for (const key of ['fetch', 'Agent', 'ProxyAgent', 'Pool', 'getGlobalDispatcher', 'setGlobalDispatcher']) {
  console.log(`  ${key.padEnd(20)} = ${typeof m[key]}`)
}
console.log('is the same object as a require of the same path?')
const require = createRequire(import.meta.url)
const proxyPackage = require.resolve('@deepseek-ai/dsh-http-proxy/package.json')
const hostRequire = createRequire(proxyPackage)
const direct = hostRequire('undici')
console.log('  same module instance :', direct === m)
console.log('  host undici fetch    :', typeof direct.fetch)
process.exit(0)
