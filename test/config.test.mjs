/**
 * Configuration tests: the priority chain, redaction, profile normalisation,
 * `no_proxy` matching, proxy-URL parsing, and SOCKS5 spec handling.
 *
 * These are pure — no sockets, no process-global state — so they document the
 * rules the transport tests then rely on.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, rmSync, statSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  AD_HOC_PROFILE_ID,
  DEFAULT_CONFIG,
  ENV_KEYS,
  KEEP_SECRET,
  mergeConfigPatch,
  normalizeConfig,
  normalizeProfile,
  readEnvLayer,
  redactConfig,
  resolveLayers,
  writeConfigFile,
  readConfigFile,
} from '../lib/config.js'
import {
  describeProxy,
  matchesNoProxy,
  normalizeProxySpec,
  proxyDialUrl,
  redactProxyUrl,
} from '../lib/proxy.js'

/** A throwaway directory for file tests. */
function tempDir() {
  return mkdtempSync(join(tmpdir(), 'dshps-config-'))
}

test('proxy URLs parse with credentials, defaults and bracketed IPv6', () => {
  assert.deepEqual(
    { ...normalizeProxySpec('http://user:p%40ss@proxy.example:3128') },
    { protocol: 'http', host: 'proxy.example', port: 3128, username: 'user', password: 'p@ss', path: '' },
  )
  // A scheme-less host:port takes the http default and the protocol's default port.
  assert.equal(normalizeProxySpec('proxy.example:8080').protocol, 'http')
  assert.equal(normalizeProxySpec('socks5://127.0.0.1').port, 1080)
  assert.equal(normalizeProxySpec('https://secure.example').port, 8443)
  // socks5h is an alias: this plugin always resolves remotely.
  assert.equal(normalizeProxySpec('socks5h://127.0.0.1:1080').protocol, 'socks5')
  assert.equal(normalizeProxySpec({ protocol: 'SOCKS5', host: '[::1]', port: 1080 }).host, '::1')
  assert.equal(normalizeProxySpec('http://'), null, 'a URL with no host is not a proxy')
})

test('an unsupported protocol is rejected loudly, not silently ignored', () => {
  assert.throws(() => normalizeProxySpec('ftp://proxy.example:21'), /unsupported proxy protocol/)
  assert.throws(() => normalizeProxySpec({ protocol: 'http', host: 'h', port: 70000 }), /invalid proxy port/)
})

test('redaction never leaks a password', () => {
  assert.equal(redactProxyUrl('http://alice:hunter2@proxy.example:8080'), 'http://alice:***@proxy.example:8080')
  assert.equal(redactProxyUrl('no userinfo here'), 'no userinfo here')
  const spec = normalizeProxySpec('socks5://bob:secret@127.0.0.1:1080')
  assert.equal(describeProxy(spec).url, 'socks5://bob:***@127.0.0.1:1080')
  assert.equal(describeProxy(spec).label, 'socks5://127.0.0.1:1080', 'the label carries no userinfo at all')
  assert.equal(describeProxy(spec).hasAuth, true)
  // The dial URL is the ONE place the password must survive.
  assert.equal(proxyDialUrl(spec), 'socks5://bob:secret@127.0.0.1:1080')
})

test('profiles are normalised, de-duplicated, and unusable ones dropped', () => {
  const profile = normalizeProfile({ name: '', protocol: 'http', host: 'h.example', port: 3128 }, 0)
  assert.equal(profile.id, 'profile-1')
  assert.equal(profile.name, 'http://h.example:3128', 'a nameless profile gets a readable label')
  assert.equal(normalizeProfile({ protocol: 'bogus', host: 'x' }), null)
  assert.equal(normalizeProfile(null), null)

  const config = normalizeConfig({
    profiles: [
      { id: 'dup', host: 'a.example', port: 1 },
      { id: 'dup', host: 'b.example', port: 2 },
    ],
  })
  assert.equal(config.profiles.length, 2)
  assert.equal(new Set(config.profiles.map((p) => p.id)).size, 2, 'ids must be unique')
  assert.equal(config.activeProfile, 'dup', 'the first profile becomes active when none was chosen')
})

test('a config that fails to parse does not fail the load', () => {
  const dir = tempDir()
  const path = join(dir, 'proxy-switcher.json')
  writeFileSync(path, '{ this is not json', 'utf8')
  const loaded = readConfigFile(path)
  assert.equal(loaded.exists, true)
  assert.match(loaded.error, /could not be parsed/)
  assert.deepEqual(loaded.config.mode, DEFAULT_CONFIG.mode, 'defaults still apply')
  rmSync(dir, { recursive: true, force: true })
})

test('the config file is written atomically and owner-only', () => {
  const dir = tempDir()
  const path = join(dir, 'nested', 'proxy-switcher.json')
  writeConfigFile(path, normalizeConfig({ mode: 'direct' }))
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).mode, 'direct')
  if (process.platform !== 'win32') {
    // 0o600: only the owner may read a file that can hold a proxy password.
    assert.equal(statSync(path).mode & 0o777, 0o600)
  }
  rmSync(dir, { recursive: true, force: true })
})

test('the priority chain is runtime > environment > file > defaults', () => {
  const file = normalizeConfig({ mode: 'direct', noProxy: 'from-file', activeProfile: null })
  const env = {
    [ENV_KEYS.mode]: 'custom',
    [ENV_KEYS.noProxy]: 'from-env',
    [ENV_KEYS.enabled]: '1',
  }

  const envOnly = resolveLayers(file, { env })
  assert.equal(envOnly.config.mode, 'custom', 'environment beats the file')
  assert.equal(envOnly.config.noProxy, 'from-env')
  assert.equal(envOnly.sources.mode, 'env')

  const withRuntime = resolveLayers(file, { env, runtime: { mode: 'system' } })
  assert.equal(withRuntime.config.mode, 'system', 'a runtime override beats the environment')
  assert.equal(withRuntime.sources.mode, 'runtime')
  assert.equal(withRuntime.config.noProxy, 'from-env', 'untouched fields still come from the environment')

  const defaults = resolveLayers(normalizeConfig({}), { env: {} })
  assert.equal(defaults.config.mode, DEFAULT_CONFIG.mode)
  assert.equal(defaults.sources.mode, 'default')
})

test('an unset or blank environment variable never overrides the file', () => {
  const file = normalizeConfig({ mode: 'custom', activeProfile: null })
  const { partial, applied } = readEnvLayer({ [ENV_KEYS.mode]: '   ', [ENV_KEYS.profile]: '' })
  assert.deepEqual(partial, {})
  assert.deepEqual(applied, [])
  assert.equal(resolveLayers(file, { env: {} }).config.mode, 'custom')
})

test('DSH_PROXY_SWITCHER_MODE=off disables the proxy instead of selecting a mode', () => {
  const { partial } = readEnvLayer({ [ENV_KEYS.mode]: 'off' })
  assert.equal(partial.enabled, false)
})

test('DSH_PROXY_SWITCHER_URL becomes an ad-hoc custom profile that outranks the file', () => {
  const file = normalizeConfig({ mode: 'direct' })
  const resolved = resolveLayers(file, {
    env: { [ENV_KEYS.url]: 'socks5://carol:pw@127.0.0.1:1080' },
  })
  assert.equal(resolved.config.mode, 'custom')
  assert.equal(resolved.config.activeProfile, AD_HOC_PROFILE_ID)
  const adHoc = resolved.config.profiles.find((p) => p.id === AD_HOC_PROFILE_ID)
  assert.equal(adHoc.protocol, 'socks5')
  assert.equal(adHoc.host, '127.0.0.1')
  assert.equal(adHoc.password, 'pw')
})

test('redactConfig hides stored secrets but reports their presence', () => {
  const config = normalizeConfig({
    profiles: [{ id: 'p', host: 'h.example', port: 3128, username: 'u', password: 'topsecret' }],
  })
  const publicView = redactConfig(config)
  assert.equal(publicView.profiles[0].password, '')
  assert.equal(publicView.profiles[0].hasPassword, true)
  assert.equal(publicView.profiles[0].maskedUrl, 'http://u:***@h.example:3128')
  const serialised = JSON.stringify(publicView)
  assert.equal(serialised.includes('topsecret'), false, 'a stored password must never reach the browser')
})

test('a config patch keeps a stored password unless it is explicitly replaced or cleared', () => {
  const current = normalizeConfig({
    profiles: [{ id: 'p', host: 'h.example', port: 3128, username: 'u', password: 'stored' }],
  })

  const kept = mergeConfigPatch(current, {
    profiles: [{ id: 'p', host: 'h.example', port: 3128, username: 'u', password: KEEP_SECRET }],
  })
  assert.equal(kept.profiles[0].password, 'stored', 'the sentinel means keep')

  const omitted = mergeConfigPatch(current, {
    profiles: [{ id: 'p', host: 'h.example', port: 3128, username: 'u' }],
  })
  assert.equal(omitted.profiles[0].password, 'stored', 'an omitted field means keep')

  const replaced = mergeConfigPatch(current, {
    profiles: [{ id: 'p', host: 'h.example', port: 3128, username: 'u', password: 'new' }],
  })
  assert.equal(replaced.profiles[0].password, 'new')

  const cleared = mergeConfigPatch(current, {
    profiles: [{ id: 'p', host: 'h.example', port: 3128, username: 'u', password: '' }],
  })
  assert.equal(cleared.profiles[0].password, '', 'an explicit empty string clears it')
})

test('a partial patch leaves every field it does not mention alone', () => {
  const current = normalizeConfig({ mode: 'custom', noProxy: 'a,b', timeoutMs: 9000, profiles: [{ id: 'p', host: 'h', port: 1 }] })
  const patched = mergeConfigPatch(current, { enabled: false })
  assert.equal(patched.enabled, false)
  assert.equal(patched.mode, 'custom')
  assert.equal(patched.noProxy, 'a,b')
  assert.equal(patched.timeoutMs, 9000)
  assert.equal(patched.profiles.length, 1)
})

test('no_proxy matching covers the documented forms', () => {
  assert.equal(matchesNoProxy('api.example.com', 443, 'example.com'), true, 'a bare domain matches subdomains')
  assert.equal(matchesNoProxy('example.com', 443, 'example.com'), true)
  assert.equal(matchesNoProxy('example.com', 443, '.example.com'), true, 'a leading dot is equivalent')
  assert.equal(matchesNoProxy('example.com', 443, '*.example.com'), true)
  assert.equal(matchesNoProxy('notexample.com', 443, 'example.com'), false, 'suffix matching is on label boundaries')
  assert.equal(matchesNoProxy('example.com', 443, 'example.com, other.test'), true, 'comma and space both separate')
  assert.equal(matchesNoProxy('example.com', 8080, 'example.com:3128'), false, 'a port entry must match the port')
  assert.equal(matchesNoProxy('example.com', 3128, 'example.com:3128'), true)
  assert.equal(matchesNoProxy('anything.test', 443, '*'), true)
  assert.equal(matchesNoProxy('10.1.2.3', 443, '10.0.0.0/8'), true, 'IPv4 CIDR is supported')
  assert.equal(matchesNoProxy('11.1.2.3', 443, '10.0.0.0/8'), false)
  assert.equal(matchesNoProxy('10.1.2.3', 443, '10.0.0.0/0'), true)
  assert.equal(matchesNoProxy('', 443, '*'), false, 'an absent host never matches')
})

test('the persisted mode survives a reload, and defaults do not', () => {
  const dir = tempDir()
  const path = join(dir, 'proxy-switcher.json')
  const config = normalizeConfig({
    enabled: true,
    mode: 'custom',
    activeProfile: 'work',
    noProxy: 'localhost',
    profiles: [{ id: 'work', name: 'Work', protocol: 'socks5', host: '10.0.0.9', port: 1080, passwordEnv: 'WORK_PW' }],
  })
  writeConfigFile(path, config)
  const reloaded = readConfigFile(path).config
  assert.equal(reloaded.mode, 'custom')
  assert.equal(reloaded.activeProfile, 'work')
  assert.equal(reloaded.profiles[0].protocol, 'socks5')
  assert.equal(reloaded.profiles[0].passwordEnv, 'WORK_PW')

  const empty = normalizeConfig({})
  assert.equal(empty.mode, DEFAULT_CONFIG.mode)
  assert.deepEqual(empty.profiles, [])
  rmSync(dir, { recursive: true, force: true })
})
