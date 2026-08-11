# Architecture

Design notes for `MerkleDistributorETH`. Chain-agnostic: no deployment-specific
addresses appear here or anywhere else in this repository.

## Why this contract exists

The ERC20 `MerkleDistributor` ends its `claim()` in `IERC20(token).safeTransfer(...)`.
There is no payable path, so it cannot distribute native ETH. `MerkleDistributorETH`
replaces that final transfer with `account.call{value: amount}("")` and changes nothing
else about the merkle scheme, so the same tree, the same leaf format, and the same
tooling apply.

## Built to be a proxy implementation

The intended deployment installs this contract as the implementation behind an
**existing** upgradeable proxy that already holds ETH and already has unrelated state in
its storage. Three consequences shape the design.

### Immutables, not an initializer

`immutable` values are compiled into the implementation's **code**, not its storage. A
proxy `delegatecall`s that code, so immutables resolve correctly through the proxy while
touching no storage at all. This buys:

- no `initialize()` call, so no initialization front-running window;
- no configuration in storage, so nothing to collide with the proxy's history;
- cheaper claims, since `merkleRoot` is a `PUSH32`, not an `SLOAD`.

Changing the root later means deploying a new implementation and performing one upgrade.
That is the same ceremony as calling a setter would be, since only the proxy admin could
call a setter. Identical capability, smaller attack surface.

For the same reason this contract does **not** inherit OpenZeppelin `Ownable`: it stores
the owner in slot 0, which in an already-used proxy is occupied. `owner` is an immutable.

### ERC-7201 namespaced storage

The claimed bitmap is the only persistent state. It lives at

```
keccak256(abi.encode(uint256(keccak256("superseed.merkledistributor.eth.v1")) - 1)) & ~bytes32(uint256(0xff))
```

A default layout would place the bitmap at slot 0 and read the previous contract's
leftover data as claim bits, marking arbitrary indices already claimed. Namespacing makes
that impossible rather than unlikely.

It is also what preserves upgradeability in practice: a future implementation declaring
the same namespace inherits every claim already made.

### The `.vN` suffix, and rotating the root

The namespace carries a generation number, mirrored by the public `STORAGE_VERSION`
constant. It exists because a claim index is a position in _one specific tree_, which
creates two opposite ways to get a rotation wrong:

| What you do                                                                 | What happens                                                                                                                              |
| --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| New root, **same** namespace                                                | Index _n_ now means a different address. The old bitmap marks the wrong entries claimed: some people blocked, others able to claim twice. |
| New root, **new** namespace, tree rebuilt from everyone                     | Bitmap starts empty, so anyone who already claimed under the old root can claim **again**.                                                |
| New root, **new** namespace, tree rebuilt from **unclaimed addresses only** | Correct.                                                                                                                                  |

So rotating is a three-part change that must move together: bump the `.vN` suffix, bump
`STORAGE_VERSION`, recompute `STORAGE_SLOT`. The storage-layout test derives the namespace
from `STORAGE_VERSION` and asserts the result equals the literal, so bumping one without
the others fails the suite rather than silently pointing the bitmap at an unrelated slot.

Deploying a new implementation with the **same** root and namespace is safe and preserves
every claim. That is the ordinary upgrade path for fixing an unrelated bug.

A fork should change the `superseed` prefix to its own and recompute:

```bash
node -e "const {keccak256,toUtf8Bytes,AbiCoder,toBeHex}=require('ethers');
  const i=BigInt(keccak256(toUtf8Bytes('<your.namespace.v1>')))-1n;
  console.log(toBeHex(BigInt(keccak256(AbiCoder.defaultAbiCoder().encode(['uint256'],[i])))&~0xffn,32))"
```

### `receive()` is mandatory

An OP-Stack `Proxy` delegates plain transfers: a zero-calldata send runs the
_implementation's_ `receive()`. Without a payable `receive()` here, every ETH transfer to
the proxy address would revert.

## Claim safety

- **Permissionless.** Anyone may submit a claim for any account; funds always go to
  `account`, never to `msg.sender`.
- **Checks-effects-interactions.** The claimed bit is set before the external call, so a
  reentrant claim on the same index hits `AlreadyClaimed`. No reentrancy guard is needed.
- **Leaf format.** `keccak256(abi.encodePacked(index, account, amount))` is 84 bytes,
  which can never collide with a 64-byte internal node, so there is no second-preimage
  attack.

## Known limitation: recipients that cannot receive ETH

A recipient contract with no payable `receive`/`fallback` can never claim; the call
reverts with `TransferFailed` and the claimed bit stays unset. `scripts/enumerate-
unclaimable.ts` quantifies this before deployment. There is no in-contract mitigation
that does not introduce a trusted recipient-override path, which would be a larger risk
than the one it solves. Unclaimed ETH returns to `owner` after `endTime`.

## The sweep

`withdraw()` sends the remaining balance to `owner`, but only after `endTime`. There is
deliberately no early escape hatch: a proxy may hold more than the claim set requires, and
that surplus stays locked for the whole window, so a key compromise cannot front-run
claimants before it closes.

The two windows are disjoint by one second, deliberately. `claim()` allows
`block.timestamp <= endTime`; `withdraw()` requires `block.timestamp > endTime`. If
`withdraw()` used `>=`, both would be callable in the block at exactly `endTime` and the
owner could sweep the balance in the same block as, and ahead of, a final claim, which
would then revert with `TransferFailed`. Two tests pin this boundary: `withdraw` reverts
at exactly `endTime`, and succeeds one second later.

The upstream ERC20 `MerkleDistributorWithDeadline` still has the `>=` form. It is left
untouched, since it is kept for compatibility rather than deployed from this repository.
