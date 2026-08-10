# merkle-distributor

Merkle distributors for ERC20 tokens and for native ETH, with the tooling to build,
verify and deploy a distribution.

Forked from [Uniswap/merkle-distributor](https://github.com/Uniswap/merkle-distributor).
The ERC20 contracts are unchanged in behaviour; `MerkleDistributorETH` is new.

## Contracts

| Contract                        | Distributes | Notes                                                                                                               |
| ------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------- |
| `MerkleDistributor`             | ERC20       | the original                                                                                                        |
| `MerkleDistributorWithDeadline` | ERC20       | adds a claim window and an owner sweep                                                                              |
| `MerkleDistributorETH`          | native ETH  | claim window, owner sweep, built to run behind an existing proxy — see [docs/architecture.md](docs/architecture.md) |

## Setup

```bash
nvm use          # Node 22
yarn install
cp .env.example .env
yarn compile
yarn test
```

## Building a distribution

The input is a snapshot listing addresses and wei amounts, as CSV or JSON. One command
takes it all the way to a verified result:

```bash
yarn pipeline path/to/snapshot.csv --min-eth 0.0001
```

That runs four stages and stops at the first inconsistency:

1. `build-merkle-input.mjs` — normalise and validate into `[{address, amount}]`, decimal wei
2. `generate-merkle-root.ts` — build the tree
3. `verify-merkle-root.ts` — re-verify every proof and reconstruct the root independently
4. `check-distribution.ts` — cross-check the result against the input

Output lands in `build/merkle-result.json`.

Useful guards when you know what to expect:

```bash
yarn pipeline snapshot.csv --min-eth 0.0001 --expect-count 1234 --expect-total 5000000000000000000
```

Before deploying an ETH distribution, check for recipients that cannot accept ETH:

```bash
npx ts-node scripts/enumerate-unclaimable.ts -i build/merkle-input.json
```

### Input format

```json
[{ "address": "0x1111…", "amount": "1000000000000000000" }]
```

`amount` is **wei as a decimal string**. The default `--amount-format auto` detects hex
by a `0x` prefix and decodes it; anything without that prefix is read as decimal. This
means an accidental `0x` typo is caught, but it also means a value that was _meant_ to
be decimal and happens to start with `0x` would silently be read as hex. To rule that
out entirely, pass `--amount-format decimal`, which rejects hex outright — use it
whenever the input is not supposed to contain any hex amounts, since a hex string
misread as decimal (or vice versa) inflates or shrinks the value by ~4096× with no error.

## Deploying

Deployment of an ETH distributor is two steps, because installing an implementation
behind a proxy is normally multisig-gated.

```bash
# 1. deploy the implementation
MERKLE_RESULT=build/merkle-result.json \
DISTRIBUTOR_OWNER=0x… \
CLAIM_WINDOW_SECONDS=31536000 \
npx hardhat run scripts/deploy/deployMerkleDistributorETH.ts --network mainnet

# 2. verify it
npx hardhat verify --network mainnet <implementation> <merkleRoot> <endTime> <owner>

# 3. emit the upgrade transaction for the multisig
PROXY=0x… PROXY_ADMIN=0x… IMPLEMENTATION=0x… \
npx ts-node scripts/deploy/proposeUpgrade.ts -o upgrade.json
```

Import `upgrade.json` into the Safe Transaction Builder. Nothing is ever broadcast by
these scripts.

## Testing against a real proxy

`test/fork/ProxyUpgrade.fork.test.ts` rehearses the whole upgrade on a mainnet fork:
it performs the real `ProxyAdmin.upgrade`, then asserts the balance is preserved, a claim
pays out of the proxy's own ETH, plain transfers still work, and the previous
implementation's storage slots are untouched.

It skips unless `MAINNET_RPC_URL`, `FORK_PROXY`, `FORK_PROXY_ADMIN` and `FORK_ADMIN_OWNER`
are all set, so it is inert in CI.

## Test fixtures

`test/fixtures/example-input.json` and `golden-example-result.json` are the golden
fixture `parseBalanceMap` is checked against. `test/fixtures/new_example.json` is not
used by any test — it is kept only as the pre-migration source data
(`address`/`earnings`/`reasons`) that `example-input.json` was derived from, so the
golden fixture can be regenerated from it if `parseBalanceMap`'s input format ever
needs to change again.

## License

GPL-3.0-or-later.
