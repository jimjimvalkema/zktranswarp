// PrivateWallet is a wrapper that exposes some of viem's WalletClient functions and requires them to only ever use one ethAccount

import type { Address, Hex, WalletClient } from "viem";
import { getAddress, hashMessage, padHex, toHex } from "viem";
import type { BurnAccount, ViewKeyData, PubKeyHex, BurnAccountBase, UnsyncedBurnAccount, UnsyncedDerivedBurnAccount, UnsyncedUnknownBurnAccount, DerivedBurnAccount } from "./types.ts"
import { findPoWNonce, findPoWNonceAsync, getBurnAddress, hashBlindedAddressData, hashPow, hashViewKeyFromRoot, verifyPowNonce } from "./hashing.ts";
import { VIEWING_KEY_SIG_MESSAGE } from "./constants.ts";
import { poseidon2Hash } from "@zkpassport/poseidon2"
import { getDeterministicBurnAccounts } from "./utils.ts";
import { extractPubKeyFromSig, getViewingKey } from "./signing.ts";
import { isDerivedBurnAccount } from "./schemas.ts";
//import { findPoWNonceAsync } from "./hashingAsync.js";

/**
 * A class that wraps around a viem WalletClient to enable creation of burn accounts that all share the same pubKey.
 * This class stores all newly generated burn accounts in PrivateWallet.viewKeyData.
 *
 * Other methods like signPrivateTransfer, proofAndSelfRelay, etc. are outside the class and only consume it,
 * since those methods won't create things we need to store or cache (like pubKey, important data).
 * This is to avoid OOP as much as possible.
 * @TODO is that a good decision?
 * Pros: can change circuit and contract and keep PrivateWallet the same
 */
export class BurnViewKeyManager {
    readonly viemWallet: WalletClient
    readonly privateData: ViewKeyData;

    readonly defaults: {
        acceptedChainIds: bigint[];
        chainId: bigint;
        powDifficulty: bigint;
    }

    /**
     * @param viemWallet
     * @param powDifficulty
     * @param options - Optional configuration object.
     * @param options.viewKeyData - Existing wallet data to import. If omitted, a fresh wallet is initialized.
     * @param options.viewKeySigMessage - Message used to derive the viewing key root. Defaults to {@link VIEWING_KEY_SIG_MESSAGE}.
     * @param options.acceptedChainIds - List of accepted chain IDs. Defaults to `[1n]`.
     * @param options.chainId - Default chain ID for operations. Inferred from `acceptedChainIds` if not provided.
     */
    constructor(
        viemWallet: WalletClient, powDifficulty: bigint,
        { viewKeyData, viewKeySigMessage = VIEWING_KEY_SIG_MESSAGE, acceptedChainIds = [1n], chainId, ethAddress }:
            { viewKeyData?: ViewKeyData, viewKeySigMessage?: string, powDifficulty?: bigint, acceptedChainIds?: bigint[], chainId?: bigint, ethAddress?:Address } = {}
    ) {
        this.viemWallet = viemWallet
        ethAddress ??= viemWallet.account?.address ? viemWallet.account?.address : "0x0000000000000000000000000000000000000000" as Address 
        // only one accepted chainId? thats default!
        // more? 1n is default, if it is accepted!
        // more then 1 acceptable chainIds but no mainnet, idk what what it should be then :/, throw error.
        if (chainId === undefined) {
            if (acceptedChainIds.length === 1) {
                chainId = acceptedChainIds[0]
            } else {
                if (acceptedChainIds.includes(1n)) {
                    chainId = 1n
                } else {
                    throw new Error(`chainId needs to be set. example: new PrivateWallet(viemWallet,{chainId:${Number(acceptedChainIds[0])},acceptedChainIds:[${acceptedChainIds.map((v => Number(v) + "n")).toString()}]})`)
                }
            }
        }

        this.defaults = {
            acceptedChainIds: acceptedChainIds,
            chainId: chainId,
            powDifficulty: powDifficulty
        }

        // init this.viewKeyData
        if (viewKeyData === undefined) {
            // set default
            this.privateData = {
                viewKeySigMessage: viewKeySigMessage,
                burnAccounts: {}
            }
        } else {
            // check input
            if (viewKeySigMessage !== viewKeyData.viewKeySigMessage) {
                throw new Error(`cant change viewKey message of a imported account`)
            }
            this.privateData = structuredClone(viewKeyData)
        }
        this.#createBurnAccountsKeys({ chainId: chainId, difficulty: powDifficulty, ethAccount: ethAddress})
    }

    // prompts user to sign to create viewing keys and also store pubKey of eth account
    async #connect(ethAccount: Address, message = this.privateData.viewKeySigMessage) {
        if (this.privateData.burnAccounts[ethAccount].pubKey !== undefined && this.privateData.detViewKeyRoot !== undefined) {
            return { viewKeyRoot: this.privateData.detViewKeyRoot as Hex, pubKey: this.privateData.burnAccounts[ethAccount].pubKey }
        } else {
            const signature = await this.viemWallet.signMessage({ message: message, account: ethAccount })
            const hash = hashMessage(message);
            const viewKeyRoot = toHex(getViewingKey({ signature: signature }));
            const { pubKeyX, pubKeyY } = await extractPubKeyFromSig({ hash, signature })
            if (message !== this.privateData.viewKeySigMessage) {
                console.warn(`
                    Connecting with a different message the that is stored at BurnViewKeyManager.privateData.viewKeySigMessage
                    The rootViewKey will be returned but not stored in privateData! 
                    `)
            } else {
                this.privateData.detViewKeyRoot = viewKeyRoot
            }
            this.privateData.burnAccounts[ethAccount].pubKey = { x: pubKeyX, y: pubKeyY }
            return { viewKeyRoot, pubKey: this.privateData.burnAccounts[ethAccount] }
        }
    }

    #createBurnAccountsKeys({ chainId, difficulty, ethAccount }: { chainId: bigint, difficulty: bigint, ethAccount: Address }) {
        const difficultyPadded = toHex(difficulty, { size: 32 })
        const chainIdPadded = toHex(chainId, { size: 32 })
        this.#createBurnAccountsKeysHex({ chainIdHex: chainIdPadded, difficultyHex: difficultyPadded, ethAccount })

    }

    #createBurnAccountsKeysHex({ chainIdHex, difficultyHex, ethAccount }: { chainIdHex: Hex, difficultyHex: Hex, ethAccount: Address }) {
        this.privateData.burnAccounts[ethAccount] ??= { pubKey: undefined, detViewKeyCounter: 0, burnAccounts: {} };
        this.privateData.burnAccounts[ethAccount].burnAccounts[chainIdHex] ??= {};
        this.privateData.burnAccounts[ethAccount].burnAccounts[chainIdHex][difficultyHex] ??= {derivedBurnAccounts:[], unknownBurnAccounts:[]};
    }

    #addBurnAccount(burnAccount: BurnAccount) {
        const difficultyPadded = padHex(burnAccount.difficulty, { size: 32 })
        const chainIdPadded = padHex(burnAccount.chainId, { size: 32 })
        this.#createBurnAccountsKeysHex({ chainIdHex: chainIdPadded, difficultyHex: difficultyPadded, ethAccount: burnAccount.ethAccount })
         if (isDerivedBurnAccount(burnAccount)) {
            this.privateData.burnAccounts[burnAccount.ethAccount].burnAccounts[chainIdPadded][difficultyPadded].derivedBurnAccounts[burnAccount.viewingKeyIndex] = burnAccount
        } else {
            this.privateData.burnAccounts[burnAccount.ethAccount].burnAccounts[chainIdPadded][difficultyPadded].unknownBurnAccounts.push(burnAccount)
        }
    }

    // prompts user to sign to create viewing keys and also store pubKey of eth account
    async connect(ethAccount: Address) {
        return await this.#connect(ethAccount)
    }

    /**
     * @notice Prompts the user to sign a message if the deterministic view key root is not stored yet.
     * @returns The deterministic view key root.
     */
    async getDeterministicViewKeyRoot(ethAccount: Address, message = this.privateData.viewKeySigMessage): Promise<Hex> {
        if (this.privateData.detViewKeyRoot === undefined) {
            await this.#connect(ethAccount, message)
        }
        return this.privateData.detViewKeyRoot as Hex
    }

    /**
     * @notice Prompts the user to sign a message if the public key is not stored yet.
     * @returns The wallet's spending public key as `{ x, y }`.
     */
    async getPubKey(ethAccount: Address, message = this.privateData.viewKeySigMessage) {
        if (this.privateData.burnAccounts[ethAccount].pubKey === undefined) {
            await this.#connect(ethAccount, message)
        }
        return this.privateData.burnAccounts[ethAccount].pubKey as { x: Hex, y: Hex }
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
        { ethAccount, powNonce, viewingKey, viewingKeyIndex, chainId = this.defaults.chainId, difficulty = this.defaults.powDifficulty, async = false, viewKeyMessage = this.privateData.viewKeySigMessage }:
            { ethAccount?: Address, powNonce?: bigint, viewingKey?: bigint, viewingKeyIndex?: number, chainId?: bigint, difficulty?: bigint, async?: boolean, viewKeyMessage?: string } = {}
    ) {
        ethAccount ??= (await this.viemWallet.getAddresses())[0]
        if (viewingKeyIndex === undefined) {
            viewingKeyIndex = this.privateData.burnAccounts[ethAccount].detViewKeyCounter
            this.privateData.burnAccounts[ethAccount].detViewKeyCounter += 1
        }
        const isDeterministic = powNonce === undefined && viewingKey === undefined;
        this.#createBurnAccountsKeys({chainId,difficulty,ethAccount})
        if (isDeterministic) {
            const preCachedBurnAccounts = getDeterministicBurnAccounts(this, ethAccount, { difficulty: difficulty, chainId: chainId })
            if (preCachedBurnAccounts[viewingKeyIndex]) {
                return preCachedBurnAccounts[viewingKeyIndex]
            }
        }
        const { x: spendingPubKeyX } = await this.getPubKey(ethAccount)


        const viewKeyRoot = BigInt(await this.getDeterministicViewKeyRoot(ethAccount, viewKeyMessage))
        //---------
        const burnAccount = await createBurnAccount({ isDeterministic, ethAccount: ethAccount, viewKeySigMessage: this.privateData.viewKeySigMessage, spendingPubKeyX, viewingKeyIndex, viewKeyRoot, powNonce, viewingKey, chainId, difficulty, async })
        this.#addBurnAccount(burnAccount)
        return burnAccount
    }

    //{ ethAccount, powNonce, viewingKey, viewingKeyIndex, chainId = this.defaults.chainId, difficulty = this.defaults.powDifficulty, async = false, viewKeyMessage = this.privateData.viewKeySigMessage }
    async importBurnAccount(importedBurnAccount: BurnAccount) {
        const isDeterministic = "viewingKeyIndex" in importedBurnAccount && importedBurnAccount.viewingKeyIndex && "viewKeySigMessage" in importedBurnAccount && importedBurnAccount.viewKeySigMessage
        const hasViewKey = "viewingKey" in importedBurnAccount && importedBurnAccount.viewingKey

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
        { ethAccount, startingViewKeyIndex, chainId, difficulty = this.defaults.powDifficulty, async = false }:
            { ethAccount?: Address, startingViewKeyIndex?: number, async?: boolean, chainId?: bigint, difficulty?: bigint } = {}
    ) {
        ethAccount ??= (await this.viemWallet.getAddresses())[0]
        chainId ??= this.defaults.chainId
        this.#createBurnAccountsKeys({chainId,ethAccount,difficulty})
        startingViewKeyIndex ??= this.privateData.burnAccounts[ethAccount].detViewKeyCounter
        const burnAccountsPromises = new Array(amountOfBurnAccounts).fill(0).map((v, i) =>
            this.createBurnAccount(
                { ethAccount, viewingKeyIndex: startingViewKeyIndex + i, chainId: chainId, difficulty: difficulty, async: async }
            )
        )

        const burnAccounts = await Promise.all(burnAccountsPromises)
        const lastIndex = amountOfBurnAccounts + startingViewKeyIndex
        if (lastIndex > this.privateData.burnAccounts[ethAccount].detViewKeyCounter) {
            this.privateData.burnAccounts[ethAccount].detViewKeyCounter = lastIndex
        }
        return burnAccounts
    }

}


async function createBurnAccount(
    { isDeterministic, spendingPubKeyX, viewKeyRoot, viewKeySigMessage, ethAccount, powNonce, viewingKey, viewingKeyIndex, chainId, difficulty, async = false }:
        { isDeterministic: boolean, spendingPubKeyX: Hex, viewKeyRoot: bigint, viewKeySigMessage: string, ethAccount: Address, powNonce?: bigint, viewingKey?: bigint, viewingKeyIndex: number, chainId: bigint, difficulty: bigint, async?: boolean }
) {
    viewingKey ??= hashViewKeyFromRoot(
        viewKeyRoot,
        BigInt(viewingKeyIndex)
    )

    const blindedAddressDataHash = hashBlindedAddressData({ spendingPubKeyX: spendingPubKeyX, viewingKey: viewingKey as bigint, chainId: chainId })

    if (powNonce) {
        const isValidPowNonce = verifyPowNonce({ difficulty: difficulty, blindedAddressDataHash: blindedAddressDataHash, powNonce: powNonce })
        if (isValidPowNonce === false) {
            const powHash = hashPow({ blindedAddressDataHash, powNonce })
            throw new Error(
                `Invalid powNonce provided. Please provide a valid one or set to undefined so a new valid one can be found.` +
                `\npowNonce: ${toHex(powNonce, { size: 32 })}` +
                `\ndifficulty: ${toHex(difficulty, { size: 32 })}` +
                `\npowHash: ${toHex(powHash, { size: 32 })}`
            )
        }
    }

    if (async) {
        powNonce ??= await findPoWNonceAsync({ blindedAddressDataHash, startingValue: viewingKey as bigint, difficulty: difficulty }) as bigint
    } else {
        powNonce ??= findPoWNonce({ blindedAddressDataHash, startingValue: viewingKey as bigint, difficulty: difficulty })
    }

    const burnAddress = getBurnAddress({ blindedAddressDataHash: blindedAddressDataHash, powNonce: powNonce })
    let burnAccount: UnsyncedUnknownBurnAccount = {
        viewingKey: toHex(viewingKey as bigint, { size: 32 }),
        powNonce: toHex(powNonce, { size: 32 }),
        burnAddress: burnAddress,
        chainId: toHex(chainId),
        blindedAddressDataHash: toHex(blindedAddressDataHash, { size: 32 }),
        spendingPubKeyX: spendingPubKeyX,
        difficulty: toHex(difficulty, { size: 32 }),
        ethAccount: ethAccount,
    }

    if (isDeterministic) {
        burnAccount = {
            ...burnAccount,
            viewKeySigMessage: viewKeySigMessage,
            viewingKeyIndex: viewingKeyIndex
        } as UnsyncedDerivedBurnAccount;
    }

    return burnAccount
}