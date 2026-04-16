# BurnWallet Step-by-Step Flow

## Overview

```
syncTree ────────────────────────────────────────────────────────> ┐
syncBurnAccounts ──> selectBurnAccountsForSpend ──> signReMint ──> proof ──> relay
                         ↕ (UI decision point)
```
## TODO make signReMint, proof, relay, selfRelayTx check the nullifier (maybe not everyone to save on calls? Just the once that break ux)
## TODO to make burn accounts synced. UI can subscribe to transfer events for when another burn happens + watch a nullifier from the next nonce

## Full Flow

```ts
// 1. sync — without await returns individual promises so we can
//    wait for accounts first and let the tree sync in the background
//    sync also syncs these 2 to the exact same block, which is important since burnAccounts leafs change when receiving tokens
const { syncedTree, syncedBurnAccounts } = wallet.sync(tokenAddress)

// 2. wait for accounts (needed before selection)
await syncedBurnAccounts

// 3. select burn accounts for spend
const selection = await wallet.selectBurnAccountsForSpend(tokenAddress, amount)

// --- UI: show user the selection, let them decide/adjust ---
// --- tree is still syncing in the background ---

// 4. sign
const signed = await wallet.signReMint(recipient, selection, { feeData })

// 5. wait for tree (only needed before proving)
await syncedTree

// 6. prove
const result = await wallet.proof(signed, { threads })

// 7. relay
await wallet.selfRelayTx(result.relayInputs)
```

## With Relayer Fee

```ts
const { syncedTree, syncedBurnAccounts } = wallet.sync(tokenAddress)
await syncedBurnAccounts

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

await syncedTree
const result = await wallet.proof(signed, { threads, feeData })

// relayer submits instead of self-relay
await wallet.relayTx(result.relayInputs)
```

## Or Just Use easyProof

If you don't need control over individual steps:

```ts
const relayInputs = await wallet.easyProof(tokenAddress, recipient, amount, { threads })
await wallet.selfRelayTx(relayInputs)
```
