# BurnWallet Step-by-Step Flow

## Overview

```
syncTree ──────────────────────────────────────────────────> ┐
syncBurnAccounts ──> selectBurnAccountsForSpend ──> signReMint ──> proof ──> relay
                         ↕ (UI decision point)
```
## TODO force syncMerkle tree and syncBurnAccounts to syncTillBlock to be the same. Same for easyProof
## TODO make signReMint, proof, relay, selfRelayTx check the nullifier (maybe not everyone to save on calls? Just the once that break ux)


## Full Flow

```ts
// 1. start tree sync immediately — runs in background throughout
const syncedTreePromise = wallet.syncTree(tokenAddress)

// 2. sync burn accounts (needed before selection)
await wallet.syncBurnAccounts(tokenAddress)

// 3. select burn accounts for spend
const selection = await wallet.selectBurnAccountsForSpend(tokenAddress, amount)

// --- UI: show user the selection, let them decide/adjust ---
// --- tree is still syncing in the background ---

// 4. sign
const signed = await wallet.signReMint(recipient, selection, { feeData })

// 5. ensure tree is synced before proving
const syncedTree = await syncedTreePromise

// 6. prove with the resolved tree
const result = await wallet.proof(signed, { syncedTree, threads })

// 7. relay
await wallet.selfRelayTx(result.relayInputs)
```

## With Relayer Fee

```ts
const syncedTreePromise = wallet.syncTree(tokenAddress)
await wallet.syncBurnAccounts(tokenAddress)

const selection = await wallet.selectBurnAccountsForSpend(tokenAddress, amount)

// --- UI decision point ---

const signed = await wallet.signReMint(recipient, selection, {
    feeData: {
        maxFee: "0x...",
        amountForRecipient: "0x...",
        relayerBonus: "0x...",
        refundAddress: burnAddress,
        relayerAddress: relayerAddress,
    }
})

const syncedTree = await syncedTreePromise
const result = await wallet.proof(signed, { syncedTree, threads })

// relayer submits instead of self-relay
await wallet.relayTx(result.relayInputs)
```

## Or Just Use easyProof

If you don't need control over individual steps:

```ts
const relayInputs = await wallet.easyProof(tokenAddress, recipient, amount, { threads })
await wallet.selfRelayTx(relayInputs)
```
