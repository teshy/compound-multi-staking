// Code that was removed on purpose must stay removed: loadBotWallet's `onData` hook (nothing ever passed it).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..')
const scriptsDir = join(ROOT_DIR, 'scripts')
const sources = (dir) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((d) =>
    d.isDirectory()
      ? sources(join(dir, d.name))
      : d.name.endsWith('.mjs')
        ? [join(dir, d.name)]
        : [],
  )

test('loadBotWallet takes no onData hook, and no source mentions one', () => {
  const wallet = readFileSync(join(scriptsDir, 'lib', 'wallet.mjs'), 'utf8')
  assert.match(wallet, /export async function loadBotWallet\(\{ connectTimeout = 20000 \} = \{\}\)/)
  for (const f of [...sources(scriptsDir), ...sources(join(ROOT_DIR, 'src'))]) {
    assert.doesNotMatch(readFileSync(f, 'utf8'), /onData/, f)
  }
})

test('known-positive: the scan pattern does match what it is meant to find', () => {
  assert.match('if (typeof onData === "function") onData(data)', /onData/)
})
