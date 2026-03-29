// PrivateWallet is a wrapper that exposes some of viem's WalletClient functions and requires them to only ever use one ethAccount

import type { Address, Hex, PublicClient, WalletClient } from "viem";
import { getContract, padHex, toHex } from "viem";
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
import type { WormholeTokenTest } from "../test/remint2.test.ts";
import { boolean, number } from "zod";
import { getAllBurnAccounts, getCircuitSizesFromContract, getWormholeTokenContract } from "./utils.ts";
//import { findPoWNonceAsync } from "./hashingAsync.js";


export class BurnWallet {
    readonly burnViewKeyManager: BurnViewKeyManager
    readonly viemWallet: WalletClient;
    readonly archiveNode: ClientPerChainId;
    readonly fullNode: ClientPerChainId
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
        viemWallet: WalletClient, powDifficulty: bigint, archiveNode: ClientPerChainId,
        { fullNode, merkleTrees, viewKeySigMessage = VIEWING_KEY_SIG_MESSAGE, acceptedChainIds = [1n], chainId }:
            { fullNode?: ClientPerChainId, merkleTrees?: { [chainId: Hex]: { [Address: Address]: PreSyncedTree } }, walletDataImport?: string, viewKeySigMessage?: string, powDifficulty?: bigint, acceptedChainIds?: bigint[], chainId?: bigint } = {}
    ) {
        this.viemWallet = viemWallet;
        this.archiveNode = archiveNode //?? fullNode  ?? walletAsPublicClient;
        this.fullNode = fullNode ?? archiveNode //?? walletAsPublicClient;
        // TODO firstSyncedBlock;0n might create issues since it should be the deployment block of the contract
        this.merkleTrees = merkleTrees ?? this.merkleTrees
        this.burnViewKeyManager = new BurnViewKeyManager(
            viemWallet, powDifficulty,
            {
                viewKeySigMessage, acceptedChainIds, chainId
            }
        )
    }

    async defaultSigner() {
        return (await this.viemWallet.getAddresses())[0]
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

    async #getContractConfig(address: Address, chainId?: number) {
        chainId ??= await this.viemWallet.getChainId()
        const chainIdHex = toHex(chainId)
        this.contractConfig[chainIdHex] ??= {}
        const wormholeTokenFull = await this.#getTokenContract(address, { chainId, wallet: false, nodeType: "full" })
        if (this.contractConfig[chainIdHex][address] === undefined) {
            const powDifficulty = wormholeTokenFull.read.POW_DIFFICULTY()
            const reMintLimit = wormholeTokenFull.read.RE_MINT_LIMIT();
            const maxTreeDepth = wormholeTokenFull.read.MAX_TREE_DEPTH();

            const verifierSizes = getCircuitSizesFromContract(wormholeTokenFull);
            const verifiersEntries = Promise.all((await verifierSizes).map(async (size) => [size, await wormholeTokenFull.read.VERIFIER_SIZES([BigInt(size)])]))

            const config: WormholeContractConfig = {
                VERIFIER_SIZES: await verifierSizes,
                VERIFIERS_PER_SIZE: Object.fromEntries(await verifiersEntries),
                POW_DIFFICULTY: padHex(await powDifficulty, { size: 32 }),
                RE_MINT_LIMIT: await reMintLimit,
                MAX_TREE_DEPTH: await maxTreeDepth,
            }
            this.contractConfig[chainIdHex][address] = config;
        }
        return this.contractConfig[chainIdHex][address]
    }
    // uses wallet object to return chainId
    async #getPublicClient({ type = "archive", chainId }: { type?: "archive" | "full", chainId?: number } = {}) {
        chainId ??= await this.viemWallet.getChainId()
        if (type === "archive") {
            return this.archiveNode[toHex(chainId)]
        } else {
            return this.fullNode[toHex(chainId)]
        }
    }


    async #getTokenContract(address: Address, { chainId, wallet = false, nodeType = "archive" }: { chainId?: number, wallet?: boolean, nodeType?: "archive" | "full" } = {}): Promise<WormholeToken> {
        chainId ??= await this.viemWallet.getChainId()
        const publicClient = await this.#getPublicClient({ type: nodeType });
        const contract = getContract({
            address: address,
            abi: WormholeTokenArtifact.abi as WormholeToken$Type["abi"],
            client: {
                public: publicClient,
                wallet: wallet ? this.viemWallet : undefined,
            },
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
        { ethAccount, viewingKeyIndex, chainId, difficulty, async = false }:
            { isDeterministic?: boolean, spendingPubKeyX?: Hex, ethAccount?: Address, powNonce?: bigint, viewingKey?: bigint, viewingKeyIndex?: number, chainId?: bigint, difficulty?: bigint, async?: boolean, viewKeyMessage?: string } = {}
    ) {
        return this.burnViewKeyManager.createBurnAccount({
            ethAccount,
            viewingKeyIndex,
            chainId,
            difficulty,
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
        amountOfBurnAccounts: number,
        { ethAccount, startingViewKeyIndex, chainId, difficulty, async = false }:
            { ethAccount?: Address, startingViewKeyIndex?: number, async?: boolean, chainId?: bigint, difficulty?: bigint } = {}
    ) {
        return this.burnViewKeyManager.createBurnAccountsBulk(amountOfBurnAccounts, { ethAccount, startingViewKeyIndex, chainId, difficulty, async })
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
        wormholeTokenContract: WormholeToken,
        archiveNode: PublicClient,
        { merkleTrees = true, viewKeyData = true }: { merkleTrees?: boolean, viewKeyData?: boolean } = {}
    ) {
        const parsed = JSON.parse(json) as { merkleTrees: ExportedMerkleTrees, privateData: ExportedViewKeyData }

        if (parsed.merkleTrees && merkleTrees) {
            // TODO imported tree is assumed to be more upto date here
            this.importMerkleTrees(parsed.merkleTrees)
        }

        if (parsed.privateData && viewKeyData) {
            await this.burnViewKeyManager.importViewKeyWalletData(parsed.privateData, wormholeTokenContract, archiveNode)
        }
    }

    // TODO cache proof backend
    async proofReMint(
        signingEthAccount: Address,
        recipient: Address,
        amount: bigint,
        wormholeTokenAddress: Address,
        opts: Omit<CreateRelayerInputsOpts, "fullNode" | "difficulty" | "maxTreeDepth" | "chainId"> & { chainId: number, feeData: FeeData }
    ) {
        opts.chainId ??= await this.viemWallet.getChainId()
        const contractConfig = await this.#getContractConfig(wormholeTokenAddress, opts.chainId)
        return await createRelayerInputs(
            signingEthAccount,
            recipient,
            amount,
            this.burnViewKeyManager,
            wormholeTokenAddress,
            await this.#getPublicClient({ type: "archive" }),
            {
                ...opts,
                // defaulted config
                fullNode: await this.#getPublicClient({ type: "full" }),

                //-- cached --
                preSyncedTree: await this.#getMerkleTree(wormholeTokenAddress, opts.chainId),
                chainId: BigInt(opts.chainId),

                // contractConfig
                powDifficulty: contractConfig.POW_DIFFICULTY,
                reMintLimit: contractConfig.RE_MINT_LIMIT,
                circuitSizes: contractConfig.VERIFIER_SIZES,
                maxTreeDepth: Number(contractConfig.MAX_TREE_DEPTH),
                //-----------
            }
        )
    }

    /**
     * relays reMint tx, does *not* earn fee
     * @param selfRelayInputs 
     */
    async selfRelayTx(selfRelayInputs: SelfRelayInputs) {
        const contract = await this.#getTokenContract(
            selfRelayInputs.signatureInputs.contract,
            { wallet: true, nodeType: "full" }
        )
        await selfRelayTx(selfRelayInputs, this.viemWallet, contract)
    }

    /**
     * relays reMint tx, *does* earn fee
     * @param selfRelayInputs 
     */
    async relayTx(relayInputs: RelayInputs) {
        const contract = await this.#getTokenContract(
            relayInputs.signatureInputs.contract,
            { wallet: true, nodeType: "full" }
        )
        await relayTx(relayInputs, this.viemWallet, contract)
    }

    /**
     * for when you just want to burn without thinking about it
     * or when you need to receive some change for relayer fees, without revealing who you are.
     * @notice this.burnViewKeyManager.getFreshBurnAccount checks if it's fresh by checking the balance, but only on one chain and balance of one coin. It is not fool proof. Maybe we need derivation path for one time use addresses
     * @param wormholeTokenAddress 
     * @param ethSigningAddress 
     * @param param2 
     * @returns 
     */
    async getFreshBurnAccount(wormholeTokenAddress: Address, { ethSigningAddress, chainId }: { ethSigningAddress?: Address, chainId?: number } = {}) {
        ethSigningAddress ??= await this.defaultSigner()
        chainId ??= await this.viemWallet.getChainId()
        return await this.burnViewKeyManager.getFreshBurnAccount(
            wormholeTokenAddress,
            await this.#getPublicClient({ type: "full", chainId: chainId }),
            {
                chainId: BigInt(chainId),
                difficulty: BigInt((await this.#getContractConfig(wormholeTokenAddress, chainId)).POW_DIFFICULTY)
            }
        )
    }

    // TODO part of this is might need to go into viewKeyManager
    /**
     * 
     */
    async #resolveBurnAccount(burnAddress:Address, wormholeTokenAddress: Address, chainId: number): Promise<BurnAccount> {
        // if ("viewingKey" in burnAccount) return burnAccount as BurnAccount;
        // const { burnAddress } = burnAccount
        const difficulty = BigInt((await this.#getContractConfig(wormholeTokenAddress, chainId)).POW_DIFFICULTY)
        const allBurnAccounts = getAllBurnAccounts(
            this.burnViewKeyManager.privateData,
            {
                difficulties: [difficulty],
                chainIds: [BigInt(chainId)],
                ethAccounts: undefined
            }
        )
        const foundBurnAccount = allBurnAccounts.find((b) => b.burnAddress === burnAddress)
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
        amount: bigint, wormholeTokenAddress: Address, burnAccount?: BurnAccount | { burnAddress: Address },
        { chainId, ethSigningAddress }: { chainId?: number, ethSigningAddress?: Address } = {}
    ) {
        chainId ??= await this.viemWallet.getChainId()
        burnAccount ??= await this.getFreshBurnAccount(wormholeTokenAddress, { ethSigningAddress, chainId })

        const [fullBurnAccount, contractConfig, fullNode] = await Promise.all([
            // makes sure to retrieve a full burnAccount from viewKey manager, if only {burnAddress} is present
            ("viewingKey" in burnAccount) ? burnAccount : this.#resolveBurnAccount(burnAccount.burnAddress, wormholeTokenAddress, chainId),
            this.#getContractConfig(wormholeTokenAddress, chainId),
            this.#getPublicClient({ type: "full" }),
        ])
        ethSigningAddress ??= await this.defaultSigner()

        await superSafeBurn(fullBurnAccount, amount, wormholeTokenAddress, this.viemWallet, fullNode, ethSigningAddress, {
            difficulty: BigInt(contractConfig.POW_DIFFICULTY),
            reMintLimit: BigInt(contractConfig.RE_MINT_LIMIT),
            maxTreeDepth: Number(contractConfig.MAX_TREE_DEPTH)
        })
    }
}