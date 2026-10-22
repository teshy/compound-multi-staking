import { fromHex, toBech32 } from "@cosmjs/encoding";

import * as BytesUtils from "@ethersproject/bytes";
import { keccak256 } from "@ethersproject/keccak256";
import { encodeSecp256k1Signature } from '@cosmjs/amino';
import { makeSignBytes } from "@cosmjs/proto-signing";

function EthSigner(signer, ethSigner, prefix){
  async function signDirect(_address, signDoc){
    const signature = await ethSigner
      ._signingKey()
      .signDigest(keccak256(makeSignBytes(signDoc)));
    const splitSignature = BytesUtils.splitSignature(signature);
    const result = BytesUtils.arrayify(
      BytesUtils.concat([splitSignature.r, splitSignature.s])
    );
    const pubkey = (await getAccounts())[0].pubkey
    return {
      signed: signDoc,
      signature: encodeSecp256k1Signature(pubkey, result)
    }
  }

  async function getAddress(){
    // ethers returns the checksummed 0x address; its 20 bytes are the bech32 payload. @cosmjs/encoding
    // (a declared dependency) does the hex and bech32 steps — no extra packages (WO-061, C-31/C-72).
    const ethereumAddress = await ethSigner.getAddress();
    const data = fromHex(ethereumAddress.replace(/^0x/, ''));
    return toBech32(prefix, data)
  }

  function getAccounts(){
    return signer.getAccounts()
  }

  return {
    signer,
    ethSigner,
    signDirect,
    getAddress,
    getAccounts
  }
}

export default EthSigner