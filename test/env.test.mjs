// The bot's `.env` loader accepts exactly one key, MNEMONIC. COMPOUND_* names are the process's own safety
// switches and settings (COMPOUND_TEST_SEAMS opens the live-run guard and the lock seams, COMPOUND_NODE_RPC and
// COMPOUND_NODE_REST name the trusted node) and any other name (MAX_FEE, MAX_DELEGATORS, DRY_RUN, a proxy or NODE_*
// variable...) would change what a fund-moving run does without anyone having reviewed it; `import
// 'dotenv/config'` would have set any of them the caller's environment left unset. Settings live in the systemd
// unit's Environment=, so nothing legitimate is refused.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  mkdirSync,
  copyFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadDotenv } from '../scripts/lib/env.mjs'
import { TEST_MNEMONIC, realioNetwork } from './helpers/chain-fixtures.mjs'

const BOT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..')
const tmp = () => mkdtempSync(join(tmpdir(), 'env-test-'))
const envFile = (body) => {
  const f = join(tmp(), '.env')
  writeFileSync(f, body)
  return f
}
// loadDotenv with everything injected: returns what it set, what it printed and the exit code it asked for.
function load(body, env = {}) {
  const errs = []
  let code
  loadDotenv({
    file: envFile(body),
    env,
    err: (m) => errs.push(m),
    exit: (c) => {
      code = c
    },
  })
  return { env, errs, code }
}

test('a plain .env is loaded: MNEMONIC is assigned (quotes, export and comments as dotenv reads them)', () => {
  const r = load('# comment\nexport MNEMONIC="abc def"\n')
  assert.deepEqual(r.env, { MNEMONIC: 'abc def' })
  assert.equal(r.code, undefined)
  assert.deepEqual(r.errs, [])
})

test('a variable that is already set is never overridden (as dotenv/config does)', () => {
  const r = load('MNEMONIC=from-file\n', { MNEMONIC: 'from-env' })
  assert.equal(r.env.MNEMONIC, 'from-env')
  const empty = load('MNEMONIC=from-file\n', { MNEMONIC: '' })
  assert.equal(empty.env.MNEMONIC, '', 'an empty value that is set still counts as set')
})

test('BT-8/D8: a key other than MNEMONIC refuses: exit 1, the message names the KEYS only, and nothing at all is set', () => {
  const r = load(
    'MNEMONIC=secret words here\nCOMPOUND_TEST_SEAMS=1\nCOMPOUND_LOCAL_ONLY=1\nMAX_FEE=5\n',
  )
  assert.equal(r.code, 1)
  assert.deepEqual(r.errs, [
    '.env may only set MNEMONIC (found: COMPOUND_TEST_SEAMS, COMPOUND_LOCAL_ONLY, MAX_FEE)',
  ])
  assert.deepEqual(r.env, {}, 'not even MNEMONIC is assigned')
  assert.ok(!r.errs.join().includes('secret words'), 'no value is ever printed')
  assert.ok(!r.errs.join().includes('=1'), 'no value is ever printed')
})

test('BT-8: every reserved name the process uses is refused, with or without `export`, quotes or spaces', () => {
  for (const line of [
    'COMPOUND_RUN_LOCK=/x',
    'export COMPOUND_TEST_SEAMS=1',
    'COMPOUND_LOCAL_ONLY="1"',
    'COMPOUND_NODE_RPC=http://x:26657',
    'COMPOUND_NODE_REST = http://x:1317',
    'COMPOUND_NODE_HOST=x',
    'COMPOUND_BOT_ADDR=realio1x',
    'COMPOUND_ANYTHING = x',
    'COMPOUND_=1',
  ]) {
    const r = load(`MNEMONIC=m\n${line}\n`)
    assert.equal(r.code, 1, line)
    assert.deepEqual(r.env, {}, line)
  }
})

test('D8: the allow-list is exactly MNEMONIC: every ordinary setting, a lower-case mnemonic and a lookalike is refused', () => {
  for (const key of [
    'MAX_FEE',
    'MAX_DELEGATORS',
    'MIN_ARIO',
    'DRY_RUN',
    'ONLY_DELEGATOR',
    'NODE_OPTIONS',
    'HTTPS_PROXY',
    'MY_COMPOUND_X',
    'compound_x',
    'COMPOUNDX',
    'mnemonic',
    'MNEMONIC2',
    'MNEMONIC_',
  ]) {
    const r = load(`MNEMONIC=m\n${key}=1\n`)
    assert.equal(r.code, 1, key)
    assert.deepEqual(r.errs, [`.env may only set MNEMONIC (found: ${key})`], key)
    assert.deepEqual(r.env, {}, key)
  }
})

test('D8: a .env with no MNEMONIC and no other key (empty, comments only) loads nothing and refuses nothing', () => {
  for (const body of ['', '# just a comment\n\n']) {
    const r = load(body)
    assert.equal(r.code, undefined)
    assert.deepEqual(r.env, {})
    assert.deepEqual(r.errs, [])
  }
})

test('a missing or unreadable .env does nothing (the script then reports the missing MNEMONIC itself)', () => {
  const env = {}
  loadDotenv({
    file: join(tmp(), 'absent'),
    env,
    err: () => assert.fail('printed'),
    exit: () => assert.fail('exited'),
  })
  assert.deepEqual(env, {})
  loadDotenv({
    file: tmp(),
    env,
    err: () => assert.fail('printed'),
    exit: () => assert.fail('exited'),
  }) // a directory
  assert.deepEqual(env, {})
})

test('the default file is .env in the working directory and the default env is process.env', () => {
  // a real child process: cwd with a .env, no wrapper involved
  const cwd = tmp()
  writeFileSync(join(cwd, '.env'), 'MNEMONIC=loaded\n')
  const r = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import { loadDotenv } from '${join(BOT_DIR, 'scripts/lib/env.mjs')}'; loadDotenv(); console.log(process.env.MNEMONIC)`,
    ],
    { cwd, env: { PATH: process.env.PATH }, encoding: 'utf8' },
  )
  assert.equal(r.stdout.trim(), 'loaded', r.stderr)
})

// The real entry points, as child processes, with a .env that tries to open the guard.
function entry(script, args, body, env = {}) {
  const cwd = tmp()
  mkdirSync(join(cwd, 'src'))
  copyFileSync(join(BOT_DIR, 'src', 'networks.json'), join(cwd, 'src', 'networks.json'))
  writeFileSync(
    join(cwd, 'src', 'networks.local.json'),
    JSON.stringify({
      realio: realioNetwork({ restUrl: ['http://127.0.0.1:9'], rpcUrl: ['http://127.0.0.1:9'] }),
    }),
  )
  if (body !== undefined) writeFileSync(join(cwd, '.env'), body)
  const r = spawnSync(process.execPath, [join(BOT_DIR, 'scripts', script), ...args], {
    cwd,
    env: { PATH: process.env.PATH, HOME: cwd, ...env },
    encoding: 'utf8',
    timeout: 20000,
  })
  return { code: r.status, out: r.stdout + r.stderr }
}

const ENTRIES = [['compound.mjs', []]]

for (const [script, args] of ENTRIES) {
  test(`${script} with COMPOUND_TEST_SEAMS=1 in .env exits 1 naming the key, and a live run is NOT let through`, () => {
    const r = entry(script, args, `MNEMONIC=${TEST_MNEMONIC}\nCOMPOUND_TEST_SEAMS=1\n`, {
      DRY_RUN: 'false',
    })
    assert.equal(r.code, 1, r.out)
    assert.match(r.out, /\.env may only set MNEMONIC \(found: COMPOUND_TEST_SEAMS\)/)
    assert.ok(!r.out.includes(TEST_MNEMONIC), 'the mnemonic is never printed')
    assert.doesNotMatch(
      r.out,
      /Bot +realio1|Loaded chain|ECONNREFUSED/,
      'it stops before any network call',
    )
  })

  test(`${script} with COMPOUND_NODE_REST in .env is refused too (the trusted node is never set from a file)`, () => {
    const r = entry(
      script,
      args,
      `MNEMONIC=${TEST_MNEMONIC}\nCOMPOUND_NODE_REST=http://127.0.0.1:1317\n`,
      { DRY_RUN: 'false' },
    )
    assert.equal(r.code, 1, r.out)
    assert.match(r.out, /\.env may only set MNEMONIC \(found: COMPOUND_NODE_REST\)/)
    assert.doesNotMatch(
      r.out,
      /Bot +realio1|Loaded chain|ECONNREFUSED/,
      'it stops before any network call',
    )
  })
}

test('the same .env without the COMPOUND_ line is still read: the mnemonic reaches the script (a live run then refuses at the wrapper check)', () => {
  const r = entry('compound.mjs', [], `MNEMONIC=${TEST_MNEMONIC}\n`, { DRY_RUN: 'false' })
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /go through its run-compound\.sh wrapper/)
  assert.doesNotMatch(r.out, /Missing MNEMONIC/)
})

test('no bot source still imports dotenv/config, and every entry point loads before it first reads process.env', () => {
  const files = []
  const walk = (d) => {
    for (const e of readdirSync(join(BOT_DIR, d), { withFileTypes: true })) {
      if (e.name === 'node_modules') continue
      if (e.isDirectory()) walk(join(d, e.name))
      else if (/\.(mjs|js|cjs)$/.test(e.name)) files.push(join(d, e.name))
    }
  }
  walk('scripts')
  walk('src')
  for (const f of files)
    assert.doesNotMatch(
      readFileSync(join(BOT_DIR, f), 'utf8'),
      /^\s*(import\s+['"]dotenv\/config['"]|import\s*\(\s*['"]dotenv\/config)/m,
      f,
    )
  for (const [script] of ENTRIES) {
    const code = readFileSync(join(BOT_DIR, 'scripts', script), 'utf8')
      .split('\n')
      .filter((l) => !/^\s*\/\//.test(l))
      .join('\n')
    const load = code.indexOf('\nloadDotenv()')
    const firstRead = code.indexOf('process.env')
    assert.ok(load > 0, `${script} calls loadDotenv()`)
    assert.ok(
      firstRead < 0 || load < firstRead,
      `${script}: loadDotenv() comes before the first process.env read`,
    )
  }
})
