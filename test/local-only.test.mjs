// A fund-moving run uses ONLY the node the operator trusts. The wrapper exports COMPOUND_LOCAL_ONLY=1 and
// COMPOUND_NODE_HOST (the host of COMPOUND_NODE_REST); with them set, the network config keeps just that node's
// URLs, so a failure mid-run makes the reads FAIL instead of silently moving to another endpoint. There is no
// built-in host: without COMPOUND_NODE_HOST nothing is trusted.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, openSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as localOnly from '../scripts/lib/local-only.mjs'
import { TEST_MNEMONIC, realioNetwork } from './helpers/chain-fixtures.mjs'

const {
  filterLocalUrls,
  applyLocalOnly,
  assertLiveRunIsLocal,
  holdsWrapperLock,
  LIVE_RUN_REFUSAL,
} = localOnly

// 203.0.113.0/24 is the documentation range (RFC 5737): a stand-in for the operator's own node.
const HOST = '203.0.113.7'
const DATA = () => ({
  chainId: 'realionetwork_3301-1',
  restUrl: [`http://${HOST}:1317`, 'https://api.example.org'],
  rpcUrl: [`http://${HOST}:26657`, 'https://rpc.example.org'],
})
const LOCAL_ENV = { COMPOUND_LOCAL_ONLY: '1', COMPOUND_NODE_HOST: HOST }

test('there is no built-in trusted host: the module exports none, and a call without a host throws', () => {
  assert.equal(localOnly.LOCAL_NODE_HOST, undefined)
  assert.throws(() => filterLocalUrls(DATA().restUrl), /COMPOUND_NODE_HOST is not set/)
  for (const host of [undefined, '', null, 5])
    assert.throws(
      () => filterLocalUrls(DATA().restUrl, host),
      /COMPOUND_NODE_HOST is not set/,
      String(host),
    )
})

test('filterLocalUrls keeps only URLs whose HOST is the trusted node, in order', () => {
  assert.deepEqual(filterLocalUrls(DATA().restUrl, HOST), [`http://${HOST}:1317`])
  assert.deepEqual(filterLocalUrls([`http://${HOST}:1317`, `http://${HOST}:9999`], HOST), [
    `http://${HOST}:1317`,
    `http://${HOST}:9999`,
  ])
})

test('filterLocalUrls compares the HOST, never a prefix or substring', () => {
  const sneaky = [
    `https://${HOST}.evil.example/x`,
    `https://evil.example/${HOST}`,
    'http://203.0.113.70:1317',
    `http://user@evil.example:80/${HOST}`,
    `https://evil.example/?h=${HOST}`,
  ]
  assert.throws(() => filterLocalUrls(sneaky, HOST), /no local node URL/)
})

test('filterLocalUrls drops unparseable entries and a lone string is treated as one URL', () => {
  assert.deepEqual(filterLocalUrls(['not a url', `http://${HOST}:1317`], HOST), [
    `http://${HOST}:1317`,
  ])
  assert.deepEqual(filterLocalUrls(`http://${HOST}:1317`, HOST), [`http://${HOST}:1317`])
})

test('an EMPTY result throws (the run must fail, not fall back)', () => {
  assert.throws(() => filterLocalUrls(['https://api.example.org'], HOST), /no local node URL/)
  assert.throws(() => filterLocalUrls([], HOST), /no local node URL/)
  assert.throws(() => filterLocalUrls(undefined, HOST), /no local node URL/)
})

test('applyLocalOnly with COMPOUND_LOCAL_ONLY=1: restUrl and rpcUrl keep only the trusted node; the rest of the config is untouched', () => {
  const out = applyLocalOnly(DATA(), LOCAL_ENV)
  assert.deepEqual(out.restUrl, [`http://${HOST}:1317`])
  assert.deepEqual(out.rpcUrl, [`http://${HOST}:26657`])
  assert.equal(out.chainId, 'realionetwork_3301-1')
})

test('applyLocalOnly does not mutate its input', () => {
  const data = DATA()
  applyLocalOnly(data, LOCAL_ENV)
  assert.equal(data.restUrl.length, 2)
})

test('applyLocalOnly UNSET (or anything but "1") returns the ordered list unchanged, whatever the host variable says', () => {
  for (const env of [
    {},
    { COMPOUND_LOCAL_ONLY: '' },
    { COMPOUND_LOCAL_ONLY: '0' },
    { COMPOUND_LOCAL_ONLY: 'true' },
    { COMPOUND_NODE_HOST: HOST },
  ]) {
    assert.deepEqual(applyLocalOnly(DATA(), env), DATA(), JSON.stringify(env))
  }
})

test('applyLocalOnly with the flag set and no URL for the host at all throws (naming the flag)', () => {
  const data = { restUrl: ['https://api.example.org'], rpcUrl: ['https://rpc.example.org'] }
  assert.throws(() => applyLocalOnly(data, LOCAL_ENV), /COMPOUND_LOCAL_ONLY/)
})

test('applyLocalOnly with the flag set and COMPOUND_NODE_HOST unset or empty throws (it never trusts "any host")', () => {
  for (const env of [
    { COMPOUND_LOCAL_ONLY: '1' },
    { COMPOUND_LOCAL_ONLY: '1', COMPOUND_NODE_HOST: '' },
  ]) {
    assert.throws(
      () => applyLocalOnly(DATA(), env),
      /COMPOUND_LOCAL_ONLY=1 but COMPOUND_NODE_HOST is not set/,
      JSON.stringify(env),
    )
  }
})

// ---- A LIVE fund move must go through run-compound.sh, and proves it holds the wrapper's run lock ----
const REFUSAL =
  'a live fund-moving run must go through its run-compound.sh wrapper (it holds the run lock and checks the trusted node); refusing'
const LOCK = '/srv/compound/logs/.fundflow.lock'
// A stand-in for node:fs: fd 9 and the named lock file are `heldIno` / `namedIno`.
const fakeFs = ({
  held = { dev: 7n, ino: 42n },
  named = { dev: 7n, ino: 42n },
  fstatThrows = false,
} = {}) => ({
  fstatSync: (fd, o) => {
    assert.equal(fd, 9)
    assert.deepEqual(o, { bigint: true })
    if (fstatThrows) throw Object.assign(new Error('EBADF'), { code: 'EBADF' })
    return held
  },
  statSync: (p, o) => {
    assert.equal(p, LOCK)
    assert.deepEqual(o, { bigint: true })
    return named
  },
})
const WRAPPER_ENV = { COMPOUND_LOCAL_ONLY: '1', COMPOUND_RUN_LOCK: LOCK }

test('the refusal text is exported and names the wrapper, not a variable', () => {
  assert.equal(LIVE_RUN_REFUSAL, REFUSAL)
  assert.doesNotMatch(REFUSAL, /COMPOUND_/)
})

test('assertLiveRunIsLocal: a live run with neither the wrapper environment nor the test seam throws the exact refusal', () => {
  assert.throws(() => assertLiveRunIsLocal(true, {}), { message: REFUSAL })
})

test('assertLiveRunIsLocal: COMPOUND_LOCAL_ONLY=1 ALONE does not let a live run through (a hand-run skips the run lock)', () => {
  assert.throws(() => assertLiveRunIsLocal(true, { COMPOUND_LOCAL_ONLY: '1' }, fakeFs()), {
    message: REFUSAL,
  })
})

test('assertLiveRunIsLocal: the wrapper environment plus fd 9 on the named lock file lets a live run through', () => {
  assert.doesNotThrow(() => assertLiveRunIsLocal(true, WRAPPER_ENV, fakeFs()))
})

test('assertLiveRunIsLocal: fd 9 open on a DIFFERENT file (same dev, other ino, or other dev) refuses', () => {
  for (const held of [
    { dev: 7n, ino: 43n },
    { dev: 8n, ino: 42n },
  ]) {
    assert.throws(
      () => assertLiveRunIsLocal(true, WRAPPER_ENV, fakeFs({ held })),
      { message: REFUSAL },
      JSON.stringify(String(held.ino)),
    )
  }
})

test('assertLiveRunIsLocal: no fd 9 (fstat throws) refuses', () => {
  assert.throws(() => assertLiveRunIsLocal(true, WRAPPER_ENV, fakeFs({ fstatThrows: true })), {
    message: REFUSAL,
  })
})

test('assertLiveRunIsLocal: a missing, empty or relative COMPOUND_RUN_LOCK refuses', () => {
  for (const lock of [undefined, '', 'logs/.fundflow.lock', './x']) {
    assert.throws(
      () =>
        assertLiveRunIsLocal(true, { COMPOUND_LOCAL_ONLY: '1', COMPOUND_RUN_LOCK: lock }, fakeFs()),
      { message: REFUSAL },
      String(lock),
    )
  }
})

test('assertLiveRunIsLocal: a named lock file that does not exist (stat throws) refuses', () => {
  const fsApi = {
    ...fakeFs(),
    statSync: () => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    },
  }
  assert.throws(() => assertLiveRunIsLocal(true, WRAPPER_ENV, fsApi), { message: REFUSAL })
})

test('assertLiveRunIsLocal: the lock without COMPOUND_LOCAL_ONLY=1 refuses too (both are required)', () => {
  assert.throws(() => assertLiveRunIsLocal(true, { COMPOUND_RUN_LOCK: LOCK }, fakeFs()), {
    message: REFUSAL,
  })
})

test('assertLiveRunIsLocal: a dry run never needs either', () => {
  assert.doesNotThrow(() => assertLiveRunIsLocal(false, {}))
})

test('assertLiveRunIsLocal: COMPOUND_TEST_SEAMS must be EXACTLY "1" (no other truthy value opens it)', () => {
  assert.doesNotThrow(() => assertLiveRunIsLocal(true, { COMPOUND_TEST_SEAMS: '1' }))
  for (const v of ['true', 'yes', '0', '', '2', ' 1', '1 ', 'TRUE', 'on']) {
    assert.throws(
      () => assertLiveRunIsLocal(true, { COMPOUND_TEST_SEAMS: v }),
      { message: REFUSAL },
      JSON.stringify(v),
    )
  }
})

test('assertLiveRunIsLocal: COMPOUND_LOCAL_ONLY must be exactly "1" too (the same rule applyLocalOnly uses)', () => {
  for (const v of ['true', '0', '', 'yes']) {
    assert.throws(
      () =>
        assertLiveRunIsLocal(true, { COMPOUND_LOCAL_ONLY: v, COMPOUND_RUN_LOCK: LOCK }, fakeFs()),
      { message: REFUSAL },
      JSON.stringify(v),
    )
  }
})

test('assertLiveRunIsLocal: it reads process.env and the real fs by default (no lock fd in the test runner -> refuses)', () => {
  const saved = {
    l: process.env.COMPOUND_LOCAL_ONLY,
    s: process.env.COMPOUND_TEST_SEAMS,
    f: process.env.COMPOUND_RUN_LOCK,
  }
  delete process.env.COMPOUND_LOCAL_ONLY
  delete process.env.COMPOUND_TEST_SEAMS
  delete process.env.COMPOUND_RUN_LOCK
  try {
    assert.throws(() => assertLiveRunIsLocal(true), { message: REFUSAL })
    assert.equal(holdsWrapperLock({}), false)
  } finally {
    if (saved.l !== undefined) process.env.COMPOUND_LOCAL_ONLY = saved.l
    if (saved.s !== undefined) process.env.COMPOUND_TEST_SEAMS = saved.s
    if (saved.f !== undefined) process.env.COMPOUND_RUN_LOCK = saved.f
  }
})

// The real entry point, as a child process, with NO wrapper and NO seam: it must refuse BEFORE any network call
// (the configured REST URL is a closed port, so a request would show as a connection error).
const ROOT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..')
function bare(script, args, env, { fd9 } = {}) {
  const cwd = mkdtempSync(join(tmpdir(), 'live-local-'))
  mkdirSync(join(cwd, 'src'))
  copyFileSync(join(ROOT_DIR, 'src', 'networks.json'), join(cwd, 'src', 'networks.json'))
  writeFileSync(
    join(cwd, 'src', 'networks.local.json'),
    JSON.stringify({
      realio: realioNetwork({ restUrl: ['http://127.0.0.1:9'], rpcUrl: ['http://127.0.0.1:9'] }),
    }),
  )
  const r = spawnSync(process.execPath, [join(ROOT_DIR, 'scripts', script), ...args], {
    cwd,
    env: { PATH: process.env.PATH, HOME: cwd, MNEMONIC: TEST_MNEMONIC, ...env },
    encoding: 'utf8',
    timeout: 20000,
    // fd9: a path to open and hand the child as its fd 9 (what acquire_run_lock's `exec 9>>lock` leaves)
    stdio: fd9
      ? [
          'ignore',
          'pipe',
          'pipe',
          'ignore',
          'ignore',
          'ignore',
          'ignore',
          'ignore',
          'ignore',
          openSync(fd9, 'a'),
        ]
      : undefined,
  })
  return { code: r.status, out: r.stdout + r.stderr, cwd }
}

test('a bare `DRY_RUN=false node scripts/compound.mjs` exits 1 with the refusal, before any network call', () => {
  const r = bare('compound.mjs', [], { DRY_RUN: 'false' })
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes(REFUSAL), r.out)
  assert.doesNotMatch(r.out, /Bot +realio1|ECONNREFUSED|No healthy REST endpoint/, r.out)
})

test('a bare DRY run is still allowed past the check (it gets as far as the unreachable node)', () => {
  const r = bare('compound.mjs', [], { DRY_RUN: 'true' })
  assert.ok(!r.out.includes(REFUSAL), r.out)
})

test('a bare live run with COMPOUND_LOCAL_ONLY=1 but NO lock fd refuses with the wrapper message, before any network call', () => {
  const r = bare('compound.mjs', [], { DRY_RUN: 'false', ...LOCAL_ENV })
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes(REFUSAL), r.out)
  assert.doesNotMatch(r.out, /ECONNREFUSED|No healthy REST endpoint|no local node URL/, r.out)
})

test('COMPOUND_LOCAL_ONLY=1 and a COMPOUND_RUN_LOCK path with no fd 9 open refuses', () => {
  const lock = join(mkdtempSync(join(tmpdir(), 'lockfile-')), '.fundflow.lock')
  writeFileSync(lock, '')
  const r = bare('compound.mjs', [], { DRY_RUN: 'false', ...LOCAL_ENV, COMPOUND_RUN_LOCK: lock })
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes(REFUSAL), r.out)
})

test('fd 9 open on the SAME file the variable names passes the check, then stops at the config: the host has no URL there', () => {
  const lock = join(mkdtempSync(join(tmpdir(), 'lockfile-')), '.fundflow.lock')
  writeFileSync(lock, '')
  const r = bare(
    'compound.mjs',
    [],
    { DRY_RUN: 'false', ...LOCAL_ENV, COMPOUND_RUN_LOCK: lock },
    { fd9: lock },
  )
  assert.ok(!r.out.includes(REFUSAL), r.out)
  assert.match(
    r.out,
    new RegExp(`COMPOUND_LOCAL_ONLY=1 but no local node URL \\(${HOST.replaceAll('.', '\\.')}\\)`),
    r.out,
  )
  assert.equal(r.code, 1, r.out)
})

test('fd 9 on the right file but COMPOUND_NODE_HOST unset: the run stops at "COMPOUND_NODE_HOST is not set", never trusting the config as it is', () => {
  const lock = join(mkdtempSync(join(tmpdir(), 'lockfile-')), '.fundflow.lock')
  writeFileSync(lock, '')
  const r = bare(
    'compound.mjs',
    [],
    { DRY_RUN: 'false', COMPOUND_LOCAL_ONLY: '1', COMPOUND_RUN_LOCK: lock },
    { fd9: lock },
  )
  assert.ok(!r.out.includes(REFUSAL), r.out)
  assert.match(r.out, /COMPOUND_LOCAL_ONLY=1 but COMPOUND_NODE_HOST is not set/, r.out)
  assert.doesNotMatch(r.out, /ECONNREFUSED|No healthy REST endpoint/, r.out)
  assert.equal(r.code, 1, r.out)
})

test('fd 9 on the right file and a host that the config DOES list: the check passes and the run then reaches only that node (a closed port here)', () => {
  const lock = join(mkdtempSync(join(tmpdir(), 'lockfile-')), '.fundflow.lock')
  writeFileSync(lock, '')
  const r = bare(
    'compound.mjs',
    [],
    {
      DRY_RUN: 'false',
      COMPOUND_LOCAL_ONLY: '1',
      COMPOUND_NODE_HOST: '127.0.0.1',
      COMPOUND_RUN_LOCK: lock,
    },
    { fd9: lock },
  )
  assert.ok(!r.out.includes(REFUSAL), r.out)
  assert.doesNotMatch(r.out, /no local node URL|COMPOUND_NODE_HOST is not set/, r.out)
  assert.match(r.out, /No healthy REST endpoint/, r.out)
  assert.equal(r.code, 1, r.out)
})

test('fd 9 open on a DIFFERENT file than the variable names refuses', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lockfile-'))
  const lock = join(dir, '.fundflow.lock')
  const other = join(dir, 'other')
  writeFileSync(lock, '')
  writeFileSync(other, '')
  const r = bare(
    'compound.mjs',
    [],
    { DRY_RUN: 'false', ...LOCAL_ENV, COMPOUND_RUN_LOCK: lock },
    { fd9: other },
  )
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes(REFUSAL), r.out)
})
