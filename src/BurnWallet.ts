// PrivateWallet is a wrapper that exposes some of viem's WalletClient functions and requires them to only ever use one ethAccount

import type { Address, Hex, PublicClient, WalletClient } from "viem";
import { createPublicClient, custom, getAddress, getContract, padHex, toHex } from "viem";
import type { BurnAccount, PreSyncedTreeStringifyable, PreSyncedTree, ExportedViewKeyData, WormholeToken, SelfRelayInputs, RelayInputs, CreateRelayerInputsOpts, FeeData, ClientPerChainId, WormholeContractConfig, FeeDataOptionals, SpendableBurnAccount, BackendPerSize, BurnAccountSelector, SignatureInputs, SignatureData, BurnAccountSelectionForSpend, SignedProofInputs } from "./types.ts"
import { EAS_BYTE_LEN_OVERHEAD, ENCRYPTED_TOTAL_MINTED_PADDING, RE_MINT_RELAYER_GAS, RE_MINT_RELAYER_GAS_DEFAULT_L1, SLOWEST_PROOF_PADDING, VIEWING_KEY_SIG_MESSAGE } from "./constants.ts";
import { BurnViewKeyManager } from "./BurnViewKeyManager.ts";
import { LeanIMT } from "@zk-kit/lean-imt";
import { getSyncedMerkleTree, poseidon2IMTHashFunc, syncMultipleBurnAccounts } from "./syncing.ts";
import { ExportedMerkleTreesSchema, PreSyncedTreeStringifyableSchema, type ExportedMerkleTrees } from "./schemas.ts";
import { burn, relayTx, selfRelayTx, superSafeBurn, superSafeBurnBulk } from "./transact.ts";
import type { WormholeToken$Type } from "../artifacts/contracts/WormholeToken.sol/artifacts.ts"
import WormholeTokenArtifact from '../artifacts/contracts/WormholeToken.sol/WormholeToken.json' with {"type": "json"};
import { createRelayerInputs, hashAndProof, selectBurnAccountsForClaim, selectSmallFirst, signAndEncrypt } from "./proving.ts";
import { getAllBurnAccounts, getCircuitSize, getContractConfig, getWormholeTokenContract } from "./utils.ts";
//import { findPoWNonceAsync } from "./hashingAsync.js";

export const viemAccountNotSetErr = `viem wallet not created with account set. pls do: 
            const wallet = createWalletClient({
                account, // <-- this sets viemWallet.account
                chain: mainnet,
                transport: custom(window.ethereum),
            });
            `

export class BurnWallet {
    readonly burnViewKeyManager: BurnViewKeyManager
    viemWallet: WalletClient;
    readonly archiveNodes: ClientPerChainId;
    readonly fullNodes: ClientPerChainId
    readonly contractConfig: { [chainId: Hex]: { [Address: Address]: WormholeContractConfig } } = {};
    readonly merkleTrees: { [chainId: Hex]: { [Address: Address]: PreSyncedTree } } = {};

    /**
     * @notice if a user switches their chain, archiveNode and fullNode wont switch with it
     * pls detect that (`window.ethereum.on('chainChanged', (chainId: Hex)=>doSomething())`) in that case and re construct the wallet. 
     * @TODO instead make archiveNode and fullNode be a collection perChainId. And on every function called, get the right node
     * @param viemWallet
     * @param powDifficulty
     * @param options - Optional configuration object.
     * @param options.walletImport - Existing wallet data to import. as a stringified JSON. If omitted, a fresh wallet is initialized.
     * @param options.viewKeySigMessage - Message used to derive the viewing key root. Defaults to {@link VIEWING_KEY_SIG_MESSAGE}.
     * @param options.acceptedChainIds - List of accepted chain IDs. Defaults to `[1n]`.
     * @param options.archiveNode - Defaults to fullNode, if no fullNode, defaults to viemWallets public client
     * @param options.fullNode - Defaults to archiveNode, if no archiveNode, defaults to viemWallets public client
     */
    constructor(
        viemWallet: WalletClient,
        { archiveNodes, fullNodes, merkleTrees, contractConfigs, viewKeySigMessage = VIEWING_KEY_SIG_MESSAGE, acceptedChainIds = [1], chainId }:
            { archiveNodes?: ClientPerChainId, fullNodes?: ClientPerChainId, merkleTrees?: { [chainId: Hex]: { [Address: Address]: PreSyncedTree } }, contractConfigs?: { [chainId: Hex]: { [Address: Address]: WormholeContractConfig } }, walletDataImport?: string, viewKeySigMessage?: string, acceptedChainIds?: number[], chainId?: number } = {}
    ) {
        if (viemWallet.account === undefined) throw new Error(viemAccountNotSetErr)

        this.viemWallet = viemWallet;
        this.archiveNodes = archiveNodes ?? fullNodes ?? {};
        this.fullNodes = fullNodes ?? archiveNodes ?? {};
        // TODO firstSyncedBlock;0n might create issues since it should be the deployment block of the contract
        this.merkleTrees = merkleTrees ?? {}
        this.contractConfig = contractConfigs ?? {}
        this.burnViewKeyManager = new BurnViewKeyManager(
            viemWallet,
            {
                viewKeySigMessage, acceptedChainIds, chainId
            }
        )
    }

    async getBurnAccounts(
        tokenAddress: Address,
        { ethSigner, chainId, difficulty, type = "derived" }:
            { ethSigner?: Address, chainId?: Hex, difficulty?: Hex, type?: "derived" | "unknown" } = {}
    ): Promise<BurnAccount[]> {
        ethSigner ??= await this.defaultSigner()
        chainId ??= toHex(await this.viemWallet.getChainId())
        const contractConfig = await this.getContractConfig(tokenAddress)
        difficulty = difficulty ? padHex(difficulty, { size: 32 }) : padHex(contractConfig.POW_DIFFICULTY, { size: 32 })
        const burnAccounts = this.burnViewKeyManager.privateData.burnAccounts[ethSigner as string].burnAccounts[chainId as string][difficulty as string]
        if (type === "unknown") {
            return Object.values(burnAccounts.unknownBurnAccounts)
        } else {
            return burnAccounts.derivedBurnAccounts
        }
    }

    // you should do this on every accountChanged event other wise BurnWallet.defaultSigner will cause "connect account" popup
    // this is because some wallets return the current selected account with (await this.viemWallet.getAddresses())[0]
    // but some don't. So defaultSigner detects that by doing this.viemWallet.account?.address !== (await this.viemWallet.getAddresses())[0]
    // then forces the user to tell it directly with a popup.
    changeViemWallet(newWallet: WalletClient) {
        if (newWallet.account === undefined) {
            throw new Error(`viem wallet not created with account set. pls do: 
            const wallet = createWalletClient({
                account, // <-- this sets viemWallet.account
                chain: mainnet,
                transport: custom(window.ethereum),
            });
            `)
        }
        this.viemWallet = newWallet;
        this.burnViewKeyManager.viemWallet = newWallet;
    }

    async defaultSigner() {
        const staticAccount = this.viemWallet.account?.address as Address
        return staticAccount
    }

    async #getMerkleTree(address: Address, chainId?: number) {
        chainId ??= await this.viemWallet.getChainId()
        const chainIdHex = toHex(chainId)
        this.merkleTrees[chainIdHex] ??= {}
        if (this.merkleTrees[chainIdHex][address] === undefined) {
            const contractConfig = await this.#getContractConfig(address, chainId)
            const deploymentBlock = contractConfig.DEPLOYMENT_BLOCK
            this.merkleTrees[chainIdHex][address] = { firstSyncedBlock: deploymentBlock, lastSyncedBlock: deploymentBlock, tree: new LeanIMT(poseidon2IMTHashFunc) }
        }
        return this.merkleTrees[chainIdHex][address]
    }

    // TODO use this every where
    async #setMerkleTree(merkleTree: PreSyncedTree, address: Address, chainId?: number) {
        chainId ??= await this.viemWallet.getChainId()
        const chainIdHex = toHex(chainId)
        this.merkleTrees[chainIdHex] ??= {}
        this.merkleTrees[chainIdHex][address] = merkleTree
    }

    exportMerkleTrees() {
        const exportedTree: { [chainId: Hex]: { [address: Address]: PreSyncedTreeStringifyable } } = {};
        for (const chainId of Object.keys(this.merkleTrees)) {
            exportedTree[chainId as Hex] = {}
            for (const address of Object.keys(this.merkleTrees[chainId as Hex])) {
                const tree = this.merkleTrees[chainId as Hex][address as Address]
                exportedTree[chainId as Hex][address as Address] = {
                    firstSyncedBlock: toHex(tree.firstSyncedBlock),
                    lastSyncedBlock: toHex(tree.lastSyncedBlock),
                    exportedNodes: tree.tree.export()
                }
            }
        }
        return exportedTree
    }

    async getContractConfig(address: Address, chainId?: number) {
        return await this.#getContractConfig(address, chainId)
    }

    async #getContractConfig(address: Address, chainId?: number) {
        address = getAddress(address)
        chainId ??= await this.viemWallet.getChainId()
        const chainIdHex = toHex(chainId)
        this.contractConfig[chainIdHex] ??= {}
        if (this.contractConfig[chainIdHex][address] === undefined) {
            this.contractConfig[chainIdHex][address] = await getContractConfig(
                address,
                await this.#getPublicClient({ type: "full", chainId: chainId })
            );
        }
        return this.contractConfig[chainIdHex][address]
    }
    // uses wallet object to return chainId
    async #getPublicClient({ type = "archive", chainId }: { type?: "archive" | "full", chainId?: number } = {}): Promise<PublicClient> {
        const wasChainIdSet = Boolean(chainId)
        chainId ??= await this.viemWallet.getChainId()
        let client: PublicClient
        if (type === "archive") {
            client = this.archiveNodes[chainId]
        } else {
            client = this.fullNodes[chainId]
        }
        if (client === undefined) {
            //throw new Error(`no client available for this chain id:${chainId}`) 
            console.warn(`no ${type} client available for this chain id:${chainId}. Using wallet client instead and assuming it can handle it!`)
            client = createPublicClient({
                chain: this.viemWallet.chain,
                transport: custom(this.viemWallet.transport),
            })
            if (wasChainIdSet && chainId !== await this.viemWallet.getChainId()) {
                throw new Error(`could not make archive client from wallet client, wallet client is not connected to this chainId`)
            }
        }
        return client
    }


    async #getTokenContract(address: Address, { chainId, wallet = false, nodeType = "archive" }: { chainId?: number, wallet?: boolean, nodeType?: "archive" | "full" } = {}): Promise<WormholeToken> {
        chainId ??= await this.viemWallet.getChainId()
        const publicClient = await this.#getPublicClient({ type: nodeType });
        const contract = getContract({
            address,
            abi: WormholeTokenArtifact.abi as WormholeToken$Type["abi"],
            client: wallet
                ? { public: publicClient, wallet: this.viemWallet }
                : { public: publicClient },
        });
        return contract as WormholeToken
    }

    async connect(walletClient?: WalletClient) {
        walletClient ??= this.viemWallet
        if (walletClient.account === undefined) throw new Error(viemAccountNotSetErr)
        this.viemWallet = walletClient
        return await this.burnViewKeyManager.connect(walletClient)
    }

    async connectPreSigned(signature: Hex, message: string, walletClient?: WalletClient) {
        walletClient ??= this.viemWallet
        if (walletClient.account === undefined) throw new Error(viemAccountNotSetErr)
        this.viemWallet = walletClient
        this.burnViewKeyManager.connectPreSigned(walletClient, signature, message)
    }



    /**
 * Creates a new burn account by deterministically deriving a viewing key and
 * PoW nonce, then deriving the corresponding burn address.
 *
 * Both the viewing key and PoW nonce are deterministically derived, enabling
 * account recovery from the internal root and counter.
 *
 * @param options - Optional configuration object.
 * @param options.ethAccount - The Ethereum account to associate the burn account with.
 *   Defaults to the first account returned by the wallet provider.
 * @param options.viewingKeyIndex - Index used for deterministic viewing key
 *   derivation. Defaults to `this.privateData.detViewKeyCounter`, which is
 *   then incremented.
 * @param options.chainId - Target chain ID. Defaults to `this.defaults.chainId`.
 *   Must be in `this.acceptedChainIds`.
 * @param options.difficulty - PoW difficulty override. Defaults to
 *   `this.defaults.powDifficulty`.
 * @param options.async - If `true`, computes the PoW nonce on a worker thread,
 *   avoiding UI freezes. Defaults to `false`.
 *
 * @returns The newly created {@link BurnAccount}, also appended to the burn accounts store.
 *
 * @throws {Error} If `chainId` is not in `this.acceptedChainIds`.
 */
    async createBurnAccount(
        tokenAddress: Address,
        { chainId, signingEthAccount, viewingKeyIndex, async = false }:
            { chainId?: number, signingEthAccount?: Address, isDeterministic?: boolean, viewingKeyIndex?: number, async?: boolean } = {}
    ) {
        [signingEthAccount, chainId] = await Promise.all([
            signingEthAccount ?? this.defaultSigner(),
            chainId ?? this.viemWallet.getChainId(),
        ])
        const contractConfig = await this.#getContractConfig(tokenAddress, chainId)
        return this.burnViewKeyManager.createBurnAccount(
            chainId,
            contractConfig.POW_DIFFICULTY,
            {
                signingEthAccount,
                viewingKeyIndex,
                async,
            })
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
        tokenAddress: Address, amountOfBurnAccounts: number,
        { signingEthAccount, startingViewKeyIndex, chainId, async = false }:
            { signingEthAccount?: Address, startingViewKeyIndex?: number, async?: boolean, chainId?: number } = {}
    ) {
        [signingEthAccount, chainId] = await Promise.all([
            signingEthAccount ?? this.defaultSigner(),
            chainId ?? this.viemWallet.getChainId(),
        ])
        const contractConfig = await this.#getContractConfig(tokenAddress, chainId)
        return this.burnViewKeyManager.createBurnAccountsBulk(
            amountOfBurnAccounts,
            chainId,
            contractConfig.POW_DIFFICULTY,
            { signingEthAccount, startingViewKeyIndex, async }
        )
    }



    // TODO make optional that viewKeys have to be exported. Probably just ban unknown derivation accounts
    exportWallet({ paranoidMode = false, merkleTree = true, viewKeyData = true }: { paranoidMode?: boolean, merkleTree?: boolean, viewKeyData?: boolean } = {}) {
        return JSON.stringify({
            privateData: viewKeyData ? this.burnViewKeyManager.exportViewKeyData(paranoidMode) : undefined,
            merkleTree: merkleTree ? this.exportMerkleTrees() : undefined,
        }, null, 2)
    }

    // TODO assumes imported tree is most up to date
    importMerkleTrees(importedTrees: ExportedMerkleTrees) {
        const parsedTrees = ExportedMerkleTreesSchema.parse(importedTrees)
        for (const chainId of Object.keys(parsedTrees)) {
            for (const address of Object.keys(parsedTrees[chainId])) {
                const parsedTree = parsedTrees[chainId][address]
                const recoveredTree = LeanIMT.import(poseidon2IMTHashFunc, parsedTree.exportedNodes)
                this.merkleTrees[chainId as Hex] ??= {}
                this.merkleTrees[chainId as Hex][address as Address] = {
                    firstSyncedBlock: BigInt(parsedTree.firstSyncedBlock),
                    lastSyncedBlock: BigInt(parsedTree.lastSyncedBlock),
                    tree: recoveredTree
                }
            }
        }
    }

    /**
     * Imports wallet data from a JSON string, optionally restoring the Merkle tree
     * and/or view key data.
     *
     * @param json - Stringified wallet export produced by {@link exportWallet}.
     * @param wormholeTokenContract - The Wormhole token contract instance, used to sync view key data.
     * @param archiveNode - Archive node client, used to sync view key data.
     * @param options 
     * @param options.merkleTree - Whether to import the Merkle tree. Defaults to `true`.
     * @param options.viewKeyData - Whether to import the view key data. Defaults to `true`.
     */
    async importWallet(
        json: string,
        tokenAddress: Address,
        { fullSync = true, syncTillBlock, concurrency = 10, merkleTrees = true, onlyImportSigner = false, viewKeyData = true, forceReHashViewKey = true, forceReSign = false, forcePow = false, chainId, onlySignInWith, onAccountImported }: { fullSync?: boolean, syncTillBlock?: bigint, concurrency?: number, onlyImportSigner?: boolean, forceReHashViewKey?: boolean, forceReSign?: boolean, forcePow?: boolean, merkleTrees?: boolean, viewKeyData?: boolean, chainId?: number, onlySignInWith?: Address, onAccountImported?: () => void } = {}
    ) {
        if (onlyImportSigner && onlySignInWith) { throw new Error(`please set onlyImportSigner:false when specifying onlySignInWith,  ex: BurnWaller.importWallet(json, ${tokenAddress}, {onlyImportSigner:false, onlySignInWith:[${onlySignInWith.toString()}]), ...yourOtherOptions}`) }
        if (onlyImportSigner) {
            onlySignInWith = await this.defaultSigner();
        }
        const parsed = JSON.parse(json) as { merkleTrees: ExportedMerkleTrees, privateData: ExportedViewKeyData }
        const archiveNode = await this.#getPublicClient({ type: "archive", chainId })
        const fullNode = await this.#getPublicClient({ type: "full", chainId })
        if (parsed.merkleTrees && merkleTrees) {
            // TODO imported tree is assumed to be more upto date here
            this.importMerkleTrees(parsed.merkleTrees)
        }

        if (parsed.privateData && viewKeyData) {
            await this.burnViewKeyManager.importViewKeyWalletData(parsed.privateData, tokenAddress, archiveNode, { fullSync, syncTillBlock, concurrency, fullNode, forceReSign, forceReHashViewKey, forcePow, onlySignInWith, onAccountImported })
        }
    }

    async getTokenPrice(token: Address, { chainId }: { chainId?: number } = {}): Promise<Hex> {
        //https://claude.ai/chat/14f414da-d400-4a37-ad68-1bb11894bc83
        chainId ??= await this.viemWallet.getChainId()
        throw Error(`TODO implements this! \n Could not find a price on uniswap v2,v3 or v4 on token ${token} on chainId:${chainId}. Please manually provide the eth price`)
    }

    async #getGasCost(circuitSize: number, token: Address, { chainId, type = "relayer" }: { chainId?: number, type?: "relayer" } = {}) {
        chainId ??= await this.viemWallet.getChainId()
        if (type === "relayer") {
            if (
                toHex(chainId) in RE_MINT_RELAYER_GAS &&
                token in RE_MINT_RELAYER_GAS[toHex(chainId)] &&
                circuitSize in RE_MINT_RELAYER_GAS[toHex(chainId)][token]
            ) {
                return RE_MINT_RELAYER_GAS[toHex(chainId)][token][circuitSize]
            } else {
                console.warn(`token: ${token} chainId: ${toHex(chainId)} with circuit size: ${circuitSize}. \n not found, defaulting to reference implementation gas estimation on ethereum L1`)
            }
        }
    }


    async getBlockNumber(chainId:number) {
        return await (await this.#getPublicClient({type:"full", chainId})).getBlockNumber()
    }

    /** Not async so callers can destructure individual promises without awaiting everything.
     *  `await .sync()` still works — resolves all fields.
     *  @example
     *  // simple — await everything at once
     *  const { syncedTree, syncedBurnAccounts } = await burnWallet.sync(tokenAddress)
     *  @example
     *  // advanced — await accounts first, then tree later
     *  const { syncedTree, syncedBurnAccounts } = burnWallet.sync(tokenAddress)
     *  await syncedBurnAccounts
     *  const selection = await burnWallet.selectBurnAccountsForSpend(...)
     *  const signed = await burnWallet.signReMint(...)
     *  await syncedTree // wait for tree only when needed for proving
     *  const proof = await burnWallet.proof(signed, ...) */
    sync(
        tokenAddress: Address,
        { concurrency = 10, syncTillBlock, chainId, deploymentBlock, blocksPerGetLogsReq, burnAddressesToSync, signingEthAccount, maxNonce }:
            { concurrency?: number, syncTillBlock?: bigint, chainId?: number, deploymentBlock?: bigint, blocksPerGetLogsReq?: bigint, burnAddressesToSync?: Address[], signingEthAccount?: Address, maxNonce?: bigint } = {}
    ) {
        const syncedTillBlock = syncTillBlock
            ? Promise.resolve(syncTillBlock)
            : this.getBlockNumber(chainId!)

        const syncedTree = syncedTillBlock.then(block => this.syncTree(tokenAddress, { syncTillBlock: block, chainId, deploymentBlock, blocksPerGetLogsReq }))
        const syncedBurnAccounts = syncedTillBlock.then(block => this.syncBurnAccounts(tokenAddress, { concurrency, syncTillBlock: block, chainId, burnAddressesToSync, signingEthAccount, maxNonce }))

        const all = Promise.all([syncedTree, syncedBurnAccounts, syncedTillBlock])
            .then(([tree, accounts, block]) => ({ syncedTree: tree, syncedBurnAccounts: accounts, syncedTillBlock: block }))

        return Object.assign(all, { syncedTree, syncedBurnAccounts, syncedTillBlock })
    }

    async syncTree(tokenAddress: Address, { chainId, deploymentBlock, blocksPerGetLogsReq, syncTillBlock }: { syncTillBlock?: bigint, chainId?: number, deploymentBlock?: bigint, blocksPerGetLogsReq?: bigint } = {}) {
        [chainId, syncTillBlock] = await Promise.all([
            chainId ?? this.viemWallet.getChainId(),
            syncTillBlock ?? await (await this.#getPublicClient({ type: "full", chainId })).getBlockNumber()
        ])
        const [archiveNode, fullNode, preSyncedTree] = await Promise.all([
            this.#getPublicClient({ type: "archive", chainId }),
            this.#getPublicClient({ type: "full", chainId }),
            this.#getMerkleTree(tokenAddress, chainId),
        ])
        const syncedTree = await getSyncedMerkleTree(tokenAddress, archiveNode, { syncTillBlock, fullNode, preSyncedTree, deploymentBlock, blocksPerGetLogsReq })
        this.#setMerkleTree(syncedTree, tokenAddress, chainId)
        return syncedTree
    }

    async syncBurnAccounts(tokenAddress: Address, { concurrency = 10, chainId, burnAddressesToSync, signingEthAccount, maxNonce, syncTillBlock, onAccountSynced }: { concurrency?: number, syncTillBlock?: bigint, chainId?: number, burnAddressesToSync?: Address[], signingEthAccount?: Address, maxNonce?: bigint, onAccountSynced?: (burnAccount: BurnAccount) => void } = {}) {
        [chainId, signingEthAccount, syncTillBlock] = await Promise.all([
            chainId ?? this.viemWallet.getChainId(),
            signingEthAccount ?? this.defaultSigner(),
            syncTillBlock ?? await (await this.#getPublicClient({ type: "full", chainId })).getBlockNumber()
        ])
        const archiveNode = await this.#getPublicClient({ type: "archive", chainId })
        const syncedBurnAccountData = await syncMultipleBurnAccounts(this.burnViewKeyManager, tokenAddress, archiveNode, { concurrency, syncTillBlock, burnAddressesToSync, maxNonce, ethAccounts: [signingEthAccount], chainId: toHex(chainId), onAccountSynced })
        return syncedBurnAccountData
    }

    /**
     * @TODO research how much data the timing of the root reveals as public input
     * proof time is faster usually then one block so it seems limited. And the root only updates on transfers and reMints
     * Patching it would mean you would always proof against a slightly stale root.
     * This has some challenges like rolling back then PreSyncedMerkleTree to a root that existed at or before a specific timestamp
     * But the hardest problem is un-syncing the burn accounts. You would have to go back to timestamp of that root (*not* the targeted timestamp,
     * but the timestamp of the root since that contains the state).
     * Going back to that timestamp would require you to scan for events until then en deducted that from the BurnedBalance. 
     * But if a nullifier happened then you would just have to wait until it lines up. Or ignore that account?
     * 
     * maybe just adding a couple seconds of sleep is easier and good enough.
     * 
     * maybe it's not just privacy but also bug. 
     * technically during account sync one account can receive tokens but then the merkle tree does not have that update.
     * Since accountSync syncs by reading contract state, thus every lookup is at latest block. So one read can happen on block n and another on n+1
     * But the tree is correctly synced till exactly block x. 
     * 
     * 
     * @param tokenAddress 
     * @param amount 
     * @param param2 
     * @returns 
     */
    async selectBurnAccountsForSpend(
        tokenAddress: Address, amount: bigint,
        { chainId, signingEthAccount, burnAccountSelector = selectSmallFirst, circuitSize, burnAddresses }:
            { chainId?: number, signingEthAccount?: Address, burnAccountSelector?: BurnAccountSelector, circuitSize?: number, burnAddresses?: Address[] } = {}
    ): Promise<BurnAccountSelectionForSpend> {
        [chainId, signingEthAccount] = await Promise.all([
            chainId ?? this.viemWallet.getChainId(),
            signingEthAccount ?? this.defaultSigner(),
        ])
        const contractConfig = await this.#getContractConfig(tokenAddress, chainId)
        const burnAccountsAndAmounts = await selectBurnAccountsForClaim(
            amount, burnAccountSelector, this.burnViewKeyManager, tokenAddress, signingEthAccount,
            BigInt(chainId), contractConfig.ACCEPTED_CHAIN_IDS, contractConfig.POW_DIFFICULTY,
            contractConfig.VERIFIER_SIZES, circuitSize, burnAddresses,
        )
        return { tokenAddress, amount, burnAccountsAndAmounts }
    }

    async signReMint(
        recipient: Address, burnAccountSelectionForSpend: BurnAccountSelectionForSpend,
        { chainId, signingEthAccount, circuitSize, encryptedBlobLen = ENCRYPTED_TOTAL_MINTED_PADDING + EAS_BYTE_LEN_OVERHEAD, callData = "0x", callValue = 0n, callCanFail = false, feeData }:
            { chainId?: number, signingEthAccount?: Address, circuitSize?: number, encryptedBlobLen?: number, callData?: Hex, callValue?: bigint, callCanFail?: boolean, feeData?: FeeData } = {}
    ): Promise<SignedProofInputs> {
        const { amount, tokenAddress, burnAccountsAndAmounts } = burnAccountSelectionForSpend;
        [chainId, signingEthAccount] = await Promise.all([
            chainId ?? this.viemWallet.getChainId(),
            signingEthAccount ?? this.defaultSigner(),
        ])
        const contractConfig = await this.#getContractConfig(tokenAddress, chainId)
        circuitSize ??= getCircuitSize(burnAccountsAndAmounts.length, contractConfig.VERIFIER_SIZES)
        const { signatureInputs, signature } = await signAndEncrypt(
            recipient, amount, signingEthAccount,
            this.burnViewKeyManager, burnAccountsAndAmounts,
            circuitSize, encryptedBlobLen, BigInt(chainId),
            callData, callValue, callCanFail,
            tokenAddress,
            contractConfig.EIP712_NAME,
            contractConfig.EIP712_VERSION,
            feeData,
        )
        return {
            signature: { signatureHash: signature.signatureHash, signatureData: signature.signatureData, signatureInputs },
            burnAccountSelectionForSpend,
        }
    }

    async proof(
        signedProofInputs: SignedProofInputs,
        opts: { chainId?: number, syncedTree?: PreSyncedTree, circuitSize?: number, feeData: FeeData, backends?: BackendPerSize, threads?: number }
    ): Promise<RelayInputs>;
    async proof(
        signedProofInputs: SignedProofInputs,
        opts?: { chainId?: number, syncedTree?: PreSyncedTree, circuitSize?: number, feeData?: undefined, backends?: BackendPerSize, threads?: number }
    ): Promise<SelfRelayInputs>;
    async proof(
        signedProofInputs: SignedProofInputs,
        { chainId, syncedTree, circuitSize, feeData, backends, threads }:
            { chainId?: number, syncedTree?: PreSyncedTree, circuitSize?: number, feeData?: FeeData, backends?: BackendPerSize, threads?: number } = {}
    ) {
        const { signature: { signatureHash, signatureData, signatureInputs }, burnAccountSelectionForSpend: { amount, tokenAddress, burnAccountsAndAmounts } } = signedProofInputs
        chainId ??= await this.viemWallet.getChainId()
        const contractConfig = await this.#getContractConfig(tokenAddress, chainId)
        circuitSize ??= getCircuitSize(burnAccountsAndAmounts.length, contractConfig.VERIFIER_SIZES)
        syncedTree ??= await this.#getMerkleTree(tokenAddress, chainId)
        return await hashAndProof(
            amount, burnAccountsAndAmounts,
            signatureHash, signatureData, signatureInputs,
            tokenAddress, syncedTree, BigInt(chainId),
            contractConfig.POW_DIFFICULTY, contractConfig.RE_MINT_LIMIT,
            circuitSize, contractConfig.VERIFIER_SIZES, Number(contractConfig.MAX_TREE_DEPTH),
            feeData, backends, threads,
        )
    }

    // TODO cache proof backend
    async easyProof(
        tokenAddress: Address, recipient: Address, amount: bigint,
        opts: Omit<CreateRelayerInputsOpts, "fullNode" | "powDifficulty" | "maxTreeDepth" | "chainId" | "circuitSizes" | "preSyncedTree" | "feeData"> & { signingEthAccount?: Address, chainId?: number, feeData: FeeData }
    ): Promise<RelayInputs>;
    async easyProof(
        tokenAddress: Address, recipient: Address, amount: bigint,
        opts?: Omit<CreateRelayerInputsOpts, "fullNode" | "powDifficulty" | "maxTreeDepth" | "chainId" | "circuitSizes" | "preSyncedTree" | "feeData"> & { signingEthAccount?: Address, chainId?: number, feeData?: undefined }
    ): Promise<SelfRelayInputs>;
    async easyProof(
        tokenAddress: Address, recipient: Address, amount: bigint,
        opts: Omit<CreateRelayerInputsOpts, "fullNode" | "powDifficulty" | "maxTreeDepth" | "chainId" | "circuitSizes" | "preSyncedTree" | "feeData" > & { signingEthAccount?: Address, chainId?: number, feeData?: FeeDataOptionals } = {}
    ) {
        const signingEthAccount = opts.signingEthAccount ? opts.signingEthAccount : await this.defaultSigner()
        delete opts.signingEthAccount
        const chainId = opts.chainId ?? await this.viemWallet.getChainId()
        opts.syncTillBlock ??= await this.getBlockNumber(chainId)

        const [contractConfig, archiveNode, fullNode, preSyncedTree] = await Promise.all([
            this.#getContractConfig(tokenAddress, chainId),
            this.#getPublicClient({ type: "archive" }),
            this.#getPublicClient({ type: "full" }),
            this.#getMerkleTree(tokenAddress, chainId),
        ])

        if (opts.feeData !== undefined) {
            // TODO below can only be set once circuit size is known.
            // createRelayerInputs needs to be split up. But also be called concurrently so merkle tree can sync
            // syncMerkle tree -----------------------------------------------> \/
            // syncBurnAccounts -> selectBurnAccounts -> signPrivateTransfer -> make proof
            // after selectBurnAccounts, circuit size is known. This also allows ui opportunities for the user to select a different size or selection strategy
            //opts.feeData.estimatedGasCost ??= await this.#getGasCost()
            opts.feeData.estimatedPriorityFee ??= toHex((await fullNode.estimateFeesPerGas()).maxPriorityFeePerGas)
            opts.feeData.tokensPerEthPrice ??= await this.getTokenPrice(tokenAddress, { chainId })
        }
        const optsWithDefaults: CreateRelayerInputsOpts = {
            ...opts,
            fullNode,

            //-- cached --
            preSyncedTree,
            chainId: BigInt(chainId),

            // contractConfig
            powDifficulty: contractConfig.POW_DIFFICULTY,
            reMintLimit: contractConfig.RE_MINT_LIMIT,
            circuitSizes: contractConfig.VERIFIER_SIZES,
            maxTreeDepth: Number(contractConfig.MAX_TREE_DEPTH),
            eip712Name: contractConfig.EIP712_NAME,
            eip712Version: contractConfig.EIP712_VERSION,
            allowedChainIds: contractConfig.ACCEPTED_CHAIN_IDS
            //-----------
        }
        const { syncedData, relayInputs } = await createRelayerInputs(
            recipient, amount, this.burnViewKeyManager, tokenAddress, archiveNode, signingEthAccount,
            optsWithDefaults
        )
        this.#setMerkleTree(syncedData.syncedTree, tokenAddress, chainId)
        // TODO afaik we don't have to do this? Double check that.
        // In general i think createRelayerInputs should not sync anything? Maybe check the nonce is up to data for sure tho. Also this.easyProof should sync by default, but also be able to proof on a stale root but we need to check the burn accounts used if the can do that.
        //this.burnViewKeyManager = syncedData.syncedPrivateWallet
        return relayInputs
    }

    /**
     * relays reMint tx, does *not* earn fee
     * @param selfRelayInputs 
     */
    async selfRelayTx(selfRelayInputs: SelfRelayInputs) {
        return await selfRelayTx(selfRelayInputs, this.viemWallet)
    }

    /**
     * relays reMint tx, *does* earn fee
     * @param selfRelayInputs 
     */
    async relayTx(relayInputs: RelayInputs) {
        return await relayTx(relayInputs, this.viemWallet)
    }

    /**
     * for when you just want to burn without thinking about it
     * or when you need to receive some change for relayer fees, without revealing who you are.
     * @notice this.burnViewKeyManager.getFreshBurnAccount checks if it's fresh by checking the balance, but only on one chain and balance of one coin. It is not fool proof. Maybe we need derivation path for one time use addresses
     * @param tokenAddress 
     * @param signingEthAccount
     * @param param2
     * @returns
     */
    async getFreshBurnAccount(tokenAddress: Address, { signingEthAccount, chainId }: { signingEthAccount?: Address, chainId?: number } = {}) {
        [signingEthAccount, chainId] = await Promise.all([
            signingEthAccount ?? this.defaultSigner(),
            chainId ?? this.viemWallet.getChainId(),
        ])
        return await this.burnViewKeyManager.getFreshBurnAccount(
            tokenAddress,
            await this.#getPublicClient({ type: "full", chainId: chainId }),
            (await this.#getContractConfig(tokenAddress, chainId)).POW_DIFFICULTY,
            { chainId: chainId }
        )
    }

    // TODO part of this is might need to go into viewKeyManager
    /**
     * 
     */
    async #resolveBurnAccount(burnAddress: Address, tokenAddress: Address, chainId: number): Promise<BurnAccount> {
        // if ("viewingKey" in burnAccount) return burnAccount as BurnAccount;
        // const { burnAddress } = burnAccount
        const difficulty = BigInt((await this.#getContractConfig(tokenAddress, chainId)).POW_DIFFICULTY)
        const allBurnAccounts = getAllBurnAccounts(
            this.burnViewKeyManager.privateData,
            {
                difficulties: [difficulty],
                chainIds: [BigInt(chainId)],
                ethAccounts: undefined
            }
        )
        const foundBurnAccount = allBurnAccounts.find((b) => b.burnAddress === getAddress(burnAddress))
        if (!foundBurnAccount) throw new Error(`BurnAddress:${burnAddress} not in wallet, please provide the full burnAccount or use a regular transfer if you know what you are doing.`)
        return foundBurnAccount
    }

    /**
     * @notice if no burnAccount or burnAddress provided, will make a freshAccount for extra privacy
     * @TODO cache difficulty,circuitSizes,reMintLimit,maxTreeDepth per contract address and other contract parameters
     * @TODO do chain assertions. Every time contract.write.function(args[],{account,chain}).  
     * use const chainId = viemWallet.chain?.id !== undefined ? BigInt(viemWallet.chain.id) : BigInt(await viemWallet.getChainId())
     * to check if it's a valid chainId to send to / make proofs on (so do the other function as well!!)
     * @TODO 
     */
    async superSafeBurn(
        tokenAddress: Address, amount: bigint, burnAccount?: BurnAccount | { burnAddress: Address },
        { chainId, signingEthAccount }: { chainId?: number, signingEthAccount?: Address } = {}
    ) {
        chainId ??= await this.viemWallet.getChainId()
        burnAccount ??= await this.getFreshBurnAccount(tokenAddress, { signingEthAccount, chainId })

        const [fullBurnAccount, contractConfig, fullNode] = await Promise.all([
            // makes sure to retrieve a full burnAccount from viewKey manager, if only {burnAddress} is present
            ("viewingKey" in burnAccount) ? burnAccount : this.#resolveBurnAccount(burnAccount.burnAddress, tokenAddress, chainId),
            this.#getContractConfig(tokenAddress, chainId),
            this.#getPublicClient({ type: "full" }),
        ])
        signingEthAccount ??= await this.defaultSigner()

        return await superSafeBurn(fullBurnAccount, amount, tokenAddress, this.viemWallet, fullNode, signingEthAccount, {
            difficulty: BigInt(contractConfig.POW_DIFFICULTY),
            reMintLimit: BigInt(contractConfig.RE_MINT_LIMIT),
            maxTreeDepth: Number(contractConfig.MAX_TREE_DEPTH),
            acceptedChainIds: contractConfig.ACCEPTED_CHAIN_IDS
        })
    }

    async superSafeBurnBulk(
        tokenAddress: Address, recipientsAndAmounts: { burnAccount: BurnAccount | { burnAddress: Address }, amount: bigint }[],
        { chainId, signingEthAccount }: { chainId?: number, signingEthAccount?: Address } = {}
    ) {
        chainId ??= await this.viemWallet.getChainId()

        const [contractConfig, fullNode, ...fullBurnAccounts] = await Promise.all([
            this.#getContractConfig(tokenAddress, chainId),
            this.#getPublicClient({ type: "full" }),
            ...recipientsAndAmounts.map((item) =>
                ("viewingKey" in item.burnAccount) ? item.burnAccount : this.#resolveBurnAccount(item.burnAccount.burnAddress, tokenAddress, chainId)
            ),
        ])
        signingEthAccount ??= await this.defaultSigner()

        const resolvedItems = recipientsAndAmounts.map((item, i) => ({
            burnAccount: fullBurnAccounts[i] as BurnAccount,
            amount: item.amount,
        }))

        return await superSafeBurnBulk(resolvedItems, tokenAddress, this.viemWallet, fullNode, signingEthAccount, {
            difficulty: BigInt(contractConfig.POW_DIFFICULTY),
            reMintLimit: BigInt(contractConfig.RE_MINT_LIMIT),
            maxTreeDepth: Number(contractConfig.MAX_TREE_DEPTH),
            acceptedChainIds: contractConfig.ACCEPTED_CHAIN_IDS
        })
    }
}