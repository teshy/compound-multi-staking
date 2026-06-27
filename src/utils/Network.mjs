import { multiply, pow, format, bignumber } from 'mathjs'
import { GasPrice } from "@cosmjs/stargate";
import QueryClient from './QueryClient.mjs'
import Operator from './Operator.mjs'
import Chain from './Chain.mjs'

class Network {
  constructor(data) {
    this.data = data
    this.name = data.path || data.name
    this.prettyName = data.prettyName || data.pretty_name
    this.restUrl = data.restUrl
    this.setChain(this.data)
  }

  async load() {
    this.validators = []
    this.operators = (this.data.operators || []).map(data => Operator(this, data))
    this.operatorCount = this.operators.length
  }

  async setChain(data){
    this.chain = Chain(data)
    this.prettyName = this.chain.prettyName
    this.chainId = this.chain.chainId
    this.prefix = this.chain.prefix
    this.slip44 = this.chain.slip44
    this.denom = this.chain.denom
    this.decimals = this.chain.decimals
    this.defaultGasPrice = this.decimals && format(bignumber(multiply(0.000000025, pow(10, this.decimals))), { notation: 'fixed', precision: 4}) + this.denom
    this.gasPrice = this.data.gasPrice || this.defaultGasPrice
    if(this.gasPrice){
      const gasPrice = GasPrice.fromString(this.gasPrice)
      this.gasPriceAmount = gasPrice.amount.toString()
      this.gasPriceDenom = gasPrice.denom
    }
    this.gasPricePrefer = this.data.gasPricePrefer
    this.gasModifier = this.data.gasModifier || 1.5
    this.txTimeout = this.data.txTimeout || 60_000
  }

  async connect(opts) {
    try {
      this.queryClient = await QueryClient(this.chain.chainId, this.restUrl, {
        connectTimeout: opts?.timeout,
        apiVersions: this.chain.apiVersions
      })
      this.restUrl = this.queryClient.restUrl
      this.connected = this.queryClient.connected
    } catch (error) {
      console.log(error)
      this.connected = false
    }
  }

  getOperatorByBotAddress(botAddress) {
    return this.operators.find(elem => elem.botAddress === botAddress)
  }
}

export default Network;
