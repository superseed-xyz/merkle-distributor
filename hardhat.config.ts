import { HardhatUserConfig } from 'hardhat/config'
import '@nomicfoundation/hardhat-toolbox'
import * as dotenv from 'dotenv'

dotenv.config()

const MAINNET_RPC_URL = process.env.MAINNET_RPC_URL ?? ''

/**
 * Hardhat validates every network in this config on every command, so a malformed
 * PRIVATE_KEY breaks `compile` and `test` — neither of which needs a key. Accept only
 * well-formed keys and warn otherwise, so the failure surfaces at deploy time with a
 * readable reason instead of aborting unrelated commands with an HH8.
 *
 * A common cause: `.env` holding `$(op read "op://…")`, which only a shell expands.
 * dotenv passes it through literally. Use `op run --env-file=.env -- yarn deploy:mainnet`
 * with a bare `op://…` value instead.
 */
function deployerAccounts(): string[] {
  const key = process.env.PRIVATE_KEY?.trim()
  if (!key) return []
  if (!/^(0x)?[0-9a-fA-F]{64}$/.test(key)) {
    console.warn('warning: PRIVATE_KEY is set but is not a 32-byte hex key; mainnet has no signer')
    return []
  }
  return [key.startsWith('0x') ? key : `0x${key}`]
}

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
      accounts: deployerAccounts(),
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
