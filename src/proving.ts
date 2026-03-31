import { toHex } from "viem"
import type { Hex, Address, PublicClient } from "viem"
import type { MerkleData, SpendableBalanceProof, PreSyncedTree, ProofInputs1n, ProofInputs4n, SignatureData, U1AsHexArr, U32AsHex, WormholeToken, PublicProofInputs, BurnDataPublic, BurnDataPrivate, PrivateProofInputs, FakeBurnAccount, CreateRelayerInputsOpts, FeeData, SelfRelayInputs, SignatureInputs, SignatureInputsWithFee, BurnAccountProof, FakeBurnAccountProof, RelayInputs, SyncedBurnAccount, BackendPerSize } from "./types.js"
import { EAS_BYTE_LEN_OVERHEAD, EMPTY_UNFORMATTED_MERKLE_PROOF, ENCRYPTED_TOTAL_SPENT_PADDING } from "./constants.ts"
import { hashTotalSpentLeaf, hashNullifier, hashTotalBurnedLeaf, hashFakeLeaf, hashFakeNullifier } from "./hashing.ts"
import type { LeanIMTMerkleProof } from "@zk-kit/lean-imt"
import { LeanIMT } from "@zk-kit/lean-imt"
import type { WormholeTokenTest } from "../test/remint2.test.ts"
import { encryptTotalSpend, getSyncedMerkleTree, syncMultipleBurnAccounts } from "./syncing.ts"
import type { ProofData } from '@aztec/bb.js';
import { UltraHonkBackend } from '@aztec/bb.js';
import type { CompiledCircuit, InputMap } from "@noir-lang/noir_js"
import { Noir } from "@noir-lang/noir_js"
import reMint2Circuit from '../circuits/reMint2/target/reMint2.json' with { type: 'json' };
import reMint32Circuit from '../circuits/reMint32/target/reMint32.json' with { type: 'json' };
import reMint100Circuit from '../circuits/reMint100/target/reMint100.json'  with { type: 'json' };
const circuits: { [k: number]: any } = {
    2: reMint2Circuit,
    32: reMint32Circuit,
    100: reMint100Circuit
}

//import { Fr } from "@aztec/aztec.js"
import { BurnViewKeyManager } from "./BurnViewKeyManager.ts"
import { assert } from "node:console"
import { getAllBurnAccounts, getAvailableThreads, getCircuitSize, getCircuitSizesFromContract, getWormholeTokenContract, hexToU8AsHexLen32, padArray, padWithRandomHex, randomBN254FieldElement } from "./utils.ts"
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
    { totalSpendNoteHashLeaf, tree, maxTreeDepth }:
        { totalSpendNoteHashLeaf: bigint, tree: LeanIMT<bigint>, maxTreeDepth: number }
): MerkleData {
    if (totalSpendNoteHashLeaf === 0n) {
        const merkleProof = formatMerkleProof(EMPTY_UNFORMATTED_MERKLE_PROOF, maxTreeDepth)
        return merkleProof
    } else {
        const totalSpendNoteHashIndex = tree.indexOf(totalSpendNoteHashLeaf)
        const unformattedMerkleProof = tree.generateProof(totalSpendNoteHashIndex)
        const merkleProof = formatMerkleProof(unformattedMerkleProof, maxTreeDepth)
        return merkleProof
    }
}


export function getBurnedMerkle(
    { totalBurnedLeaf, tree, maxTreeDepth }:
        { tree: LeanIMT<bigint>, totalBurnedLeaf: bigint, maxTreeDepth: number }
): MerkleData {
    const totalReceivedIndex = tree.indexOf(totalBurnedLeaf)
    const unformattedMerkleProof = tree.generateProof(totalReceivedIndex)
    const merkleProof = formatMerkleProof(unformattedMerkleProof, maxTreeDepth)
    return merkleProof
}

/**
 * @notice does not sync the wallet or tree. Assumes it is already synced, will create merkle proofs on commitments that are already nullified or on a old tree
 * @param param0 
 * @returns 
 */
export function getSpendableBalanceProof(
    { totalSpendNoteHashLeaf, totalBurnedLeaf, tree, maxTreeDepth }:
        { totalSpendNoteHashLeaf: bigint, totalBurnedLeaf: bigint, tree: LeanIMT<bigint>, maxTreeDepth: number }
): SpendableBalanceProof {
    const totalSpendMerkleProofs = getAccountNoteMerkle({ totalSpendNoteHashLeaf, tree, maxTreeDepth })
    const totalBurnedMerkleProofs = getBurnedMerkle({ totalBurnedLeaf, tree, maxTreeDepth })

    return {
        totalSpendMerkleProofs: totalSpendMerkleProofs,
        totalBurnedMerkleProofs: totalBurnedMerkleProofs,
        root: toHex(tree.root),
    }
}

export async function prepareBurnAccountsForSpend({ burnAccounts, selectBurnAddresses, amount, largestCircuitSize }: { largestCircuitSize: number, burnAccounts: SyncedBurnAccount[], selectBurnAddresses: Address[], amount: bigint }) {
    const sortedBurnAccounts = burnAccounts.sort((a, b) => Number(b.spendableBalance) - Number(a.spendableBalance))
    const encryptedTotalMinted: Hex[] = []
    // man so many copy pasta of same array and big name!! Fix it i cant read this!!!!
    const burnAccountsAndAmounts: { burnAccount: SyncedBurnAccount, amountToClaim: bigint }[] = []
    let amountLeft = amount
    for (const burnAccount of sortedBurnAccounts) {
        if (selectBurnAddresses.includes(burnAccount.burnAddress)) {
            const spendableBalance = BigInt(burnAccount.spendableBalance)
            let amountToClaim = 0n
            if (spendableBalance <= amountLeft) {
                amountToClaim = spendableBalance
            } else {
                amountToClaim = amountLeft
            }
            amountLeft -= amountToClaim
            const newTotalSpent = amountToClaim + BigInt(burnAccount.totalSpent)
            encryptedTotalMinted.push(await encryptTotalSpend({ viewingKey: BigInt(burnAccount.viewingKey), amount: newTotalSpent }))
            burnAccountsAndAmounts.push({
                burnAccount: burnAccount,
                amountToClaim: amountToClaim
            })
            if (amountLeft === 0n) {
                break
            }
        }
    }
    if (amountLeft !== 0n) {
        throw new Error(`not enough balances in selected burn accounts, short of ${Number(amountLeft)}, selected burn accounts: ${JSON.stringify(sortedBurnAccounts.map((b) => {
            return {
                accountNonce: b.accountNonce,
                totalBurned: b.totalBurned,
                totalSpent: b.totalSpent,
                spendableBalance: b.spendableBalance
            }
        }))}`)
    }

    //console.log(`burn accounts selected: \n${burnAccountsAndAmounts.map((b) => `${b.burnAccount.burnAddress},spendable:${b.burnAccount.spendableBalance},burned:${b.burnAccount.totalBurned},amountToBeClaimed:${b.amountToClaim}\n`)}`)
    if (burnAccountsAndAmounts.length > largestCircuitSize) {
        throw new Error(`need to consume more than LARGEST_CIRCUIT_SIZE of: ${largestCircuitSize}, but need to consume: ${burnAccountsAndAmounts.length} burnAccount to make the transaction. Please consolidate balance to make this tx`)
    }
    return { burnAccountsAndAmounts, encryptedTotalMinted }
}

export function getHashedInputs(
    burnAccount: SyncedBurnAccount, claimAmount: bigint, syncedTree: PreSyncedTree, maxTreeDepth: number
) {

    // --- inclusion proof ---
    // hash leafs
    const totalBurnedLeaf = hashTotalBurnedLeaf({
        burnAddress: burnAccount.burnAddress,
        totalBurned: BigInt(burnAccount.totalBurned)
    })
    const prevTotalSpendNoteHashLeaf = BigInt(burnAccount.accountNonce) === 0n ? 0n : hashTotalSpentLeaf({
        totalSpent: BigInt(burnAccount.totalSpent),
        accountNonce: BigInt(burnAccount.accountNonce),
        blindedAddressDataHash: BigInt(burnAccount.blindedAddressDataHash),
        viewingKey: BigInt(burnAccount.viewingKey)
    })
    // make merkle proofs
    const merkleProofs = getSpendableBalanceProof({
        tree: syncedTree.tree,
        totalSpendNoteHashLeaf: prevTotalSpendNoteHashLeaf,
        totalBurnedLeaf,
        maxTreeDepth
    })

    // --- public circuit inputs ---
    // hash public hashes (nullifier, commitment)
    const nextTotalSpend = BigInt(burnAccount.totalSpent) + claimAmount
    const prevAccountNonce = BigInt(burnAccount.accountNonce)
    const nextAccountNonce = BigInt(burnAccount.accountNonce) + 1n
    const nextTotalSpendNoteHashLeaf = hashTotalSpentLeaf({
        totalSpent: nextTotalSpend,
        accountNonce: nextAccountNonce,
        blindedAddressDataHash: BigInt(burnAccount.blindedAddressDataHash),
        viewingKey: BigInt(burnAccount.viewingKey)
    })
    const nullifier = hashNullifier({
        accountNonce: prevAccountNonce,
        viewingKey: BigInt(burnAccount.viewingKey)
    })

    return { merkleProofs, nullifier, nextTotalSpendNoteHashLeaf }
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

/**
 * Notice: assumes the merkle proofs are in the same order as syncedPrivateWallets and amountsToClaim
 * @param param0 
 * @returns 
 */
export function getPrivInputs(
    { circuitSizes, signatureData, burnAccountsProofs, circuitSize, maxTreeDepth }:
        { circuitSizes: number[], signatureData: SignatureData, burnAccountsProofs: (BurnAccountProof | FakeBurnAccountProof)[], circuitSize?: number, maxTreeDepth: number }) {

    const burn_address_private_proof_data: BurnDataPrivate[] = [];
    circuitSize ??= getCircuitSize(burnAccountsProofs.length, circuitSizes)
    let amountOfRealBurnAddresses = 0;
    for (let index = 0; index < circuitSize; index++) {
        const burnAccountProof = burnAccountsProofs[index];
        if ("merkleProofs" in burnAccountProof) {
            amountOfRealBurnAddresses += 1
            const prevTotalSpendMerkleProof = burnAccountProof.merkleProofs.totalSpendMerkleProofs
            const totalBurnedMerkleProof = burnAccountProof.merkleProofs.totalBurnedMerkleProofs;
            const claimAmount = burnAccountProof.claimAmount


            const prevAccountNonce = burnAccountProof.burnAccount.accountNonce
            const prevTotalSpent = burnAccountProof.burnAccount.totalSpent
            const totalBurned = burnAccountProof.burnAccount.totalBurned
            // const nextTotalSpent = prevTotalSpent + claimAmount
            // const nextAccountNonce = prevAccountNonce + 1n

            const privateBurnData: BurnDataPrivate = {
                viewing_key: burnAccountProof.burnAccount.viewingKey,
                pow_nonce: burnAccountProof.burnAccount.powNonce,
                total_burned: totalBurned,
                prev_total_minted: prevTotalSpent,
                amount_to_mint: toHex(claimAmount),
                prev_account_nonce: prevAccountNonce,
                prev_account_note_merkle_data: prevTotalSpendMerkleProof,
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

// Overload 1: feeData provided → RelayInputs
export async function createRelayerInputs(
    signingEthAccount: Address,
    recipient: Address,
    amount: bigint,
    BurnViewKeyManager: BurnViewKeyManager,
    wormholeTokenAddress: Address,
    archiveNode: PublicClient,
    opts: CreateRelayerInputsOpts & { feeData: FeeData }
): Promise<{ relayInputs: RelayInputs, syncedData: { syncedTree: PreSyncedTree, syncedPrivateWallet: BurnViewKeyManager } }>;

// Overload 2: feeData omitted → SelfRelayInputs
export async function createRelayerInputs(
    signingEthAccount: Address,
    recipient: Address,
    amount: bigint,
    BurnViewKeyManager: BurnViewKeyManager,
    wormholeTokenAddress: Address,
    archiveNode: PublicClient,
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
 * @param amount              - Amount to re-mint (required).
 * @param recipient           - Address that will receive the re-minted tokens (required).
 * @param BurnViewKeyManager       - The caller's private wallet containing burn accounts and signing keys (required).
 * @param wormholeToken       - Contract instance for the WormholeToken (required).
 * @param archiveNode       - Archive-node viem PublicClient used for syncing and log queries (required).
 *
 * --- Defaults via RPC call if not set ---
 * @param powDifficulty       - Proof-of-work difficulty. Defaults to on-chain value from `wormholeToken.POW_DIFFICULTY()`.
 * @param reMintLimit - Max cumulative re-mint cap. Defaults to on-chain value from `wormholeToken.RE_MINT_LIMIT()`.
 * @param chainId             - (@NOTICE not constrained rn) ChainId for the cross-chain transfer. Defaults to `archiveClient.getChainId()`.
 * @param circuitSizes         - sorted array of available circuit sizes. Sorted from smallest to highest.
 * @param maxTreeDepth        - Maximum Merkle tree depth. Defaults to `MAX_TREE_DEPTH`. Changing this produces invalid proofs.
 * 
 * --- Defaults without RPC call ---
 * @param feeData             - If provided, produces `RelayInputs` (third-party relay); omit for `SelfRelayInputs`.
 * @param callData            - Arbitrary calldata forwarded after re-mint. Defaults to `"0x"` (none).
 * @param callValue           - Native value forwarded with the call. Defaults to `0`.
 * @param callCanFail         - Whether a revert in the forwarded call is tolerated. Defaults to `true`.
 * @param burnAddresses       - Subset of burn addresses to spend from. Defaults to every address in `BurnViewKeyManager`.
 * @param circuitSize         - Circuit size (number of burn-account slots). Defaults to the minimum size that fits the spend (e.g. 2 or 100).
 * @param encryptedBlobLen    - Byte length of each encrypted total-spend blob. Defaults to `ENCRYPTED_TOTAL_SPENT_PADDING + EAS_BYTE_LEN_OVERHEAD`. Changing this makes the transaction distinguishable and reduces anonymity.
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
    signingEthAccount: Address,
    recipient: Address,
    amount: bigint,
    BurnViewKeyManager: BurnViewKeyManager,
    wormholeTokenAddress: Address,
    archiveNode: PublicClient,
    { fullNode, circuitSizes, threads, chainId, callData = "0x", callValue = 0n, callCanFail = false, feeData, burnAddresses, preSyncedTree, backends, deploymentBlock, blocksPerGetLogsReq, circuitSize, powDifficulty, reMintLimit, maxTreeDepth, encryptedBlobLen = ENCRYPTED_TOTAL_SPENT_PADDING + EAS_BYTE_LEN_OVERHEAD }:
        CreateRelayerInputsOpts & { feeData?: FeeData } = {}
): Promise<{ relayInputs: RelayInputs, syncedData: { syncedTree: PreSyncedTree, syncedPrivateWallet: BurnViewKeyManager } } | { relayInputs: SelfRelayInputs, syncedData: { syncedTree: PreSyncedTree, syncedPrivateWallet: BurnViewKeyManager } }> {
    // set defaults
    fullNode ??= archiveNode
    const wormholeTokenFull = getWormholeTokenContract(wormholeTokenAddress, { public: fullNode })
    powDifficulty ??= await wormholeTokenFull.read.POW_DIFFICULTY()
    reMintLimit ??= await wormholeTokenFull.read.RE_MINT_LIMIT();
    circuitSizes ??= await getCircuitSizesFromContract(wormholeTokenFull as WormholeToken);
    chainId ??= BigInt(await fullNode.getChainId());
    maxTreeDepth ??= await wormholeTokenFull.read.MAX_TREE_DEPTH()
    // TODO should be a minimum powDifficulty
    burnAddresses ??= getAllBurnAccounts(BurnViewKeyManager.privateData, { ethAccounts: [signingEthAccount], chainIds: [chainId], difficulties: [BigInt(powDifficulty)] }).map((b) => b.burnAddress)
    const largestCircuitSize = circuitSizes[circuitSizes.length - 1]

    // start this asap so we can resolve once we need it
    const syncedTreePromise = await getSyncedMerkleTree(
        wormholeTokenAddress,
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
        BurnViewKeyManager,
        wormholeTokenAddress,
        archiveNode,
        {
            fullNode,
            burnAddressesToSync: burnAddresses, //@notice, only syncs these addresses!
            //ethAccounts: [ethAccount]         // we already know which burn addresses, we don't need to filter based on signer account
        }
    )
    const burnAccounts = getAllBurnAccounts(BurnViewKeyManager.privateData, { ethAccounts: [signingEthAccount], chainIds: [chainId], difficulties: [BigInt(powDifficulty)] }) as SyncedBurnAccount[]

    // select burn accounts for spend. Takes highest balances first
    const { burnAccountsAndAmounts, encryptedTotalMinted } = await prepareBurnAccountsForSpend({ burnAccounts, selectBurnAddresses: burnAddresses, amount, largestCircuitSize: largestCircuitSize })
    circuitSize ??= getCircuitSize(burnAccountsAndAmounts.length, circuitSizes)

    // format inputs that wil be signed
    let signatureInputs: SignatureInputs | SignatureInputsWithFee = {
        contract: wormholeTokenAddress,
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

    const allSignatureDataPromise = await signPrivateTransfer(
        BurnViewKeyManager,
        signatureInputs,
        Number(chainId),
        wormholeTokenAddress,
        signingEthAccount
    )

    const syncedTree = await syncedTreePromise;
    const { signatureData, signatureHash } = await allSignatureDataPromise;
    BurnViewKeyManager = syncedPrivateWallet
    //----------------------------------------------------------------------

    // ----- collect proof inputs from the burn accounts -----
    // nullifiers, noteHashes, merkle proofs
    const nullifiers: bigint[] = []
    const noteHashes: bigint[] = []
    const burnAccountProofs: (BurnAccountProof | FakeBurnAccountProof)[] = []
    // TODO @Warptoad: check chainId matches burn account. remove burn account with different chainId
    for (let index = 0; index < circuitSize; index++) {
        if (index < burnAccountsAndAmounts.length) {
            const { burnAccount, amountToClaim } = burnAccountsAndAmounts[index];
            const { merkleProofs, nullifier, nextTotalSpendNoteHashLeaf } = getHashedInputs(
                burnAccount,
                amountToClaim,
                syncedTree,
                maxTreeDepth
            )

            // group all this private inclusion proof data
            const burnAccountProof: BurnAccountProof = {
                burnAccount: burnAccount,
                merkleProofs: merkleProofs,
                claimAmount: amountToClaim
            }
            burnAccountProofs.push(burnAccountProof)
            nullifiers.push(nullifier)
            noteHashes.push(nextTotalSpendNoteHashLeaf)
        } else {
            const fakeBurnAccount: FakeBurnAccount = { viewingKey: toHex(randomBN254FieldElement()) }
            const burnAccountProof: FakeBurnAccountProof = {
                burnAccount: fakeBurnAccount,
            }
            const nullifier = hashFakeNullifier({ viewingKey: BigInt(fakeBurnAccount.viewingKey) })
            const nextTotalSpendNoteHash = hashFakeLeaf({ viewingKey: BigInt(fakeBurnAccount.viewingKey) })
            burnAccountProofs.push(burnAccountProof)

            nullifiers.push(nullifier)
            noteHashes.push(nextTotalSpendNoteHash)
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
        circuitSizes: circuitSizes
    })
    const proofInputs = { ...publicInputs, ...privateInputs } as ProofInputs1n | ProofInputs4n

    // make proof!
    const zkProof = await generateProof(proofInputs, circuitSizes, { backends, threads })
    if (feeData) {
        return {
            relayInputs:
                {
                    publicInputs: publicInputs,
                    proof: toHex(zkProof.proof),
                    signatureInputs: signatureInputs as SignatureInputsWithFee,
                } as RelayInputs,
            syncedData: {
                syncedTree,
                syncedPrivateWallet
            }
        };
    } else {
        return {
            relayInputs: {
                publicInputs: publicInputs,
                proof: toHex(zkProof.proof),
                signatureInputs: signatureInputs as SignatureInputs,
            } as SelfRelayInputs,
            syncedData: {
                syncedTree,
                syncedPrivateWallet
            }
        };
    }
}

export function getBackend(circuitSize: number, threads?: number) {
    console.log("initializing backend with circuit")
    threads = threads ?? getAvailableThreads()
    console.log({ threads })
    const byteCode = circuits[circuitSize].bytecode
    return new UltraHonkBackend(byteCode, { threads: threads }, { recursive: false });
}

export async function generateProof(proofInputs: ProofInputs1n | ProofInputs4n, circuitSizes: number[], { threads, backends }: { backends?: BackendPerSize, threads?: number } = {}) {
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