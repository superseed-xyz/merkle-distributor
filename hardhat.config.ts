import { HardhatUserConfig } from 'hardhat/config'
import '@nomicfoundation/hardhat-toolbox'
import * as dotenv from 'dotenv'

dotenv.config()

const MAINNET_RPC_URL = process.env.MAINNET_RPC_URL ?? ''
const PRIVATE_KEY = process.env.PRIVATE_KEY

const config: HardhatUserConfig = {
  solidity: {
    compilers: [
      // Existing ERC20 distributors are pinned here; do not change.
      { version: '0.8.17', settings: { optimizer: { enabled: true, runs: 5000 } } },
      // Native-ETH distributor.
      { version: '0.8.28', settings: { optimizer: { enabled: true, runs: 5000 } } },
    ],
  },
  networks: {
    hardhat: {
      // Forking is opt-in: the fork tests skip themselves when MAINNET_RPC_URL is unset.
      forking: MAINNET_RPC_URL
        ? {
            url: MAINNET_RPC_URL,
            ...(process.env.FORK_BLOCK_NUMBER ? { blockNumber: Number(process.env.FORK_BLOCK_NUMBER) } : {}),
          }
        : undefined,
    },
    mainnet: {
      chainId: 1,
      url: MAINNET_RPC_URL,
      accounts: PRIVATE_KEY ? [PRIVATE_KEY] : [],
    },
  },
  etherscan: {
    apiKey: process.env.ETHERSCAN_API_KEY ?? '',
  },
  gasReporter: {
    enabled: process.env.REPORT_GAS === 'true',
  },
  mocha: {
    timeout: 120000,
  },
}

export default config
