// The bot's `.env` loader (WO-075 D6, docs/06 delta gate 2026-10-19, BT-8; WO-077 D8, delta gate 2026-10-20,
// BR-6). It replaces `import 'dotenv/config'` in every bot entry point and does the same job (read `.env` from
// the working directory, never override a variable that is already set) with one refusal added: a `.env` may
// set the key MNEMONIC and nothing else. COMPOUND_* names are the process's own safety switches (COMPOUND_TEST_SEAMS
// opens the live-run guard and the lock-file seams, COMPOUND_LOCAL_ONLY and COMPOUND_RUN_LOCK are what the
// wrappers export); any other name (MAX_FEE, MAX_DELEGATORS, DRY_RUN, NODE_OPTIONS, a proxy...) would change what
// a fund-moving run does from a file nobody reviews. Settings that are meant to be set live in the unit files
// and the process environment. The install's `.env` holds only MNEMONIC.
//
// The file is parsed first, with no process.env mutation. Any other key -> one error line naming the KEYS
// only (never a value) and exit 1 before anything is set. No file, or an unreadable one: nothing happens, as
// with dotenv (the script then reports the missing MNEMONIC itself).
import fs from 'node:fs'
import dotenv from 'dotenv'

export function loadDotenv({ file = '.env', env = process.env, fsApi = fs, err = console.error, exit = process.exit } = {}) {
  let text
  try {
    text = fsApi.readFileSync(file)
  } catch {
    return
  }
  const parsed = dotenv.parse(text)
  const others = Object.keys(parsed).filter((k) => k !== 'MNEMONIC')
  if (others.length > 0) {
    err(`.env may only set MNEMONIC (found: ${others.join(', ')})`)
    exit(1)
    return
  }
  for (const [key, value] of Object.entries(parsed)) {
    if (!Object.prototype.hasOwnProperty.call(env, key)) env[key] = value
  }
}
