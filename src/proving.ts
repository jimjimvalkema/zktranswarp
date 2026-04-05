import { getAddress, toHex } from "viem"
import type { Hex, Address, PublicClient } from "viem"
import type { MerkleData, SpendableBalanceProof, PreSyncedTree, SignatureData, U1AsHexArr, U32AsHex, WormholeToken, PublicProofInputs, BurnDataPublic, BurnDataPrivate, PrivateProofInputs, FakeBurnAccount, CreateRelayerInputsOpts, FeeData, SelfRelayInputs, SignatureInputs, SignatureInputsWithFee, BurnAccountProof, FakeBurnAccountProof, RelayInputs, SyncedBurnAccount, BackendPerSize, SpendableBurnAccount, BurnAccountSelector, ProofInputs } from "./types.js"
import { EAS_BYTE_LEN_OVERHEAD, EMPTY_UNFORMATTED_MERKLE_PROOF, ENCRYPTED_TOTAL_MINTED_PADDING } from "./constants.ts"
import { hashTotalMintedLeaf, hashNullifier, hashTotalBurnedLeaf, hashFakeLeaf, hashFakeNullifier } from "./hashing.ts"
import type { LeanIMTMerkleProof } from "@zk-kit/lean-imt"
import { LeanIMT } from "@zk-kit/lean-imt"
import { encryptTotalMinted, getSyncedMerkleTree, syncMultipleBurnAccounts } from "./syncing.ts"
import type { ProofData } from '@aztec/bb.js';
import { UltraHonkBackend } from '@aztec/bb.js';
import type { CompiledCircuit, InputMap } from "@noir-lang/noir_js"
import { Noir } from "@noir-lang/noir_js"
import reMint3Circuit from '../circuits/reMint3/target/reMint3.json' with { type: 'json' };
import reMint32Circuit from '../circuits/reMint32/target/reMint32.json' with { type: 'json' };
import reMint100Circuit from '../circuits/reMint100/target/reMint100.json'  with { type: 'json' };
const circuits: { [circuitSize: number]: any } = {
    3: reMint3Circuit,
    32: reMint32Circuit,
    100: reMint100Circuit
} as const

//import { Fr } from "@aztec/aztec.js"
import { BurnViewKeyManager } from "./BurnViewKeyManager.ts"
import { assert } from "node:console"
import { getAcceptedChainIdFromContract, getAllBurnAccounts, getAvailableThreads, getCircuitSize, getCircuitSizesFromContract, getWormholeTokenContract, hexToU8AsHexLen32, padArray, padWithRandomHex, randomBN254FieldElement } from "./utils.ts"
import { signPrivateTransfer } from "./signing.ts"

export function formatMerkleProof(merkleProof: LeanIMTMerkleProof<bigint>, maxTreeDepth: number): MerkleData {
    const depth = toHex(merkleProof.siblings.length)
    const indices = BigInt(merkleProof.index).toString(2).split('').reverse().map((v) => toHex(Number(v)))
    const siblings = merkleProof.siblings.map((v) => toHex(v))
    const formattedMerkleProof = {
        depth: depth as U32AsHex,
        indices: padArray({ arr: indices, size: maxTreeDepth, value: "0x00" }) as U1AsHexArr, // todo slice this in the right size. Maybe it need reverse?
        siblings: padArray({ arr: siblings, size: maxTreeDepth, value: "0x00" }) as Hex[]
    }
    return formattedMerkleProof

}

/**
 * @param param0 
 * @returns 
 */
export function getAccountNoteMerkle(
    { totalMintedNoteHashLeaf, tree, maxTreeDepth }:
        { totalMintedNoteHashLeaf: bigint, tree: LeanIMT<bigint>, maxTreeDepth: number }
): MerkleData {
    if (totalMintedNoteHashLeaf === 0n) {
        const merkleProof = formatMerkleProof(EMPTY_UNFORMATTED_MERKLE_PROOF, maxTreeDepth)
        return merkleProof
    } else {
        const totalMintedNoteHashIndex = tree.indexOf(totalMintedNoteHashLeaf)
        const unformattedMerkleProof = tree.generateProof(totalMintedNoteHashIndex)
        const merkleProof = formatMerkleProof(unformattedMerkleProof, maxTreeDepth)
        return merkleProof
    }
}


export function getBurnedMerkle(
    { totalBurnedLeaf, tree, maxTreeDepth }:
        { tree: LeanIMT<bigint>, totalBurnedLeaf: bigint, maxTreeDepth: number }
): MerkleData {
    const totalBurnedIndex = tree.indexOf(totalBurnedLeaf)
    const unformattedMerkleProof = tree.generateProof(totalBurnedIndex)
    const merkleProof = formatMerkleProof(unformattedMerkleProof, maxTreeDepth)
    return merkleProof
}

/**
 * @notice does not sync the wallet or tree. Assumes it is already synced, will create merkle proofs on commitments that are already nullified or on a old tree
 * @param param0 
 * @returns 
 */
export function getSpendableBalanceProof(
    { totalMintedNoteHashLeaf, totalBurnedLeaf, tree, maxTreeDepth }:
        { totalMintedNoteHashLeaf: bigint, totalBurnedLeaf: bigint, tree: LeanIMT<bigint>, maxTreeDepth: number }
): SpendableBalanceProof {
    const totalMintedMerkleProofs = getAccountNoteMerkle({ totalMintedNoteHashLeaf, tree, maxTreeDepth })
    const totalBurnedMerkleProofs = getBurnedMerkle({ totalBurnedLeaf, tree, maxTreeDepth })

    return {
        totalMintedMerkleProofs: totalMintedMerkleProofs,
        totalBurnedMerkleProofs: totalBurnedMerkleProofs,
        root: toHex(tree.root),
    }
}

export async function toSpendableBurnAccounts(burnAccounts: SyncedBurnAccount[], tokenAddress: Address, allowedChainIds: Hex[], selectBurnAddresses: Address[]) {
    const entries: SpendableBurnAccount[] = []
    selectBurnAddresses = selectBurnAddresses.map((a) => getAddress(a))
    for (const burnAccount of burnAccounts) {
        if (!selectBurnAddresses.includes(burnAccount.burnAddress)) continue
        for (const [chainId, statePerContract] of Object.entries(burnAccount.syncData)) {
            // likely never happens, but in theory an burn account can have an balance on chainId that is not allowed, that balance just can never be spent
            if (allowedChainIds.includes(chainId as Hex) === false) continue
            const state = statePerContract[tokenAddress]
            if (state && BigInt(state.spendableBalance) > 0n) {
                entries.push({ burnAccount, contract: tokenAddress, chainId: chainId as Hex, amount: BigInt(state.spendableBalance) })
            }
        }
    }
    return entries
}

export async function encryptTotalSpends(
    claimedBurnAccounts: SpendableBurnAccount[]
): Promise<Hex[]> {
    const encryptedAmounts = await Promise.all(claimedBurnAccounts.map(async (claim) => {
        const syncFields = claim.burnAccount.syncData[claim.chainId][claim.contract]
        const newTotalMinted = claim.amount + BigInt(syncFields.totalMinted)
        return await encryptTotalMinted({ viewingKey: BigInt(claim.burnAccount.viewingKey), amount: newTotalMinted })
    }))
    return encryptedAmounts
}
export function makeClaimable(
    spendableBurnAccounts: SpendableBurnAccount[], amount: bigint, largestCircuitSize: number, claimable?: SpendableBurnAccount[]
): { claimable: SpendableBurnAccount[], amountShort: bigint } {
    let amountLeft = amount
    if (claimable) {
        const alreadyClaimed = (claimable as SpendableBurnAccount[]).reduce((a, b) => a + b.amount, 0n)
        amountLeft = amount - alreadyClaimed
    }
    claimable ??= []

    for (const [index, { burnAccount, chainId, amount: spendableBalance, contract }] of spendableBurnAccounts.entries()) {
        if (claimable[index]) {
            amountLeft += claimable[index].amount
        }
        const amountToClaim = spendableBalance <= amountLeft ? spendableBalance : amountLeft
        amountLeft -= amountToClaim

        claimable[index] = {
            burnAccount,
            amount: amountToClaim,
            chainId,
            contract: contract
        }
        if (amountLeft === 0n) {
            break
        }
        if (claimable.length >= largestCircuitSize) {
            break
        }
    }
    return { claimable, amountShort: amountLeft }
}


export function selectSmallFirst(
    spendableBurnAccounts: SpendableBurnAccount[], amount: bigint, largestCircuitSize: number, tokenAddress: Address
): SpendableBurnAccount[] {

    // first we try to use all small accounts
    spendableBurnAccounts.sort((a, b) => Number(a.amount) - Number(b.amount))
    const { claimable: claimableAllChange, amountShort: amountShortChange } = makeClaimable(spendableBurnAccounts, amount, largestCircuitSize)

    if (amountShortChange === 0n) {
        return claimableAllChange

    } else {
        // now we go again but we reverse spendableBurnAccounts, so large balances are used first
        // and we reverse claimableAllChange, so largest change is replaced by largest accounts, until we meet our target amounts
        const { claimable: claimableMixedWithChange, amountShort: amountShortMixedChange } = makeClaimable(spendableBurnAccounts.toReversed(), amount, largestCircuitSize, claimableAllChange.toReversed())
        if (amountShortMixedChange !== 0n) {
            throw new Error(`not enough balances in selected burn accounts, short of ${Number(amountShortMixedChange)}, selected burn accounts: ${JSON.stringify(spendableBurnAccounts.map((e) => {
                const syncFields = e.burnAccount.syncData[e.chainId][tokenAddress]
                return {
                    chainId: e.chainId,
                    accountNonce: syncFields.accountNonce,
                    totalBurned: syncFields.totalBurned,
                    totalMinted: syncFields.totalMinted,
                    spendableBalance: syncFields.spendableBalance
                }
            }))}`)
        }
        return claimableMixedWithChange
    }
}

export function getHashedInputs(
    burnAccount: SyncedBurnAccount, claimAmount: bigint, tokenAddress: Address, syncedTree: PreSyncedTree, chainId: Hex, maxTreeDepth: number
) {
    const syncFields = burnAccount.syncData[chainId][tokenAddress]

    // --- inclusion proof ---
    // hash leafs
    const totalBurnedLeaf = hashTotalBurnedLeaf({
        burnAddress: burnAccount.burnAddress,
        totalBurned: BigInt(syncFields.totalBurned)
    })
    const prevTotalMintedNoteHashLeaf = BigInt(syncFields.accountNonce) === 0n ? 0n : hashTotalMintedLeaf({
        totalMinted: BigInt(syncFields.totalMinted),
        accountNonce: BigInt(syncFields.accountNonce),
        blindedAddressDataHash: BigInt(burnAccount.blindedAddressDataHash),
        viewingKey: BigInt(burnAccount.viewingKey)
    })
    // make merkle proofs
    const merkleProofs = getSpendableBalanceProof({
        tree: syncedTree.tree,
        totalMintedNoteHashLeaf: prevTotalMintedNoteHashLeaf,
        totalBurnedLeaf,
        maxTreeDepth
    })

    // --- public circuit inputs ---
    // hash public hashes (nullifier, commitment)
    const nextTotalMinted = BigInt(syncFields.totalMinted) + claimAmount
    const prevAccountNonce = BigInt(syncFields.accountNonce)
    const nextAccountNonce = BigInt(syncFields.accountNonce) + 1n
    const nextTotalMintedNoteHashLeaf = hashTotalMintedLeaf({
        totalMinted: nextTotalMinted,
        accountNonce: nextAccountNonce,
        blindedAddressDataHash: BigInt(burnAccount.blindedAddressDataHash),
        viewingKey: BigInt(burnAccount.viewingKey)
    })
    const nullifier = hashNullifier({
        accountNonce: prevAccountNonce,
        viewingKey: BigInt(burnAccount.viewingKey)
    })

    return { merkleProofs, nullifier, nextTotalMintedNoteHashLeaf }
}

export function getPubInputs(
    { circuitSizes, amountToReMint, root, chainId, signatureHash, nullifiers, noteHashes, circuitSize, powDifficulty, reMintLimit, burnAccountProofs }:
        { circuitSizes: number[], amountToReMint: bigint, root: bigint, chainId: bigint, signatureHash: Hex, nullifiers: bigint[], noteHashes: bigint[], burnAccountProofs: (BurnAccountProof | FakeBurnAccountProof)[], circuitSize?: number, powDifficulty: Hex, reMintLimit: Hex }) {

    const burn_data_public: BurnDataPublic[] = []
    circuitSize ??= getCircuitSize(nullifiers.length, circuitSizes)
    for (let index = 0; index < circuitSize; index++) {
        const noteHash = noteHashes[index] === undefined ? hashFakeLeaf({ viewingKey: BigInt(burnAccountProofs[index].burnAccount.viewingKey) }) : noteHashes[index]
        const nullifier = nullifiers[index] === undefined ? hashFakeNullifier({ viewingKey: BigInt(burnAccountProofs[index].burnAccount.viewingKey) }) : nullifiers[index]
        const publicBurnPoofData: BurnDataPublic = {
            total_minted_leaf: toHex(noteHash),
            nullifier: toHex(nullifier),
        }
        burn_data_public.push(publicBurnPoofData)
    }
    const pubInputs: PublicProofInputs = {
        root: toHex(root),
        chain_id: toHex(chainId),
        amount: toHex(amountToReMint),
        signature_hash: hexToU8AsHexLen32(signatureHash),
        burn_data_public: burn_data_public,
        pow_difficulty: powDifficulty,
        re_mint_limit: reMintLimit
    }
    return pubInputs
}

export async function selectBurnAccountsForClaim(
    amount: bigint,
    burnAccountSelector: BurnAccountSelector,
    burnViewKeyManager: BurnViewKeyManager,
    tokenAddress: Address,
    signingEthAccount: Address,

    chainId: bigint,
    allowedChainIds: Hex[],
    powDifficulty: Hex,

    circuitSizes: number[],
    circuitSize?: number,
    burnAddresses?: Address[],
) {
    // TODO should be a minimum powDifficulty
    const allBurnAccounts = getAllBurnAccounts(burnViewKeyManager.privateData, { ethAccounts: [signingEthAccount], chainIds: [chainId], difficulties: [BigInt(powDifficulty)] }) as SyncedBurnAccount[]
    burnAddresses ??= allBurnAccounts.map((b) => b.burnAddress)

    // select burn accounts for spend. Takes highest balances first
    // todo prepareBurnAccountsForSpend needs to be simpler. Just array of sorted burn accounts
    // then a function that 
    const spendableBurnAccounts = await toSpendableBurnAccounts(allBurnAccounts, tokenAddress, allowedChainIds, burnAddresses)
    const maxCircuitSize = circuitSize ?? circuitSizes[circuitSizes.length - 1]
    const burnAccountsAndAmounts = burnAccountSelector(spendableBurnAccounts, amount, maxCircuitSize, tokenAddress)
    return burnAccountsAndAmounts
}

/**
 * Notice: assumes the merkle proofs are in the same order as syncedPrivateWallets and amountsToClaim
 * @param param0 
 * @returns 
 */
export function getPrivInputs(
    { circuitSizes, signatureData, burnAccountsProofs, circuitSize, maxTreeDepth, tokenAddress }:
        { circuitSizes: number[], signatureData: SignatureData, burnAccountsProofs: (BurnAccountProof | FakeBurnAccountProof)[], circuitSize?: number, maxTreeDepth: number, tokenAddress: Address }) {

    const burn_address_private_proof_data: BurnDataPrivate[] = [];
    circuitSize ??= getCircuitSize(burnAccountsProofs.length, circuitSizes)
    let amountOfRealBurnAddresses = 0;
    for (let index = 0; index < circuitSize; index++) {
        const burnAccountProof = burnAccountsProofs[index];
        if ("merkleProofs" in burnAccountProof) {
            amountOfRealBurnAddresses += 1
            const prevTotalMintedMerkleProof = burnAccountProof.merkleProofs.totalMintedMerkleProofs
            const totalBurnedMerkleProof = burnAccountProof.merkleProofs.totalBurnedMerkleProofs;
            const claimAmount = burnAccountProof.claimAmount

            const syncFields = burnAccountProof.burnAccount.syncData[burnAccountProof.chainId][tokenAddress]
            const prevAccountNonce = syncFields.accountNonce
            const prevTotalMinted = syncFields.totalMinted
            const totalBurned = syncFields.totalBurned
            // const nextTotalSpent = prevTotalSpent + claimAmount
            // const nextAccountNonce = prevAccountNonce + 1n

            const privateBurnData: BurnDataPrivate = {
                viewing_key: burnAccountProof.burnAccount.viewingKey,
                pow_nonce: burnAccountProof.burnAccount.powNonce,
                total_burned: totalBurned,
                prev_total_minted: prevTotalMinted,
                amount_to_mint: toHex(claimAmount),
                prev_account_nonce: prevAccountNonce,
                prev_account_note_merkle_data: prevTotalMintedMerkleProof,
                total_burned_merkle_data: totalBurnedMerkleProof,
            }
            burn_address_private_proof_data.push(privateBurnData)

        } else {
            // circuit is not constraining this but it still needs something
            const privateBurnData: BurnDataPrivate = {
                viewing_key: burnAccountProof.burnAccount.viewingKey,
                pow_nonce: toHex(0n),
                total_burned: toHex(0n),
                prev_total_minted: toHex(0n),
                amount_to_mint: toHex(0n),
                prev_account_nonce: toHex(0n),
                prev_account_note_merkle_data: formatMerkleProof(EMPTY_UNFORMATTED_MERKLE_PROOF, maxTreeDepth),
                total_burned_merkle_data: formatMerkleProof(EMPTY_UNFORMATTED_MERKLE_PROOF, maxTreeDepth),
            }
            burn_address_private_proof_data.push(privateBurnData)

        }

    }

    const privInputs: PrivateProofInputs = {
        burn_data_private: burn_address_private_proof_data,
        signature_data: signatureData,
        amount_burn_addresses: toHex(amountOfRealBurnAddresses) as U32AsHex
    }
    return privInputs
}

export async function signAndEncrypt(
    recipient: Address, amount: bigint, signingEthAccount: Address,
    burnViewKeyManager: BurnViewKeyManager, burnAccountsAndAmounts: SpendableBurnAccount[],
    circuitSize: number, encryptedBlobLen: number, chainId: bigint,
    callData: Hex, callValue: bigint, callCanFail: boolean,
    tokenAddress: Address,
    eip712Name: string,
    eip712Version: string,
    feeData?: FeeData
) {
    const encryptedTotalMinted = await encryptTotalSpends(burnAccountsAndAmounts)
    // format inputs that wil be signed
    let signatureInputs: SignatureInputs | SignatureInputsWithFee = {
        contract: tokenAddress,
        recipient: recipient,
        amountToReMint: toHex(amount),
        callData: callData,
        callCanFail: callCanFail,
        callValue: toHex(callValue),
        // remember if you do not do padWithRandomHex you reveal how many address you consumed!
        encryptedTotalMinted: padWithRandomHex({ arr: encryptedTotalMinted, len: circuitSize, hexSize: encryptedBlobLen, dir: "right" }),
    }
    if (feeData) {
        signatureInputs = { ...signatureInputs, feeData } as SignatureInputsWithFee
    }

    const signature = await signPrivateTransfer(
        burnViewKeyManager,
        signatureInputs,
        Number(chainId),
        tokenAddress,
        signingEthAccount,
        eip712Name,
        eip712Version
    )
    return { signatureInputs, signature }

}

// Overload 1: feeData provided → RelayInputs
export async function createRelayerInputs(
    recipient: Address,
    amount: bigint,
    burnViewKeyManager: BurnViewKeyManager,
    tokenAddress: Address,
    archiveNode: PublicClient,
    signingEthAccount: Address,
    opts: CreateRelayerInputsOpts & { feeData: FeeData }
): Promise<{ relayInputs: RelayInputs, syncedData: { syncedTree: PreSyncedTree, syncedPrivateWallet: BurnViewKeyManager } }>;

// Overload 2: feeData omitted → SelfRelayInputs
export async function createRelayerInputs(
    recipient: Address,
    amount: bigint,
    burnViewKeyManager: BurnViewKeyManager,
    tokenAddress: Address,
    archiveNode: PublicClient,
    signingEthAccount: Address,
    opts?: CreateRelayerInputsOpts
): Promise<{ relayInputs: SelfRelayInputs, syncedData: { syncedTree: PreSyncedTree, syncedPrivateWallet: BurnViewKeyManager } }>;

/**
 * @TODO split up into sync and proof stage, so it's clear what can be done without an archive node
 * Creates the inputs needed to relay a private transfer (either self-relay or via a relayer).
 *
 * Syncs burn accounts, prepares encrypted spend data, signs the transfer, generates a Merkle
 * inclusion proof for each burn account, and produces a ZK proof over all inputs.
 *
 * Returns `SelfRelayInputs` when no `feeData` is provided, or `RelayInputs` when it is.
 *
 * @note chainId is not yet constrained in the circuit — included for future cross-chain support.
 *
 * @param recipient           - Address that will receive the re-minted tokens (required).
 * @param amount              - Amount to re-mint (required).
 * @param burnViewKeyManager  - The caller's private wallet containing burn accounts and signing keys (required).
 * @param tokenAddress - Address of the WormholeToken contract (required).
 * @param archiveNode         - Archive-node viem PublicClient used for syncing and log queries (required).
 * @param signingEthAccount   - Ethereum account used to sign the private transfer (required).
 *
 * --- Defaults via RPC call if not set ---
 * @param powDifficulty       - Proof-of-work difficulty. Defaults to on-chain value from `wormholeToken.POW_DIFFICULTY()`.
 * @param reMintLimit - Max cumulative re-mint cap. Defaults to on-chain value from `wormholeToken.RE_MINT_LIMIT()`.
 * @param chainId             - (@NOTICE not constrained rn) ChainId for the cross-chain transfer. Defaults to `archiveNode.getChainId()`.
 * @param circuitSizes         - sorted array of available circuit sizes. Sorted from smallest to highest.
 * @param maxTreeDepth        - Maximum Merkle tree depth. Defaults to `MAX_TREE_DEPTH`. Changing this produces invalid proofs.
 * 
 * --- Defaults without RPC call ---
 * @param feeData             - If provided, produces `RelayInputs` (third-party relay); omit for `SelfRelayInputs`.
 * @param callData            - Arbitrary calldata forwarded after re-mint. Defaults to `"0x"` (none).
 * @param callValue           - Native value forwarded with the call. Defaults to `0`.
 * @param callCanFail         - Whether a revert in the forwarded call is tolerated. Defaults to `true`.
 * @param burnAddresses       - Subset of burn addresses to spend from. Defaults to every address in `burnViewKeyManager`.
 * @param circuitSize         - Circuit size (number of burn-account slots). Defaults to the minimum size that fits the spend (e.g. 2 or 100).
 * @param encryptedBlobLen    - Byte length of each encrypted total-spend blob. Defaults to `ENCRYPTED_TOTAL_MINTED_PADDING + EAS_BYTE_LEN_OVERHEAD`. Changing this makes the transaction distinguishable and reduces anonymity.
 *
 * --- Performance / caching ---
 * @param threads             - Number of worker threads for proof generation. Defaults to max available.
 * @param deploymentBlock     - Block number the contract was deployed at. Defaults to the value in `src/constants.ts`.
 * @param preSyncedTree       - A previously synced Merkle tree to avoid re-syncing from scratch.
 * @param blocksPerGetLogsReq - Max block range per `eth_getLogs` request. Defaults to 19 999.
 * @param backend             - Pre-initialized prover backend; omit to create one internally.
 *
 * --- Circuit constants (do not change unless you know what you're doing) ---
 */
export async function createRelayerInputs(
    recipient: Address,
    amount: bigint,
    burnViewKeyManager: BurnViewKeyManager,
    tokenAddress: Address,
    archiveNode: PublicClient,
    signingEthAccount: Address,
    { burnAccountSelector = selectSmallFirst, allowedChainIds, fullNode, circuitSizes, threads, chainId, callData = "0x", callValue = 0n, callCanFail = false, feeData, burnAddresses, preSyncedTree, backends, deploymentBlock, blocksPerGetLogsReq, circuitSize, powDifficulty, reMintLimit, maxTreeDepth, eip712Name, eip712Version, encryptedBlobLen = ENCRYPTED_TOTAL_MINTED_PADDING + EAS_BYTE_LEN_OVERHEAD }:
        CreateRelayerInputsOpts & { feeData?: FeeData } = {}
): Promise<{ relayInputs: RelayInputs, syncedData: { syncedTree: PreSyncedTree, syncedPrivateWallet: BurnViewKeyManager } } | { relayInputs: SelfRelayInputs, syncedData: { syncedTree: PreSyncedTree, syncedPrivateWallet: BurnViewKeyManager } }> {
    //------- set defaults ----------------
    fullNode ??= archiveNode
    const wormholeTokenFull = getWormholeTokenContract(tokenAddress, { public: fullNode })
    circuitSizes ??= await getCircuitSizesFromContract(wormholeTokenFull as WormholeToken);
    if (circuitSize && circuitSizes.includes(circuitSize) === false) throw new Error(`circuit size: ${circuitSize} does not exist in contract: ${tokenAddress}, only sizes: ${circuitSizes.toString()} are available`)

    powDifficulty ??= await wormholeTokenFull.read.POW_DIFFICULTY()
    allowedChainIds ??= (await getAcceptedChainIdFromContract(wormholeTokenFull as WormholeToken)).map((v) => toHex(v))
    reMintLimit ??= await wormholeTokenFull.read.RE_MINT_LIMIT();
    chainId ??= BigInt(await fullNode.getChainId());
    maxTreeDepth ??= await wormholeTokenFull.read.MAX_TREE_DEPTH()
    if (eip712Name === undefined || eip712Version === undefined) {
        const [, name, version] = await wormholeTokenFull.read.eip712Domain()
        eip712Name ??= name
        eip712Version ??= version
    }
    // -------------------------------------

    // -------------- sync --------------
    // start this asap so we can resolve once we need it
    const syncedTreePromise = getSyncedMerkleTree(
        tokenAddress,
        archiveNode,
        //optional inputs
        {
            fullNode,
            preSyncedTree,
            deploymentBlock,
            blocksPerGetLogsReq
        }
    )

    // sync burn accounts
    const syncedPrivateWallet = await syncMultipleBurnAccounts(
        burnViewKeyManager,
        tokenAddress,
        archiveNode,
        {
            fullNode,
            burnAddressesToSync: burnAddresses, //@notice, only syncs these addresses!
            //ethAccounts: [ethAccount]         // we already know which burn addresses, we don't need to filter based on signer account
        }
    )

    // -------------burn account sync, selection -----------------------
    const burnAccountsAndAmounts = await selectBurnAccountsForClaim(
        amount, burnAccountSelector, burnViewKeyManager, tokenAddress, signingEthAccount,
        chainId, allowedChainIds, powDifficulty,
        circuitSizes, circuitSize,
        burnAddresses,
    )
    circuitSize ??= getCircuitSize(burnAccountsAndAmounts.length, circuitSizes)
    // -------------------------------------------------


    // ------------ sign and resolve merkle tree ------------------------
    const { signature: { signatureData, signatureHash }, signatureInputs } = await signAndEncrypt(
        recipient, amount, signingEthAccount,
        burnViewKeyManager, burnAccountsAndAmounts,
        circuitSize, encryptedBlobLen, chainId,
        callData, callValue, callCanFail,
        tokenAddress,
        eip712Name,
        eip712Version,
        feeData
    );
    const syncedTree = await syncedTreePromise;
    burnViewKeyManager = syncedPrivateWallet
    //----------------------------------------------------------------------

    // ----- hash inputs, format proof inputs and proof -----
    const relayInputs = await hashAndProof(
        amount,
        burnAccountsAndAmounts,
        signatureHash,
        signatureData,
        signatureInputs,
        tokenAddress,
        syncedTree,
        chainId,
        powDifficulty,
        reMintLimit,
        circuitSize,
        circuitSizes,
        maxTreeDepth,
        feeData,
        backends,
        threads,
    )
    return { relayInputs, syncedData: { syncedTree, syncedPrivateWallet } }
}

export async function hashAndProof(
    amount: bigint,
    burnAccountsAndAmounts: SpendableBurnAccount[],
    signatureHash: Hex,
    signatureData: SignatureData,
    signatureInputs: SignatureInputs,
    tokenAddress: Address,
    syncedTree: PreSyncedTree,
    chainId: bigint,
    powDifficulty: Hex,
    reMintLimit: Hex,
    circuitSize: number,
    circuitSizes: number[],
    maxTreeDepth: number,
    feeData?: FeeData,
    backends?: BackendPerSize,
    threads?: number,
) {
    // nullifiers, noteHashes, merkle proofs
    const nullifiers: bigint[] = []
    const noteHashes: bigint[] = []
    const burnAccountProofs: (BurnAccountProof | FakeBurnAccountProof)[] = []
    for (let index = 0; index < circuitSize; index++) {
        if (index < burnAccountsAndAmounts.length) {
            const { burnAccount, amount: amountToClaim, chainId: entryChainId } = burnAccountsAndAmounts[index];
            const { merkleProofs, nullifier, nextTotalMintedNoteHashLeaf } = getHashedInputs(
                burnAccount,
                amountToClaim,
                tokenAddress,
                syncedTree,
                entryChainId,
                maxTreeDepth
            )

            // group all this private inclusion proof data
            const burnAccountProof: BurnAccountProof = {
                burnAccount: burnAccount,
                merkleProofs: merkleProofs,
                claimAmount: amountToClaim,
                chainId: entryChainId
            }
            burnAccountProofs.push(burnAccountProof)
            nullifiers.push(nullifier)
            noteHashes.push(nextTotalMintedNoteHashLeaf)
        } else {
            const fakeBurnAccount: FakeBurnAccount = { viewingKey: toHex(randomBN254FieldElement()) }
            const burnAccountProof: FakeBurnAccountProof = {
                burnAccount: fakeBurnAccount,
            }
            const nullifier = hashFakeNullifier({ viewingKey: BigInt(fakeBurnAccount.viewingKey) })
            const nextTotalMintedNoteHash = hashFakeLeaf({ viewingKey: BigInt(fakeBurnAccount.viewingKey) })
            burnAccountProofs.push(burnAccountProof)

            nullifiers.push(nullifier)
            noteHashes.push(nextTotalMintedNoteHash)
        }
    }

    // final formatting proofs so noir can use them!
    const publicInputs = getPubInputs({
        amountToReMint: amount,
        root: syncedTree.tree.root,
        chainId: chainId,
        signatureHash: signatureHash,
        nullifiers: nullifiers,
        noteHashes: noteHashes,
        circuitSize: circuitSize,
        powDifficulty: powDifficulty,
        reMintLimit: reMintLimit,
        circuitSizes: circuitSizes,
        burnAccountProofs: burnAccountProofs
    })
    const privateInputs = getPrivInputs({
        burnAccountsProofs: burnAccountProofs,
        signatureData: signatureData,
        maxTreeDepth: maxTreeDepth,
        circuitSize: circuitSize,
        circuitSizes: circuitSizes,
        tokenAddress: tokenAddress
    })
    const proofInputs = { ...publicInputs, ...privateInputs }

    // make proof!
    const zkProof = await generateProof(proofInputs, circuitSizes, { backends, threads })
    if (feeData) {
        return {
            publicInputs: publicInputs,
            proof: toHex(zkProof.proof),
            signatureInputs: signatureInputs as SignatureInputsWithFee,
        } as RelayInputs;
    } else {
        return {
            publicInputs: publicInputs,
            proof: toHex(zkProof.proof),
            signatureInputs: signatureInputs as SignatureInputs,
        } as SelfRelayInputs;
    }

}

export function getBackend(circuitSize: number, threads?: number) {
    console.log("initializing backend with circuit")
    threads = threads ?? getAvailableThreads()
    console.log({ threads, circuitSize })
    const byteCode = circuits[circuitSize].bytecode
    return new UltraHonkBackend(byteCode, { threads: threads }, { recursive: false });
}

export async function generateProof(proofInputs: ProofInputs, circuitSizes: number[], { threads, backends }: { backends?: BackendPerSize, threads?: number } = {}) {
    const circuitSize = getCircuitSize(proofInputs.burn_data_public.length, circuitSizes)
    console.log("proving with:", { circuitSize, threads })
    const backend = (backends && backends[circuitSize]) ?? getBackend(circuitSize, threads)

    const circuitJson = circuits[circuitSize];
    const noir = new Noir(circuitJson as CompiledCircuit);
    const { witness } = await noir.execute(proofInputs as InputMap);
    console.log("generating proof")
    const start = Date.now()
    const proof = await backend.generateProof(witness, { keccakZK: true });
    console.log(`finished proving. It took ${Date.now() - start}ms`)
    return proof
}

export async function verifyProof({ proof, backend, circuitSize = 2 }: { proof: ProofData, backend?: UltraHonkBackend, circuitSize?: number }) {
    backend = backend ?? getBackend(circuitSize, undefined)
    return await backend.verifyProof(proof, { keccakZK: true })
}