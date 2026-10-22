import type { OfflineDirectSigner } from '@cosmjs/proto-signing'
import { CHAIN_ID, keplrChainConfig } from './realio'

declare global {
  interface Window {
    keplr?: any
    cosmostation?: { providers?: { keplr?: any } }
  }
}

// Direct-signing wallets (Keplr, Cosmostation).
export interface DirectConnected {
  kind: 'direct'
  signer: OfflineDirectSigner
  address: string
  wallet: 'keplr' | 'cosmostation'
}

export type Connected = DirectConnected

export async function connect(
  prefer: 'keplr' | 'cosmostation' = 'keplr',
): Promise<DirectConnected> {
  const provider = prefer === 'cosmostation' ? window.cosmostation?.providers?.keplr : window.keplr
  const wallet = prefer
  if (!provider) {
    const name = prefer === 'cosmostation' ? 'Cosmostation' : 'Keplr'
    throw new Error(`${name} wallet not found — install the extension and reload`)
  }
  // Register Realio (Ethermint config) in case the wallet doesn't ship it.
  try {
    await provider.experimentalSuggestChain(keplrChainConfig())
  } catch {
    // already known, or the wallet rejected the suggestion — enable() will surface it
  }
  await provider.enable(CHAIN_ID)
  const signer: OfflineDirectSigner = provider.getOfflineSigner(CHAIN_ID)
  const accounts = await signer.getAccounts()
  if (!accounts.length) throw new Error('No account returned by wallet')
  return { kind: 'direct', signer, address: accounts[0].address, wallet }
}
