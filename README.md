# merkle-distributor

Merkle distributors for ERC20 tokens and for native ETH, with the tooling to build,
verify and deploy a distribution.

Forked from [Uniswap/merkle-distributor](https://github.com/Uniswap/merkle-distributor).
The ERC20 contracts are unchanged in behaviour; `MerkleDistributorETH` is new.

## Contracts

| Contract                        | Distributes | Notes                                                                                                              |
| ------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------ |
| `MerkleDistributor`             | ERC20       | the original                                                                                                       |
| `MerkleDistributorWithDeadline` | ERC20       | adds a claim window and an owner sweep                                                                             |
| `MerkleDistributorETH`          | native ETH  | claim window, owner sweep, built to run behind an existing proxy. See [docs/architecture.md](docs/architecture.md) |

## Setup

```bash
nvm use          # Node 22
yarn install
cp .env.example .env
yarn compile
yarn test
```

## The whole deployment, start to finish

Set five values in `.env` once (`PROXY`, `PROXY_ADMIN`, `DISTRIBUTOR_OWNER`,
`MAINNET_RPC_URL`, `PRIVATE_KEY`), then:

```bash
# 1. build the distribution from a snapshot
yarn distribution ../chain-data-snapshot/eth-holders-snapshot.json --min-eth 0.0001

# 2. hand the proofs to the claim interface
cp dist/distribution.json ../eth-claim-portal/data/

# 3. deploy the implementation
yarn deploy:mainnet

# 4. build the transaction the multisig signs
yarn propose-upgrade

# 5. import dist/upgrade.json into the Safe Transaction Builder, sign, execute
```

Everything lands in `dist/`, and each step reads the previous step's output, so no
addresses or file paths are copied by hand:

| File                     | Written by | Contains                                              |
| ------------------------ | ---------- | ----------------------------------------------------- |
| `dist/recipients.json`   | step 1     | the validated, filtered `{address, amount}` set       |
| `dist/distribution.json` | step 1     | root, tokenTotal and every proof                      |
| `dist/SUMMARY.txt`       | step 1     | what was built, and **what the filter excluded**      |
| `dist/deployment.json`   | step 3     | implementation address, root, endTime, owner, tx hash |
| `dist/upgrade.json`      | step 4     | the Safe batch                                        |

### Step 1 in detail

The snapshot is the complete holder record. **Any dust floor is a processing decision
applied here**, not something baked into the data, so `SUMMARY.txt` always records how
many recipients the filter removed:

```
recipients : 10518 (17286 below the floor, dropped)
```

Four stages run, stopping at the first inconsistency: normalise and validate the
snapshot, build the tree, re-verify every proof and reconstruct the root by an
independent implementation, then cross-check the result against the input. If `PROXY`
is set it also confirms that address holds at least `tokenTotal`.

Guards worth using when you know what to expect:

```bash
yarn distribution snapshot.json --min-eth 0.0001 --expect-count 10518 --expect-total 50449251009702811233
```

Before deploying, check for recipients that cannot receive ETH at all — their claim
would revert, and the figure belongs in the runbook:

```bash
yarn enumerate-unclaimable -i dist/recipients.json
```

### Step 3 in detail

`yarn deploy:mainnet` refuses to spend gas on a doomed deploy: it rejects a zero
`DISTRIBUTOR_OWNER`, rejects an owner equal to `PROXY` or `PROXY_ADMIN` (either would
make `withdraw()` permanently uncallable), and confirms the funding address covers
`tokenTotal`. Then verify it:

```bash
npx hardhat verify --network mainnet <address> <merkleRoot> <endTime> <owner>
```

The exact command is printed for you, with the arguments filled in.

### Step 4 in detail

Nothing is ever broadcast. `yarn propose-upgrade` only writes a file. It refuses zero
addresses and refuses any two of proxy/admin/implementation being equal, so a mistyped
variable fails loudly instead of producing a plausible, signable, catastrophic
transaction.

Before signing, the four signers should confirm: `to` is the **ProxyAdmin** and not the
proxy, the selector is `0x99a88ec4`, and the arguments are in `(proxy, implementation)`
order. The script prints this checklist.

## Input format

```json
[{ "address": "0x1111…", "amount": "1000000000000000000" }]
```

`amount` is **wei as a decimal string**. Hex is auto-detected only when `0x`-prefixed;
pass `--amount-format decimal` to reject it outright. A hex value in a decimal field
inflates the amount ~4096x, which is why the adapter validates this hard.

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
used by any test; it is kept only as the pre-migration source data
(`address`/`earnings`/`reasons`) that `example-input.json` was derived from, so the
golden fixture can be regenerated from it if `parseBalanceMap`'s input format ever
needs to change again.

## License

GPL-3.0-or-later.
