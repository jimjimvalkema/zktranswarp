// PrivateWallet is a wrapper that exposes some of viem's WalletClient functions and requires them to only ever use one ethAccount

import type { Address, Hex, PublicClient, WalletClient } from "viem";
import { createPublicClient, custom, getAddress, getContract, padHex, toHex } from "viem";
import type { BurnAccount, PreSyncedTreeStringifyable, PreSyncedTree, ExportedViewKeyData, WormholeToken, SelfRelayInputs, RelayInputs, CreateRelayerInputsOpts, FeeData, ClientPerChainId, WormholeContractConfig } from "./types.ts"
import { VIEWING_KEY_SIG_MESSAGE } from "./constants.ts";
import { BurnViewKeyManager } from "./BurnViewKeyManager.ts";
import { LeanIMT } from "@zk-kit/lean-imt";
import { poseidon2IMTHashFunc } from "./syncing.ts";
import { ExportedMerkleTreesSchema, PreSyncedTreeStringifyableSchema, type ExportedMerkleTrees } from "./schemas.ts";
import { burn, relayTx, selfRelayTx, superSafeBurn } from "./transact.ts";
import type { WormholeToken$Type } from "../artifacts/contracts/WormholeToken.sol/artifacts.ts"
import WormholeTokenArtifact from '../artifacts/contracts/WormholeToken.sol/WormholeToken.json' with {"type": "json"};
import { createRelayerInputs } from "./proving.ts";
import { getAcceptedChainIdFromContract, getAllBurnAccounts, getCircuitSizesFromContract, getWormholeTokenContract } from "./utils.ts";
//import { findPoWNonceAsync } from "./hashingAsync.js";


export class BurnWallet {
    readonly burnViewKeyManager: BurnViewKeyManager
    viemWallet: WalletClient;
    readonly archiveNodes: ClientPerChainId;
    readonly fullNodes: ClientPerChainId
    readonly contractConfig: { [chainId: Hex]: { [Address: Address]: WormholeContractConfig } } = {};
    merkleTrees: { [chainId: Hex]: { [Address: Address]: PreSyncedTree } } = {};

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
        { powDifficulty, archiveNodes, fullNodes, merkleTrees, viewKeySigMessage = VIEWING_KEY_SIG_MESSAGE, acceptedChainIds = [1], chainId }:
            { powDifficulty?: bigint, archiveNodes?: ClientPerChainId, fullNodes?: ClientPerChainId, merkleTrees?: { [chainId: Hex]: { [Address: Address]: PreSyncedTree } }, walletDataImport?: string, viewKeySigMessage?: string, acceptedChainIds?: number[], chainId?: number } = {}
    ) {
        if (viemWallet.account === undefined) {
            throw new Error(`viem wallet not created with account set. pls do: 
            const wallet = createWalletClient({
                account, // <-- this sets viemWallet.account
                chain: mainnet,
                transport: custom(window.ethereum),
            });
            `)
        }
        this.viemWallet = viemWallet;
        this.archiveNodes = archiveNodes ?? fullNodes ?? {};
        this.fullNodes = fullNodes ?? archiveNodes ?? {};
        // TODO firstSyncedBlock;0n might create issues since it should be the deployment block of the contract
        this.merkleTrees = merkleTrees ?? this.merkleTrees
        this.burnViewKeyManager = new BurnViewKeyManager(
            viemWallet,
            {
                viewKeySigMessage, acceptedChainIds, chainId
            }
        )
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
        // await this.viemWallet.getAddresses())[0] is unreliable, in metamask it returns currently selected account
        // but in walletconnect (TODO check) and hardhat it just gives the array in original order
        // const dynamicAccount = (await this.viemWallet.getAddresses())[0]

        // if (staticAccount && (getAddress(staticAccount) !== getAddress(dynamicAccount))) {
        //     const requestedAccount = (await this.viemWallet.requestAddresses())[0]
        //     return requestedAccount
        // }
        // else {
        //     return dynamicAccount
        // }
    }

    async #getMerkleTree(address: Address, chainId?: number) {
        chainId ??= await this.viemWallet.getChainId()
        const chainIdHex = toHex(chainId)
        this.merkleTrees[chainIdHex] ??= {}
        // TODO firstSyncedBlock at 0 might give issues
        console.warn("firstSyncedBlock is set at 0, this might cause issues?? TODO")
        this.merkleTrees[chainIdHex][address] ??= { firstSyncedBlock: 0n, lastSyncedBlock: 0n, tree: new LeanIMT(poseidon2IMTHashFunc) }
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
        const wormholeTokenFull = await this.#getTokenContract(address, { chainId, wallet: false, nodeType: "full" })
        if (this.contractConfig[chainIdHex][address] === undefined) {
            const powDifficulty = wormholeTokenFull.read.POW_DIFFICULTY()
            const reMintLimit = wormholeTokenFull.read.RE_MINT_LIMIT();
            const maxTreeDepth = wormholeTokenFull.read.MAX_TREE_DEPTH();
            const isCrossChain = wormholeTokenFull.read.IS_CROSS_CHAIN()

            const verifierSizes = getCircuitSizesFromContract(wormholeTokenFull);
            const acceptedChainIds = getAcceptedChainIdFromContract(wormholeTokenFull)
            const verifiersEntries = Promise.all((await verifierSizes).map(async (size, index) => [size, await wormholeTokenFull.read.VERIFIERS_PER_SIZE([size])]))
            const eip712Domain = wormholeTokenFull.read.eip712Domain()

            const config: WormholeContractConfig = {
                VERIFIER_SIZES: await verifierSizes,
                VERIFIERS_PER_SIZE: Object.fromEntries(await verifiersEntries),
                POW_DIFFICULTY: padHex(await powDifficulty, { size: 32 }),
                RE_MINT_LIMIT: await reMintLimit,
                MAX_TREE_DEPTH: await maxTreeDepth,
                IS_CROSS_CHAIN: await isCrossChain,
                ACCEPTED_CHAIN_IDS: (await acceptedChainIds).map((id)=>toHex(id)),
                EIP712_NAME: (await eip712Domain)[1],
                EIP712_VERSION: (await eip712Domain)[2],
            }
            this.contractConfig[chainIdHex][address] = config;
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

    async connect(ethAccount?: Address) {
        ethAccount ??= await this.defaultSigner()
        return await this.burnViewKeyManager.connect(ethAccount)
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
        signingEthAccount ??= await this.defaultSigner()
        chainId ??= await this.viemWallet.getChainId()
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
        signingEthAccount ??= await this.defaultSigner()
        chainId ??= await this.viemWallet.getChainId()
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
        { merkleTrees = true, viewKeyData = true, forceReSign = true, forcePow = false, chainId }: { forceReSign?: boolean, forcePow?: boolean, merkleTrees?: boolean, viewKeyData?: boolean, chainId?: number } = {}
    ) {
        const parsed = JSON.parse(json) as { merkleTrees: ExportedMerkleTrees, privateData: ExportedViewKeyData }
        const archiveNode = await this.#getPublicClient({ type: "archive", chainId })
        const fullNode = await this.#getPublicClient({ type: "full", chainId })
        if (parsed.merkleTrees && merkleTrees) {
            // TODO imported tree is assumed to be more upto date here
            this.importMerkleTrees(parsed.merkleTrees)
        }

        if (parsed.privateData && viewKeyData) {
            await this.burnViewKeyManager.importViewKeyWalletData(parsed.privateData, tokenAddress, archiveNode, { fullNode, forceReSign, forcePow })
        }
    }

    // TODO cache proof backend
    async proofReMint(
        recipient: Address, amount: bigint, tokenAddress: Address,
        opts: Omit<CreateRelayerInputsOpts, "fullNode" | "powDifficulty" | "maxTreeDepth" | "chainId" | "circuitSizes" | "preSyncedTree"> & { signingEthAccount?: Address, chainId?: number, feeData: FeeData }
    ): Promise<RelayInputs>;
    async proofReMint(
        recipient: Address, amount: bigint, tokenAddress: Address,
        opts?: Omit<CreateRelayerInputsOpts, "fullNode" | "powDifficulty" | "maxTreeDepth" | "chainId" | "circuitSizes" | "preSyncedTree"> & { signingEthAccount?: Address, chainId?: number, feeData?: undefined }
    ): Promise<SelfRelayInputs>;
    async proofReMint(
        recipient: Address, amount: bigint, tokenAddress: Address,
        opts: Omit<CreateRelayerInputsOpts, "fullNode" | "powDifficulty" | "maxTreeDepth" | "chainId" | "circuitSizes" | "preSyncedTree"> & { signingEthAccount?: Address, chainId?: number, feeData?: FeeData } = {}
    ) {
        const signingEthAccount = opts.signingEthAccount ? opts.signingEthAccount : await this.defaultSigner()
        delete opts.signingEthAccount
        const chainId = opts.chainId ?? await this.viemWallet.getChainId()

        //const [contractConfig, archiveNode, fullNode, preSyncedTree] = await Promise.all([
        const contractConfig = await this.#getContractConfig(tokenAddress, chainId);
        const archiveNode = await this.#getPublicClient({ type: "archive" });
        const fullNode = await this.#getPublicClient({ type: "full" });
        const preSyncedTree = await this.#getMerkleTree(tokenAddress, chainId);
        //])
        const optsWithDefaults = {
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
            //-----------
        }
        const { syncedData, relayInputs } = await createRelayerInputs(
            recipient, amount, this.burnViewKeyManager, tokenAddress, archiveNode, signingEthAccount,
            optsWithDefaults
        )
        this.#setMerkleTree(syncedData.syncedTree, tokenAddress, chainId)
        // TODO afaik we don't have to do this? Double check that. 
        // In general i think createRelayerInputs should not sync anything? Maybe check the nonce is up to data for sure tho. Also this.proofReMint should sync by default, but also be able to proof on a stale root but we need to check the burn accounts used if the can do that.
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
        signingEthAccount ??= await this.defaultSigner()
        chainId ??= await this.viemWallet.getChainId()
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
        const foundBurnAccount = allBurnAccounts.find((b) =>b.burnAddress ===getAddress(burnAddress))
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
        amount: bigint, tokenAddress: Address, burnAccount?: BurnAccount | { burnAddress: Address },
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

        await superSafeBurn(fullBurnAccount, amount, tokenAddress, this.viemWallet, fullNode, signingEthAccount, {
            difficulty: BigInt(contractConfig.POW_DIFFICULTY),
            reMintLimit: BigInt(contractConfig.RE_MINT_LIMIT),
            maxTreeDepth: Number(contractConfig.MAX_TREE_DEPTH),
            acceptedChainIds: contractConfig.ACCEPTED_CHAIN_IDS
        })
    }
}