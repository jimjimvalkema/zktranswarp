// PrivateWallet is a wrapper that exposes some of viem's WalletClient functions and requires them to only ever use one ethAccount

import type { Address, Hex, PublicClient, WalletClient } from "viem";
import { hashMessage, padHex, toHex } from "viem";
import type { BurnAccount, PreSyncedTreeStringifyable, PreSyncedTree, ExportedViewKeyData, WormholeToken } from "./types.ts"
import { findPoWNonce, findPoWNonceAsync, getBurnAddress, hashBlindedAddressData } from "./hashing.ts";
import { VIEWING_KEY_SIG_MESSAGE } from "./constants.ts";
import { poseidon2Hash } from "@zkpassport/poseidon2"
import { getDeterministicBurnAccounts } from "./utils.ts";
import { extractPubKeyFromSig, getViewingKey } from "./signing.ts";
import type { IndexHtmlTransformContext } from "vite";
import { BurnViewKeyManager } from "./BurnViewKeyManager.ts";
import { LeanIMT } from "@zk-kit/lean-imt";
import { poseidon2IMTHashFunc } from "./syncing.ts";
import { PreSyncedTreeStringifyableSchema } from "./schemas.ts";
//import { findPoWNonceAsync } from "./hashingAsync.js";


export class BurnWallet {
    readonly burnViewKeyManager: BurnViewKeyManager
    readonly viemWallet: WalletClient;
    merkleTree: PreSyncedTree;

    /**
     * @param viemWallet
     * @param powDifficulty
     * @param options - Optional configuration object.
     * @param options.walletImport - Existing wallet data to import. as a stringified JSON. If omitted, a fresh wallet is initialized.
     * @param options.viewKeySigMessage - Message used to derive the viewing key root. Defaults to {@link VIEWING_KEY_SIG_MESSAGE}.
     * @param options.acceptedChainIds - List of accepted chain IDs. Defaults to `[1n]`.
     * @param options.chainId - Default chain ID for operations. Inferred from `acceptedChainIds` if not provided.
     */
    constructor(
        viemWallet: WalletClient, powDifficulty: bigint,
        { merkleTree, viewKeySigMessage = VIEWING_KEY_SIG_MESSAGE, acceptedChainIds = [1n], chainId }:
            { merkleTree?: PreSyncedTree, walletDataImport?: string, viewKeySigMessage?: string, powDifficulty?: bigint, acceptedChainIds?: bigint[], chainId?: bigint } = {}
    ) {

        this.viemWallet = viemWallet;
        // TODO firstSyncedBlock;0n might create issues since it should be the deployment block of the contract
        this.merkleTree = merkleTree ? merkleTree : {tree:new LeanIMT(poseidon2IMTHashFunc), lastSyncedBlock:0n, firstSyncedBlock:0n} as PreSyncedTree
        this.burnViewKeyManager = new BurnViewKeyManager(
            viemWallet, powDifficulty,
            {
                viewKeySigMessage, acceptedChainIds, chainId
            }
        )
    }

    async connect(ethAccount?: Address) {
        ethAccount ??= (await this.viemWallet.getAddresses())[0]
        return await this.burnViewKeyManager.connect(ethAccount)
    }

    /**
     * Creates a new burn account by generating (or accepting) a viewing key,
     * deterministically finding a PoW nonce, and deriving the corresponding
     * burn address.
     *
     * By default, both the viewing key and PoW nonce are deterministically derived,
     * enabling account recovery from the internal root and counter. If either
     * `viewingKey` or `powNonce` is provided manually, recovery is no longer
     * deterministic losing either value means permanent loss of access to
     * associated funds.
     *
     * @param options - Optional configuration object.
     * @param options.viewingKey - A custom viewing key. If omitted, one is
     *   deterministically derived from the internal root and `viewingKeyIndex`.
     *   **Warning:** providing your own key bypasses deterministic recovery 
     *   loss of this value results in loss of funds.
     * @param options.viewingKeyIndex - Index used for deterministic viewing key
     *   derivation. Defaults to `this.privateData.detViewKeyCounter`, which is
     *   then incremented.
     * @param options.chainId - Target chain ID. Defaults to `this.defaults.chainId`.
     *   Must be in `this.acceptedChainIds`.
     * @param options.powNonce - A pre-computed proof-of-work nonce. If omitted,
     *   one is computed deterministically using the specified `difficulty`.
     *   **Warning:** providing your own nonce bypasses deterministic recovery 
     *   both the viewing key and nonce are required to recover an account;
     *   losing either results in loss of funds.
     * @param options.difficulty - PoW difficulty override. Defaults to
     *   `this.defaults.powDifficulty`.
     * @param options.async - If `true`, computes the PoW nonce on its own worker
     *   thread, avoiding UI freezes. Defaults to `false`.
     *
     * @returns The newly created {@link BurnAccount} (either {@link UnsyncedBurnAccountDet}
     *   or {@link UnsyncedBurnAccountNonDet} depending on whether custom inputs were provided),
     *   also appended to the appropriate burn accounts store.
     *
     * @throws {Error} If `chainId` is not in `this.acceptedChainIds`.
     * @throws {Error} If a provided `powNonce` fails verification.
     */
    async createBurnAccount(
        { powNonce, viewingKey, viewingKeyIndex, chainId, difficulty, async = false }:
            { powNonce?: bigint, viewingKey?: bigint, viewingKeyIndex?: number, chainId?: bigint, difficulty?: bigint, async?: boolean } = {}
    ) {
        return this.burnViewKeyManager.createBurnAccount({ powNonce, viewingKey, viewingKeyIndex, chainId, difficulty, async })
    }

    /**
     * Creates multiple burn accounts in bulk, deterministically deriving a PoW
     * nonce and burn address for each.
     *
     * @notice PoW nonces are found in parallel when `async: true`.
     *
     * @param amountOfBurnAccounts - Number of burn accounts to create.
     * @param options - Optional configuration object.
     * @param options.chainId - Target chain ID. Defaults to `this.defaults.chainId`.
     *   Must be in `this.acceptedChainIds`.
     * @param options.difficulty - PoW difficulty override. Defaults to
     *   `this.defaults.powDifficulty`.
     * @param options.async - If `true`, each account's PoW nonce is computed on
     *   its own worker thread, avoiding UI freezes. Defaults to `false`.
     *
     * @returns An array of newly created {@link BurnAccount} objects (either det or non-det
     *   depending on inputs), also appended to `this.privateData.detBurnAccounts`.
     *
     * @throws {Error} If `chainId` is not in `this.acceptedChainIds`.
     *
     * @TODO spawning one worker per account may be inefficient beyond available
     *   thread count  assumes most callers don't need large batches.
     */
    async createBurnAccountsBulk(
        amountOfBurnAccounts: number,
        { startingViewKeyIndex, chainId, difficulty, async = false }:
            { startingViewKeyIndex?: number, async?: boolean, chainId?: bigint, difficulty?: bigint } = {}
    ) {
        return this.burnViewKeyManager.createBurnAccountsBulk(amountOfBurnAccounts, { startingViewKeyIndex, chainId, difficulty, async })
    }



    // TODO make optional that viewKeys have to be exported. Probably just ban unknown derivation accounts
    exportWallet({ paranoidMode = false, merkleTree = true, viewKeyData = true }: {paranoidMode?:boolean, merkleTree?: boolean, viewKeyData?: boolean } = {}) {
        return JSON.stringify({
            privateData: viewKeyData ? this.burnViewKeyManager.exportViewKeyData(paranoidMode) : undefined,
            merkleTree: merkleTree ? {firstSyncedBlock:this.merkleTree.firstSyncedBlock, lastSyncedBlock:this.merkleTree.lastSyncedBlock, exportedNodes:this.merkleTree.tree.export() } : undefined
        },null,2)
    }

/**
 * Imports wallet data from a JSON string, optionally restoring the Merkle tree
 * and/or view key data.
 *
 * @param json - Stringified wallet export produced by {@link exportWallet}.
 * @param wormholeTokenContract - The Wormhole token contract instance, used to sync view key data.
 * @param archiveClient - Archive node client, used to sync view key data.
 * @param options 
 * @param options.merkleTree - Whether to import the Merkle tree. Defaults to `true`.
 * @param options.viewKeyData - Whether to import the view key data. Defaults to `true`.
 */
async importWallet(
    json: string,
    wormholeTokenContract: WormholeToken,
    archiveClient: PublicClient,
    { merkleTree = true, viewKeyData = true }: { merkleTree?: boolean, viewKeyData?: boolean } = {}
) {
    const parsed = JSON.parse(json) as { merkleTree: PreSyncedTreeStringifyable, privateData: ExportedViewKeyData }

    if (parsed.merkleTree && merkleTree) {
        const stringTree = PreSyncedTreeStringifyableSchema.parse(parsed.merkleTree)
        const tree = LeanIMT.import(poseidon2IMTHashFunc, stringTree.exportedNodes)
        
        // TODO imported tree is assumed to be more upto date here
        this.merkleTree = {
            firstSyncedBlock: BigInt(stringTree.firstSyncedBlock),
            lastSyncedBlock: BigInt(stringTree.lastSyncedBlock),
            tree: tree
        } as PreSyncedTree
    }

    if (parsed.privateData && viewKeyData) {
        await this.burnViewKeyManager.importViewKeyWalletData(parsed.privateData, wormholeTokenContract, archiveClient)
    }
}
}