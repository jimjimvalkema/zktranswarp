// PrivateWallet is a wrapper that exposes some of viem's WalletClient functions and requires them to only ever use one ethAccount

import type { Address, Hex, PublicClient, WalletClient } from "viem";
import { ethAddress, hashMessage, padHex, toHex } from "viem";
import type { BurnAccount, UnsyncedBurnAccount, UnsyncedDerivedBurnAccount, UnsyncedUnknownBurnAccount, AnyBurnAccount, BurnAccountRecoverable, DerivedBurnAccountRecoverable, BurnAccountImportable, ExportedViewKeyData, FullViewKeyData, UnknownBurnAccountRecoverable, UnknownBurnAccountImportable, DerivedBurnAccountImportable } from "./types.ts"
import { findPoWNonce, findPoWNonceAsync, getBurnAddress, hashBlindedAddressData, hashPow, hashViewKeyFromRoot, isValidPowNonce } from "./hashing.ts";
import { VIEWING_KEY_SIG_MESSAGE } from "./constants.ts";
import { BurnAccountToFlatArr, BurnAccountToFlatArrExportedData, getDeterministicBurnAccounts, getWormholeTokenContract, toImportableBurnAccount, toImportableDerivedBurnAccount, toImportableUnknownBurnAccount, toRecoverableBurnAccount, toRecoverableDerivedBurnAccount, toRecoverableUnknownBurnAccount } from "./utils.ts";
import { extractPubKeyFromSig, getViewingKey } from "./signing.ts";
import { BurnAccountSyncFieldsSchema, identifyBurnAccount, isDerivedBurnAccount, isSyncedBurnAccount } from "./schemas.ts";
import { syncBurnAccount } from "./syncing.ts";
import { viemAccountNotSetErr } from "./BurnWallet.ts";
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
 * 
 * @TODO remove default. BurnWallet will do default behavior, this should only store burnAccounts
 * @TODO rename to burnAccountManager
 * @TODO make burnAccount sync data specific per chainId=>tokenAddress, right now we will have bugs when used with multiple tokens
 */
export class BurnViewKeyManager {
    viemWallet: WalletClient
    readonly privateData: FullViewKeyData;

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
        viemWallet: WalletClient,
        { viewKeyData, acceptedChainIds = [1], chainId, ethAddress }:
            { viewKeyData?: FullViewKeyData, viewKeySigMessage?: string, acceptedChainIds?: number[], chainId?: number, ethAddress?: Address } = {}
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
                if (acceptedChainIds.includes(1)) {
                    chainId = 1
                } else {
                    throw new Error(`chainId needs to be set. example: new PrivateWallet(viemWallet,{chainId:${Number(acceptedChainIds[0])},acceptedChainIds:[${acceptedChainIds.map((v => Number(v) + "n")).toString()}]})`)
                }
            }
        }

        // init this.viewKeyData
        if (viewKeyData === undefined) {
            // set default
            this.privateData = {
                burnAccounts: {}
            }
        } else {
            // check input
            this.privateData = structuredClone(viewKeyData)
        }
        //this.#createBurnAccountsKeys({ chainId: chainId, difficulty: powDifficulty, ethAccount: ethAddress })
    }

    // prompts user to sign to create viewing keys and also store pubKey of eth account
    async #connect(ethAccount: Address, message = VIEWING_KEY_SIG_MESSAGE) {
        this.privateData.burnAccounts[ethAccount] ??= {detViewKeyRoot:undefined, pubKey: undefined, detViewKeyCounter: 0, burnAccounts: {} };
        if (this.privateData.burnAccounts[ethAccount].pubKey && this.privateData.burnAccounts[ethAccount].detViewKeyRoot) {
            return { viewKeyRoot: this.privateData.burnAccounts[ethAccount].detViewKeyRoot, pubKey: this.privateData.burnAccounts[ethAccount].pubKey }
        } else {
            const signature = await this.viemWallet.signMessage({ message: message, account: ethAccount })
            const hash = hashMessage(message);
            const viewKeyRoot = toHex(getViewingKey({ signature: signature }));
            const { pubKeyX, pubKeyY } = await extractPubKeyFromSig({ hash, signature })

            this.privateData.burnAccounts[ethAccount].detViewKeyRoot = viewKeyRoot

            this.privateData.burnAccounts[ethAccount].pubKey = { x: pubKeyX, y: pubKeyY }
            return { viewKeyRoot, pubKey: this.privateData.burnAccounts[ethAccount] }
        }
    }

    #createBurnAccountsKeys({ chainId, difficulty, ethAccount }: { chainId: number, difficulty: Hex, ethAccount: Address }) {
        const difficultyPadded = padHex(difficulty, { size: 32 })
        const chainIdHex = toHex(chainId)
        this.#createBurnAccountsKeysHex({ chainIdHex: chainIdHex, difficultyHex: difficultyPadded, ethAccount })

    }

    #createBurnAccountsKeysHex({ chainIdHex, difficultyHex, ethAccount }: { chainIdHex: Hex, difficultyHex: Hex, ethAccount: Address }) {
        this.privateData.burnAccounts[ethAccount] ??= { pubKey: undefined, detViewKeyCounter: 0, burnAccounts: {}, detViewKeyRoot:undefined };
        this.privateData.burnAccounts[ethAccount].burnAccounts[chainIdHex] ??= {};
        this.privateData.burnAccounts[ethAccount].burnAccounts[chainIdHex][difficultyHex] ??= { derivedBurnAccounts: [], unknownBurnAccounts: {} };
    }

    #getBurnAccount(ethAccount: Address, chainId: number, difficulty: Hex, viewingKeyIndex: number, burnAddress: Address) {
        const difficultyPadded = padHex(difficulty, { size: 32 })
        const chainIdHex = toHex(chainId)
        if (viewingKeyIndex) {
            return this.privateData.burnAccounts[ethAccount].burnAccounts[chainIdHex][difficultyPadded].derivedBurnAccounts[viewingKeyIndex]
        } else {
            return this.privateData.burnAccounts[ethAccount].burnAccounts[chainIdHex][difficultyPadded].unknownBurnAccounts[burnAddress]
        }
    }

    /**
     * @note does not support recoverable and importable type, since it directly writes without the full checks, and relies on `burnAddress` to know where to put the unknown derivation accounts
     * @param burnAccount 
     */
    #addBurnAccount(burnAccount: BurnAccount) {
        // extra safety, if burnAccount.difficulty is not padded this wont pad it
        // but key used for storage is because if it ins't duplicate entries can be created
        const difficultyPadded = padHex(burnAccount.difficulty, { size: 32 })
        this.#createBurnAccountsKeysHex({ chainIdHex: burnAccount.chainId, difficultyHex: difficultyPadded, ethAccount: burnAccount.ethAccount })
        if (isDerivedBurnAccount(burnAccount)) {
            this.privateData.burnAccounts[burnAccount.ethAccount].burnAccounts[burnAccount.chainId][difficultyPadded].derivedBurnAccounts[burnAccount.viewingKeyIndex] = burnAccount
        } else {
            this.privateData.burnAccounts[burnAccount.ethAccount].burnAccounts[burnAccount.chainId][difficultyPadded].unknownBurnAccounts[burnAccount.burnAddress] = burnAccount
        }
    }

    // prompts user to sign to create viewing keys and also store pubKey of eth account
    async connect(walletClient?: WalletClient) {
        walletClient ??= this.viemWallet
        this.viemWallet = walletClient
        if (walletClient.account === undefined) throw new Error(viemAccountNotSetErr)
        return await this.#connect(walletClient.account.address as Address)
    }

    /**
     * @notice Prompts the user to sign a message if the deterministic view key root is not stored yet.
     * @returns The deterministic view key root.
     */
    async getDeterministicViewKeyRoot(ethAccount: Address, message = VIEWING_KEY_SIG_MESSAGE): Promise<Hex> {
        if ( this.privateData.burnAccounts[ethAccount] === undefined || this.privateData.burnAccounts[ethAccount].detViewKeyRoot === undefined) {
            await this.#connect(ethAccount, message)
        }
        return  this.privateData.burnAccounts[ethAccount].detViewKeyRoot as Hex
    }

    /**
     * @notice Prompts the user to sign a message if the public key is not stored yet.
     * @returns The wallet's spending public key as `{ x, y }`.
     */
    async getPubKey(ethAccount: Address, message = VIEWING_KEY_SIG_MESSAGE) {
        if (this.privateData.burnAccounts[ethAccount] === undefined  || this.privateData.burnAccounts[ethAccount].pubKey === undefined) {
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
        chainId: number, difficulty: Hex,
        { isDeterministic, spendingPubKeyX, signingEthAccount, powNonce, viewingKey, viewingKeyIndex, async = false, viewKeyMessage = VIEWING_KEY_SIG_MESSAGE }:
            { isDeterministic?: boolean, spendingPubKeyX?: Hex, signingEthAccount?: Address, powNonce?: bigint, viewingKey?: bigint, viewingKeyIndex?: number, chainId?: number, async?: boolean, viewKeyMessage?: string } = {}
    ) {
        signingEthAccount ??= this.viemWallet.account?.address as Address
        if (viewingKeyIndex === undefined) {
            viewingKeyIndex = this.privateData.burnAccounts[signingEthAccount].detViewKeyCounter
            this.privateData.burnAccounts[signingEthAccount].detViewKeyCounter += 1
        }

        // TODO technically, if a PowNonce is provided, could not be deterministic, But we don't check for that here since it takes too long
        isDeterministic ??= viewingKey === undefined && powNonce === undefined;
        this.#createBurnAccountsKeys({ chainId, difficulty, ethAccount: signingEthAccount })
        if (isDeterministic) {
            const preCachedBurnAccounts = getDeterministicBurnAccounts(this, signingEthAccount, chainId, difficulty)
            if (preCachedBurnAccounts[viewingKeyIndex]) {
                return preCachedBurnAccounts[viewingKeyIndex]
            }
        }
        spendingPubKeyX ??= (await this.getPubKey(signingEthAccount)).x
        //TODO check it matches ethAddress maybe?

        const viewKeyRoot = BigInt(await this.getDeterministicViewKeyRoot(signingEthAccount, viewKeyMessage))
        //---------
        const burnAccount = await createBurnAccount(
            isDeterministic, spendingPubKeyX, viewKeyRoot, viewKeyMessage, chainId, difficulty, signingEthAccount, viewingKeyIndex,
            { powNonce, viewingKey, async }
        )
        this.#addBurnAccount(burnAccount)
        return burnAccount
    }

    async getFreshBurnAccount(
        tokenAddress: Address, fullNode: PublicClient, difficulty: Hex,
        { signingEthAccount, chainId }: { signingEthAccount?: Address, chainId?: number } = {}
    ) {
        chainId ??= await fullNode.getChainId()
        const tokenContract = getWormholeTokenContract(tokenAddress, { public: fullNode })
        let isUsed: boolean;
        let burnAccount: UnsyncedBurnAccount;
        do {
            burnAccount = await this.createBurnAccount(chainId, difficulty, { signingEthAccount })
            const balance = await tokenContract.read.balanceOf([burnAccount.burnAddress])
            isUsed = balance !== 0n

        } while (isUsed)
        return burnAccount
    }

    // TODO figure out if we want checks here?
    updateBurnAccount(burnAccount: BurnAccount) {
        this.#addBurnAccount(burnAccount)
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
        amountOfBurnAccounts: number, chainId: number, difficulty: Hex,
        { signingEthAccount, startingViewKeyIndex, async = false }:
            { signingEthAccount?: Address, startingViewKeyIndex?: number, async?: boolean } = {}
    ) {
        signingEthAccount ??= this.viemWallet.account?.address as Address
        this.#createBurnAccountsKeys({ chainId, ethAccount: signingEthAccount, difficulty })
        startingViewKeyIndex ??= this.privateData.burnAccounts[signingEthAccount].detViewKeyCounter
        const burnAccountsPromises = new Array(amountOfBurnAccounts).fill(0).map((v, i) =>
            this.createBurnAccount(
                chainId, difficulty,
                { signingEthAccount, viewingKeyIndex: startingViewKeyIndex + i, async: async }
            )
        )

        const burnAccounts = await Promise.all(burnAccountsPromises)
        const lastIndex = amountOfBurnAccounts + startingViewKeyIndex
        if (lastIndex > this.privateData.burnAccounts[signingEthAccount].detViewKeyCounter) {
            this.privateData.burnAccounts[signingEthAccount].detViewKeyCounter = lastIndex
        }
        return burnAccounts
    }

    // export
    exportBurnAccounts(ethAccount: Address, chainId: number, difficulty: Hex, opts: { paranoidMode: true }): { derived: BurnAccountRecoverable[], unknown: BurnAccountRecoverable[] };
    exportBurnAccounts(ethAccount: Address, chainId: number, difficulty: Hex, opts?: { paranoidMode?: false }): { derived: (BurnAccountRecoverable | BurnAccountImportable)[], unknown: (BurnAccountRecoverable | BurnAccountImportable)[] };
    exportBurnAccounts(ethAccount: Address, chainId: number, difficulty: Hex, opts?: { paranoidMode: boolean }): { derived: (BurnAccountRecoverable | BurnAccountImportable)[], unknown: (BurnAccountRecoverable | BurnAccountImportable)[] };
    /**
     * @param ethAccount 
     * @param chainId 
     * @param difficulty 
     * @param opts.paranoidMode - forces all output to {@link BurnAccountRecoverable}, excluding accountNonce and syncBlockNumber for stronger privacy
     */
    exportBurnAccounts(
        ethAccount: Address, chainId: number, difficulty: Hex, { paranoidMode = false } = {}
    ): { derived: (DerivedBurnAccountRecoverable | DerivedBurnAccountImportable)[], unknown: (UnknownBurnAccountRecoverable | UnknownBurnAccountImportable)[] } {
        const difficultyPadded = padHex(difficulty, { size: 32 });
        const chainIdHex = toHex(chainId)
        const derived = this.privateData.burnAccounts[ethAccount].burnAccounts[chainIdHex][difficultyPadded].derivedBurnAccounts.map(
            (b) => paranoidMode === false ? toImportableDerivedBurnAccount(b) : toRecoverableDerivedBurnAccount(b)
        );
        const unknown = Object.values(this.privateData.burnAccounts[ethAccount].burnAccounts[chainIdHex][difficultyPadded].unknownBurnAccounts).map(
            (b) => paranoidMode === false ? toImportableUnknownBurnAccount(b) : toRecoverableUnknownBurnAccount(b)
        );
        return { derived, unknown };
    }

    exportAllBurnAccounts(paranoidMode: true): BurnAccountRecoverable[];
    exportAllBurnAccounts(paranoidMode?: false): (BurnAccountRecoverable | BurnAccountImportable)[];
    exportAllBurnAccounts(paranoidMode: boolean): (BurnAccountRecoverable | BurnAccountImportable)[];
    /**
     * @param opts.paranoidMode - forces all output to {@link BurnAccountRecoverable}, excluding accountNonce and syncBlockNumber for stronger privacy
     */
    exportAllBurnAccounts(
        paranoidMode = false
    ): (BurnAccountRecoverable | BurnAccountImportable)[] {
        const allBurnAccounts = BurnAccountToFlatArr(this.privateData)
        return allBurnAccounts.map((b) => paranoidMode === false && isSyncedBurnAccount(b) ? toImportableBurnAccount(b) : toRecoverableBurnAccount(b))
    }

    exportViewKeyData(paranoidMode: true): ExportedViewKeyData<BurnAccountRecoverable>;
    exportViewKeyData(paranoidMode?: false): ExportedViewKeyData<BurnAccountImportable | BurnAccountRecoverable>;
    exportViewKeyData(paranoidMode: boolean): ExportedViewKeyData<BurnAccountImportable | BurnAccountRecoverable>;
    exportViewKeyData(paranoidMode = false): ExportedViewKeyData<BurnAccountImportable | BurnAccountRecoverable> {
        const burnAccounts: ExportedViewKeyData<BurnAccountImportable | BurnAccountRecoverable>["burnAccounts"] = {};
        for (const ethAccount of Object.keys(this.privateData.burnAccounts) as Address[]) {
            const ethData = this.privateData.burnAccounts[ethAccount];
            burnAccounts[ethAccount] = { detViewKeyCounter: ethData.detViewKeyCounter, burnAccounts: {} };
            for (const chainId of Object.keys(ethData.burnAccounts) as Hex[]) {
                burnAccounts[ethAccount].burnAccounts[chainId] = {};
                for (const difficulty of Object.keys(ethData.burnAccounts[chainId]) as Hex[]) {
                    const { derived, unknown } = this.exportBurnAccounts(ethAccount, Number(chainId as Hex), difficulty, { paranoidMode: paranoidMode });
                    burnAccounts[ethAccount].burnAccounts[chainId][difficulty] = {
                        derivedBurnAccounts: derived,
                        unknownBurnAccounts: unknown
                    };
                }
            }
        }
        const vieKeyData: ExportedViewKeyData<BurnAccountImportable | BurnAccountRecoverable> = { burnAccounts };
        return vieKeyData
    }

    // import
    /**
     * TODO use pLimit so we don't bombard rpc, during this.importBurnAccount
     * @param json 
     * @param wormholeToken 
     * @param archiveNode 
     * @param param3 
     */
    async importViewKeyWalletData(
        importedViewKeyData: ExportedViewKeyData<BurnAccountImportable | BurnAccountRecoverable>, tokenAddress: Address, archiveNode: PublicClient,
        { forceReSign = false, forceReHashViewKey = true, forcePow = false, async = false, fullNode, onlySignInWith }: { forceReSign?: boolean, forceReHashViewKey?: boolean, forcePow?: boolean, async?: boolean, fullNode?: PublicClient, onlySignInWith?: Address } = {}
    ) {
        fullNode ??= archiveNode;
        const allBurnAccounts = BurnAccountToFlatArrExportedData(importedViewKeyData)

        // ---------- sign in before import -------------
        // so the user only gets one request per ethAccount+message combo

        const seen = new Set<string>();
        const toConnect = allBurnAccounts.filter((b) => {
            if (onlySignInWith && b.ethAccount !== onlySignInWith) return false;
            const key = `${b.ethAccount}:${"viewKeySigMessage" in b ? b.viewKeySigMessage : ""}`;
            return !seen.has(key) && !!seen.add(key);
        });

        // try and connect all ethAccount+message combos, only only once, no every burn account (what `(accountsToImport.map((b) => this.importBurnAccount())` would do)
        const results = await Promise.allSettled(
            toConnect.map((b) => this.#connect(b.ethAccount, "viewKeySigMessage" in b ? b.viewKeySigMessage : undefined))
        );

        // get the ethAccount+message combo key who are rejected
        const rejectedKeys = new Set(
            toConnect
                .filter((_, i) => results[i].status === "rejected")
                .map((b) => `${b.ethAccount}:${"viewKeySigMessage" in b ? b.viewKeySigMessage : ""}`)
        );
        if (rejectedKeys.size > 0) console.warn(`Some accounts not imported since user rejected the request: ${[...rejectedKeys]}`);

        // remove burnAccounts with that rejected ethAccount+message combo and filter by onlySignInWith
        const accountsToImport = allBurnAccounts.filter((b) => {
            if (onlySignInWith && b.ethAccount !== onlySignInWith) return false;
            const key = `${b.ethAccount}:${"viewKeySigMessage" in b ? b.viewKeySigMessage : ""}`;
            return !rejectedKeys.has(key);
        });

        await Promise.all(accountsToImport.map((b) => this.importBurnAccount(b, tokenAddress, archiveNode, { forceReSign, forceReHashViewKey, forcePow, async, fullNode })));

        const ethAccountsToImport = onlySignInWith
            ? Object.keys(importedViewKeyData.burnAccounts).filter((a) => a === onlySignInWith)
            : Object.keys(importedViewKeyData.burnAccounts);
        for (const ethAccount of ethAccountsToImport) {
            // only if the count is higher update it
            this.privateData.burnAccounts[ethAccount] ??= {
                detViewKeyRoot: undefined,
                pubKey: undefined,
                detViewKeyCounter: importedViewKeyData.burnAccounts[ethAccount as Address].detViewKeyCounter,
                burnAccounts: {}
            }
            if (this.privateData.burnAccounts[ethAccount].detViewKeyCounter < importedViewKeyData.burnAccounts[ethAccount as Address].detViewKeyCounter) {
                this.privateData.burnAccounts[ethAccount].detViewKeyCounter = importedViewKeyData.burnAccounts[ethAccount as Address].detViewKeyCounter
            }
        }
    }
    // { ethAccount, powNonce, viewingKey, viewingKeyIndex, chainId = this.defaults.chainId, difficulty = this.defaults.powDifficulty, async = false, viewKeyMessage = this.privateData.viewKeySigMessage }
    /**
     * forceReSign: will force recreation of spendingPubKeyX and viewing key (if the derivation is know). Will prompt the user to sign in the case rootViewingKey and/or spendingPubKeyX does not exist in storage yet
     * @param importedBurnAccount 
     * @param wormholeToken 
     * @param archiveNode 
     * @param param3 
     */
    async importBurnAccount(importedBurnAccount: AnyBurnAccount, tokenAddress: Address, archiveNode: PublicClient,
        { forceReSign = false, forceReHashViewKey = true, forcePow = false, async = false, fullNode }: { forceReHashViewKey?: boolean, fullNode?: PublicClient, forceReSign?: boolean, forcePow?: boolean, async?: boolean } = {}
    ) {
        fullNode ??= archiveNode
        const idBurnAccount = identifyBurnAccount(importedBurnAccount);
        let reCreatedBurnAccount: BurnAccount;
        // recreate the full burn account as much as possible, even if keys are already provided. So we can check every key was correct later
        if (idBurnAccount.derivation === "Derived") {
            reCreatedBurnAccount = await this.createBurnAccount(
                Number(idBurnAccount.account.chainId),
                idBurnAccount.account.difficulty,
                {
                    isDeterministic: true,
                    signingEthAccount: idBurnAccount.account.ethAccount,
                    viewingKeyIndex: idBurnAccount.account.viewingKeyIndex,
                    viewKeyMessage: idBurnAccount.account.viewKeySigMessage,
                    powNonce: forcePow === false && "powNonce" in idBurnAccount.account ? BigInt(idBurnAccount.account.powNonce) : undefined,
                    viewingKey: forceReHashViewKey === false && "viewingKey" in idBurnAccount.account ? BigInt(idBurnAccount.account.viewingKey) : undefined,
                    async: async,
                    spendingPubKeyX: forceReSign === false && "spendingPubKeyX" in idBurnAccount.account ? idBurnAccount.account.spendingPubKeyX : undefined
                }
            )
        } else {
            // viewingKey cant be recreated, so always used from importedBurnAccount. 
            // viewingKeyIndex, viewKeyMessage, does not exist and is omitted. rest is same as above
            reCreatedBurnAccount = await this.createBurnAccount(
                Number(idBurnAccount.account.chainId),
                idBurnAccount.account.difficulty,
                {
                    isDeterministic: false,
                    signingEthAccount: idBurnAccount.account.ethAccount,
                    // viewingKeyIndex: idBurnAccount.account.viewingKeyIndex,
                    // viewKeyMessage: idBurnAccount.account.viewKeySigMessage,
                    powNonce: forcePow === false && idBurnAccount.account.powNonce ? BigInt(idBurnAccount.account.powNonce) : undefined,
                    viewingKey: BigInt(idBurnAccount.account.viewingKey),
                    async: async,
                    spendingPubKeyX: forceReSign === false && "spendingPubKeyX" in idBurnAccount.account ? idBurnAccount.account.spendingPubKeyX : undefined
                }
            )
        }

        // i hate typescript
        const castedImportedAccount = idBurnAccount.account as Record<string, unknown>
        const castedReCreatedAccount = reCreatedBurnAccount as Record<string, unknown>
        const syncingRelatedKey = ["syncData", ...Object.keys(BurnAccountSyncFieldsSchema.shape)]
        let errors = []
        for (const key of Object.keys(idBurnAccount.account)) {
            if (
                syncingRelatedKey.includes(key) === false &&
                castedImportedAccount[key] !== undefined && castedImportedAccount[key] !== castedReCreatedAccount[key]
            ) {
                errors.push(new Error(
                    `invalid burn account. Failed to recreate a value at ${key} from the imported burnAccount. \n Recreated: ${castedReCreatedAccount[key]} but imported value is ${castedImportedAccount[key]}`
                ))
            }
        }
        if (errors.length > 0) throw new AggregateError(errors, `Burn account recreation failed: ${errors.length} field(s) did not match`);

        if (idBurnAccount.state === "Importable" || idBurnAccount.state === "Synced") {
            // effectively checks if that nonce is valid. If it's too high errors, too low it just keeps it and wont sync further
            // @TODO do this for all contracts in there
            // find the accountNonce for this tokenAddress from the imported syncData
            const importedSyncData = idBurnAccount.account.syncData
            let maxNonce: bigint | undefined
            if (importedSyncData) {
                for (const chainContracts of Object.values(importedSyncData)) {
                    if (chainContracts[tokenAddress]) {
                        maxNonce = BigInt(chainContracts[tokenAddress].accountNonce) + 1n
                        break
                    }
                }
            }
            await syncBurnAccount(reCreatedBurnAccount, tokenAddress, archiveNode, { fullNode, maxNonce })
        }
    }
}


async function createBurnAccount(
    isDeterministic: boolean, spendingPubKeyX: Hex, viewKeyRoot: bigint, viewKeySigMessage: string,
    chainId: number, difficulty: Hex, ethAccount: Address, viewingKeyIndex: number,
    { powNonce, viewingKey, async = false }: { powNonce?: bigint, viewingKey?: bigint, async?: boolean } = {}
) {
    viewingKey ??= hashViewKeyFromRoot(
        viewKeyRoot,
        BigInt(viewingKeyIndex)
    )
    const chainIdInt = BigInt(chainId)
    const difficultyInt = BigInt(difficulty)

    const blindedAddressDataHash = hashBlindedAddressData({ spendingPubKeyX: spendingPubKeyX, viewingKey: viewingKey as bigint, chainId: chainIdInt })

    if (powNonce) {
        const isValid = isValidPowNonce({ difficulty: difficultyInt, blindedAddressDataHash: blindedAddressDataHash, powNonce: powNonce })
        if (isValid === false) {
            const powHash = hashPow({ blindedAddressDataHash, powNonce })
            throw new Error(
                `Invalid powNonce provided. Please provide a valid one or set to undefined so a new valid one can be found.` +
                `\npowNonce: ${toHex(powNonce, { size: 32 })}` +
                `\ndifficulty: ${padHex(difficulty, { size: 32 })}` +
                `\npowHash: ${toHex(powHash, { size: 32 })}`
            )
        }
    }

    if (async) {
        powNonce ??= await findPoWNonceAsync({ blindedAddressDataHash, startingValue: viewingKey as bigint, difficulty: difficultyInt }) as bigint
    } else {
        powNonce ??= findPoWNonce({ blindedAddressDataHash, startingValue: viewingKey as bigint, difficulty: difficultyInt })
    }

    const burnAddress = getBurnAddress({ blindedAddressDataHash: blindedAddressDataHash, powNonce: powNonce })
    let burnAccount: UnsyncedUnknownBurnAccount = {
        viewingKey: toHex(viewingKey as bigint, { size: 32 }),
        powNonce: toHex(powNonce, { size: 32 }),
        burnAddress: burnAddress,
        chainId: toHex(chainId),
        blindedAddressDataHash: toHex(blindedAddressDataHash, { size: 32 }),
        spendingPubKeyX: spendingPubKeyX,
        difficulty: padHex(difficulty, { size: 32 }),
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