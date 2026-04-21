import type { Address, Hex, PublicClient, WalletClient } from "viem";
import { getAddress, toHex } from "viem";
import type { BackendPerSize, BurnAccount, PreSyncedTree, RelayInputs, SelfRelayInputs, UnsyncedBurnAccount, TranswarpToken } from "./types.ts";
import { UltraHonkBackend } from "@aztec/bb.js";
import { getBurnAddressSafe, hashBlindedAddressData, hashPow, isValidPowNonce } from "./hashing.ts";
import { BurnViewKeyManager } from "./BurnViewKeyManager.ts";
import { EAS_BYTE_LEN_OVERHEAD, ENCRYPTED_TOTAL_MINTED_PADDING, GAS_ESTIMATE_BUFFER_PERCENT, GAS_LIMIT_TX } from "./constants.ts";
import { createRelayerInputs } from "./proving.ts";
import type { BurnWallet } from "./BurnWallet.ts";
import { getAcceptedChainIdFromContract, getTranswarpTokenContract } from "./utils.ts";
import type { NotOwnedBurnAccount } from "./schemas.ts";


export async function burnCheck(burnAddress: Address, amount: bigint, tokenAddress: Address, fullNode: PublicClient, { maxTreeDepth, reMintLimit }: { maxTreeDepth: number, reMintLimit: bigint }) {
    const transwarpTokenFull = getTranswarpTokenContract(tokenAddress, { public: fullNode })
    // state
    const balance = await transwarpTokenFull.read.balanceOf([burnAddress])
    const newBurnBalance = balance + amount
    const treeSize = await transwarpTokenFull.read.treeSize()
    const safeDistanceFromFullTree = (35_000n / 10n) * 60n * 60n // 35_000 burn tx's for 1 hour.  assumes a 35_000 tps chain and burn txs being 10x expensive
    const fullTreeSize = 2n ** BigInt(maxTreeDepth)


    if (treeSize >= fullTreeSize) { throw new Error("Tree is FULL this tx WILL RESULT IS LOSS OF ALL FUNDS SEND. DO NOT SEND ANY BURN TRANSACTION!!!") }
    if (treeSize + safeDistanceFromFullTree >= fullTreeSize) { throw new Error("Tree is almost full and the risk is high this burn tx will result in loss of all funds send") }
    if (newBurnBalance >= reMintLimit) { throw new Error(`This transfer will cause the balance to go over the RE_MINT_LIMIT. This wil result in LOSS OF ALL FUNDS OVER THE LIMIT!! DO NOT SEND THIS TRANSACTION!!\n new balance: ${newBurnBalance} \n limit:       ${reMintLimit}`) }
}

export async function burnCheckSafe(burnAccount: NotOwnedBurnAccount, amount: bigint, tokenAddress: Address, fullNode: PublicClient, signingEthAccount: Address,
    { reMintLimit, maxTreeDepth, acceptedChainIds, isCrossChain, difficulty }: { isCrossChain: boolean, difficulty: bigint, reMintLimit: bigint, maxTreeDepth: number, acceptedChainIds?: Hex[] }
) {
    const transwarpTokenFull = getTranswarpTokenContract(tokenAddress, { public: fullNode })
    // checks
    if (isCrossChain) {
        acceptedChainIds ??= (await getAcceptedChainIdFromContract(tokenAddress, fullNode)).map((v) => toHex(v))
        if (acceptedChainIds.includes(burnAccount.chainId) === false) { throw new Error(`Burn account is on chainId:${burnAccount.chainId} but that is not a valid chainId for token: ${tokenAddress}, only these chainIds are accepted:${acceptedChainIds.toString()}`) }
    }
    const isValidPow = isValidPowNonce({
        blindedAddressDataHash: BigInt(burnAccount.blindedAddressDataHash),
        powNonce: BigInt(burnAccount.powNonce),
        difficulty: difficulty
    })
    if (isValidPow === false) { throw new Error(`PoW incorrect. Difficulty is ${toHex(difficulty, { size: 32 })} but resulting hash is: ${toHex(hashPow({ blindedAddressDataHash: BigInt(burnAccount.blindedAddressDataHash), powNonce: BigInt(burnAccount.powNonce) }), { size: 32 })}`) }
    await burnCheck(burnAccount.burnAddress, amount, tokenAddress, fullNode, { maxTreeDepth, reMintLimit })
}

export async function burnCheckSuperSafe(burnAccount: BurnAccount, amount: bigint, tokenAddress: Address, fullNode: PublicClient, signingEthAccount: Address,
    { reMintLimit, maxTreeDepth, acceptedChainIds, isCrossChain, difficulty }: { isCrossChain: boolean, difficulty: bigint, reMintLimit: bigint, maxTreeDepth: number, acceptedChainIds?: Hex[] }
) {
    const blindedAddressDataHash = hashBlindedAddressData({ spendingPubKeyX: burnAccount.spendingPubKeyX, viewingKey: BigInt(burnAccount.viewingKey), chainId: BigInt(burnAccount.chainId) })
    const burnAddress = getBurnAddressSafe({ blindedAddressDataHash: blindedAddressDataHash, powNonce: BigInt(burnAccount.powNonce), difficulty: difficulty })
    if (burnAddress !== getAddress(burnAccount.burnAddress)) { throw new Error(`Burn account address mismatch, recreated burn address as: ${burnAddress} but burnAccount has it's burn address set as ${getAddress(burnAccount.burnAddress)}`) }
    await burnCheckSafe(
        burnAccount, amount, tokenAddress, fullNode, signingEthAccount,
        { reMintLimit, maxTreeDepth, acceptedChainIds, isCrossChain, difficulty }
    )
}

async function unsafeBurn(tokenAddress: Address, burnAddress: Address, amount: bigint, wallet: WalletClient, fullNode: PublicClient, signingEthAccount: Address) {
    const transwarpTokenFull = getTranswarpTokenContract(tokenAddress, { wallet, public: fullNode })
    const estimatedGas = await transwarpTokenFull.estimateGas.transfer([burnAddress, amount], { account: signingEthAccount })
    return await transwarpTokenFull.write.transfer([burnAddress, amount], { account: signingEthAccount, chain: null, gas: estimatedGas * GAS_ESTIMATE_BUFFER_PERCENT / 100n })
}

/**
 * that the merkle tree is not full and the balance of the recipient wont exceed reMintLimit
 * @notice does not check that the blindedAddressDataHash is correct!
 * TODO maybe put max tree depth in contract
 * @param burnAccount 
 * @param transwarpToken 
 * @param amount 
 * @param maxTreeDepth 
 * @param difficulty 
 * @returns 
 */
export async function burn(
    burnAddress: Address, amount: bigint, tokenAddress: Address, wallet: WalletClient, fullNode: PublicClient, signingEthAccount: Address,
    { reMintLimit, maxTreeDepth }: { reMintLimit?: bigint, maxTreeDepth?: number } = {}
) {
    const transwarpTokenFull = getTranswarpTokenContract(tokenAddress, { wallet, public: fullNode })
    const [resolvedReMintLimit, resolvedMaxTreeDepth] = await Promise.all([
        reMintLimit ?? BigInt(await transwarpTokenFull.read.RE_MINT_LIMIT()),
        maxTreeDepth ?? await transwarpTokenFull.read.MAX_TREE_DEPTH(),
    ])

    await burnCheck(burnAddress, amount, tokenAddress, fullNode, { maxTreeDepth: resolvedMaxTreeDepth as number, reMintLimit: resolvedReMintLimit as bigint })

    return await unsafeBurn(tokenAddress, burnAddress, amount, wallet, fullNode, signingEthAccount)
}

/**
 * checks that at least the PoW nonce is correct,
 * that the merkle tree is not full and the balance of the recipient wont exceed reMintLimit
 * @notice does not check that the blindedAddressDataHash is correct!
 * TODO maybe put max tree depth in contract
 * @param burnAccount
 * @param transwarpToken
 * @param amount
 * @param maxTreeDepth
 * @param difficulty
 * @returns
 */
export async function safeBurn(
    burnAccount: NotOwnedBurnAccount, amount: bigint, tokenAddress: Address, wallet: WalletClient, fullNode: PublicClient, signingEthAccount: Address,
    { reMintLimit, maxTreeDepth, acceptedChainIds, isCrossChain, difficulty }: { isCrossChain?: boolean, difficulty?: bigint, reMintLimit?: bigint, maxTreeDepth?: number, acceptedChainIds?: Hex[] } = {}
) {
    const transwarpTokenFull = getTranswarpTokenContract(tokenAddress, { wallet, public: fullNode })
    const [resolvedIsCrossChain, resolvedDifficulty, resolvedReMintLimit, resolvedMaxTreeDepth] = await Promise.all([
        isCrossChain ?? transwarpTokenFull.read.IS_CROSS_CHAIN(),
        difficulty ?? BigInt(await transwarpTokenFull.read.POW_DIFFICULTY()),
        reMintLimit ?? BigInt(await transwarpTokenFull.read.RE_MINT_LIMIT()),
        maxTreeDepth ?? await transwarpTokenFull.read.MAX_TREE_DEPTH(),
    ])
    if (resolvedIsCrossChain && !acceptedChainIds) {
        acceptedChainIds = (await getAcceptedChainIdFromContract(tokenAddress, fullNode)).map((v) => toHex(v))
    }

    await burnCheckSafe(
        burnAccount, amount, tokenAddress, fullNode, signingEthAccount,
        { reMintLimit: resolvedReMintLimit as bigint, maxTreeDepth: resolvedMaxTreeDepth as number, acceptedChainIds, isCrossChain: resolvedIsCrossChain as boolean, difficulty: resolvedDifficulty as bigint }
    )
    return await unsafeBurn(tokenAddress, burnAccount.burnAddress, amount, wallet, fullNode, signingEthAccount)
}


/**
 * checks that at least the PoW nonce is correct
 * and that the merkle tree is not full
 * does also check that the blindedAddressDataHash is correct!
 * @notice but can *only* be used by the one who has the viewing keys!
 * @param burnAccount
 * @param transwarpToken
 * @param amount
 * @param maxTreeDepth
 * @param difficulty
 * @returns
 */
export async function superSafeBurn(
    burnAccount: BurnAccount, amount: bigint, tokenAddress: Address, wallet: WalletClient, fullNode: PublicClient, signingEthAccount: Address,
    { difficulty, reMintLimit, maxTreeDepth, acceptedChainIds, isCrossChain }: { isCrossChain?: boolean, difficulty?: bigint, reMintLimit?: bigint, maxTreeDepth?: number, acceptedChainIds?: Hex[] } = {}
) {
    const transwarpTokenFull = getTranswarpTokenContract(tokenAddress, { wallet, public: fullNode })
    const [resolvedIsCrossChain, resolvedDifficulty, resolvedReMintLimit, resolvedMaxTreeDepth] = await Promise.all([
        isCrossChain ?? transwarpTokenFull.read.IS_CROSS_CHAIN(),
        difficulty ?? BigInt(await transwarpTokenFull.read.POW_DIFFICULTY()),
        reMintLimit ?? BigInt(await transwarpTokenFull.read.RE_MINT_LIMIT()),
        maxTreeDepth ?? await transwarpTokenFull.read.MAX_TREE_DEPTH(),
    ])
    if (resolvedIsCrossChain && !acceptedChainIds) {
        acceptedChainIds = (await getAcceptedChainIdFromContract(tokenAddress, fullNode)).map((v) => toHex(v))
    }

    await burnCheckSuperSafe(
        burnAccount, amount, tokenAddress, fullNode, signingEthAccount,
        { reMintLimit: resolvedReMintLimit as bigint, maxTreeDepth: resolvedMaxTreeDepth as number, acceptedChainIds, isCrossChain: resolvedIsCrossChain as boolean, difficulty: resolvedDifficulty as bigint }
    )

    return await unsafeBurn(tokenAddress, burnAccount.burnAddress, amount, wallet, fullNode, signingEthAccount)
}

// ── Bulk burn functions (one transferBulk tx) ────────────────────────

async function unsafeBurnBulk(recipientsAndAmounts: { burnAddress: Address, amount: bigint }[], tokenAddress: Address, wallet: WalletClient, fullNode: PublicClient, signingEthAccount: Address) {
    const transwarpTokenFull = getTranswarpTokenContract(tokenAddress, { wallet, public: fullNode })
    const burnAddresses = recipientsAndAmounts.map((item) => item.burnAddress)
    const amounts = recipientsAndAmounts.map((item) => item.amount)
    const estimatedGas = await transwarpTokenFull.estimateGas.transferBulk([burnAddresses, amounts], { account: signingEthAccount })
    return await transwarpTokenFull.write.transferBulk([burnAddresses, amounts], { account: signingEthAccount, chain: null, gas: estimatedGas * GAS_ESTIMATE_BUFFER_PERCENT / 100n })
}

export async function burnBulk(
    recipientsAndAmounts: { burnAddress: Address, amount: bigint }[], tokenAddress: Address, wallet: WalletClient, fullNode: PublicClient, signingEthAccount: Address,
    { reMintLimit, maxTreeDepth }: { reMintLimit?: bigint, maxTreeDepth?: number } = {}
) {
    if (recipientsAndAmounts.length === 0) { throw new Error("burnBulk requires at least one item") }

    const transwarpTokenFull = getTranswarpTokenContract(tokenAddress, { public: fullNode })
    const [resolvedReMintLimit, resolvedMaxTreeDepth] = await Promise.all([
        reMintLimit ?? BigInt(await transwarpTokenFull.read.RE_MINT_LIMIT()),
        maxTreeDepth ?? await transwarpTokenFull.read.MAX_TREE_DEPTH(),
    ])

    await Promise.all(recipientsAndAmounts.map((item) =>
        burnCheck(item.burnAddress, item.amount, tokenAddress, fullNode, { maxTreeDepth: resolvedMaxTreeDepth as number, reMintLimit: resolvedReMintLimit as bigint })
    ))

    return await unsafeBurnBulk(recipientsAndAmounts, tokenAddress, wallet, fullNode, signingEthAccount)
}

export async function safeBurnBulk(
    recipientsAndAmounts: { burnAccount: NotOwnedBurnAccount, amount: bigint }[], tokenAddress: Address, wallet: WalletClient, fullNode: PublicClient, signingEthAccount: Address,
    { reMintLimit, maxTreeDepth, acceptedChainIds, isCrossChain, difficulty }: { isCrossChain?: boolean, difficulty?: bigint, reMintLimit?: bigint, maxTreeDepth?: number, acceptedChainIds?: Hex[] } = {}
) {
    if (recipientsAndAmounts.length === 0) { throw new Error("safeBurnBulk requires at least one item") }

    const transwarpTokenFull = getTranswarpTokenContract(tokenAddress, { wallet, public: fullNode })
    const [resolvedIsCrossChain, resolvedDifficulty, resolvedReMintLimit, resolvedMaxTreeDepth] = await Promise.all([
        isCrossChain ?? transwarpTokenFull.read.IS_CROSS_CHAIN(),
        difficulty ?? BigInt(await transwarpTokenFull.read.POW_DIFFICULTY()),
        reMintLimit ?? BigInt(await transwarpTokenFull.read.RE_MINT_LIMIT()),
        maxTreeDepth ?? await transwarpTokenFull.read.MAX_TREE_DEPTH(),
    ])
    if (resolvedIsCrossChain && !acceptedChainIds) {
        acceptedChainIds = (await getAcceptedChainIdFromContract(tokenAddress, fullNode)).map((v) => toHex(v))
    }

    await Promise.all(recipientsAndAmounts.map((item) =>
        burnCheckSafe(item.burnAccount, item.amount, tokenAddress, fullNode, signingEthAccount, {
            reMintLimit: resolvedReMintLimit as bigint, maxTreeDepth: resolvedMaxTreeDepth as number,
            acceptedChainIds, isCrossChain: resolvedIsCrossChain as boolean, difficulty: resolvedDifficulty as bigint
        })
    ))

    return await unsafeBurnBulk(recipientsAndAmounts.map((item) => ({ burnAddress: item.burnAccount.burnAddress, amount: item.amount })), tokenAddress, wallet, fullNode, signingEthAccount)
}

export async function superSafeBurnBulk(
    recipientsAndAmounts: { burnAccount: BurnAccount, amount: bigint }[], tokenAddress: Address, wallet: WalletClient, fullNode: PublicClient, signingEthAccount: Address,
    { difficulty, reMintLimit, maxTreeDepth, acceptedChainIds, isCrossChain }: { isCrossChain?: boolean, difficulty?: bigint, reMintLimit?: bigint, maxTreeDepth?: number, acceptedChainIds?: Hex[] } = {}
) {
    if (recipientsAndAmounts.length === 0) { throw new Error("superSafeBurnBulk requires at least one item") }

    const transwarpTokenFull = getTranswarpTokenContract(tokenAddress, { wallet, public: fullNode })
    const [resolvedIsCrossChain, resolvedDifficulty, resolvedReMintLimit, resolvedMaxTreeDepth] = await Promise.all([
        isCrossChain ?? transwarpTokenFull.read.IS_CROSS_CHAIN(),
        difficulty ?? BigInt(await transwarpTokenFull.read.POW_DIFFICULTY()),
        reMintLimit ?? BigInt(await transwarpTokenFull.read.RE_MINT_LIMIT()),
        maxTreeDepth ?? await transwarpTokenFull.read.MAX_TREE_DEPTH(),
    ])
    if (resolvedIsCrossChain && !acceptedChainIds) {
        acceptedChainIds = (await getAcceptedChainIdFromContract(tokenAddress, fullNode)).map((v) => toHex(v))
    }

    await Promise.all(recipientsAndAmounts.map((item) =>
        burnCheckSuperSafe(item.burnAccount, item.amount, tokenAddress, fullNode, signingEthAccount, {
            reMintLimit: resolvedReMintLimit as bigint, maxTreeDepth: resolvedMaxTreeDepth as number,
            acceptedChainIds, isCrossChain: resolvedIsCrossChain as boolean, difficulty: resolvedDifficulty as bigint
        })
    ))

    return await unsafeBurnBulk(recipientsAndAmounts.map((item) => ({ burnAddress: item.burnAccount.burnAddress, amount: item.amount })), tokenAddress, wallet, fullNode, signingEthAccount)
}

/**
 * Generates a ZK proof and submits a self-relay transaction in one call.
 *
 * Wraps {@link createRelayerInputs} (with no `feeData`) and then submits via {@link selfRelayTx}.
 *
 * @param amount              - Amount to re-mint (required).
 * @param recipient           - Address that will receive the re-minted tokens (required).
 * @param burnViewKeyManager       - The caller's private wallet containing burn accounts and signing keys (required).
 * @param burnAddresses       - Burn addresses to spend from (required).
 * @param transwarpToken       - Contract instance for the TranswarpToken (required).
 * @param archiveNode       - Archive-node viem PublicClient used for syncing and log queries (required).
 *
 * --- Defaults via RPC call if not set ---
 * @param powDifficulty       - Proof-of-work difficulty. Defaults to on-chain value from `transwarpToken.POW_DIFFICULTY()`.
 * @param reMintLimit - Max cumulative re-mint cap. Defaults to on-chain value from `transwarpToken.RE_MINT_LIMIT()`.
 * @param fullNodeClient      - Full-node client for chainId lookup. Defaults to `archiveNode`.
 *
 * --- Defaults without RPC call ---
 * @param callData            - Arbitrary calldata forwarded after re-mint. Defaults to `"0x"` (none).
 * @param callValue           - Native value forwarded with the call. Defaults to `0`.
 * @param callCanFail         - Whether a revert in the forwarded call is tolerated. Defaults to `false`.
 * @param circuitSize         - Circuit size (number of burn-account slots). Defaults to the minimum size that fits the spend.
 * @param encryptedBlobLen    - Byte length of each encrypted total-spend blob. Defaults to `ENCRYPTED_TOTAL_MINTED_PADDING + EAS_BYTE_LEN_OVERHEAD`.
 *
 * --- Performance / caching ---
 * @param threads             - Number of worker threads for proof generation. Defaults to max available.
 * @param deploymentBlock     - Block number the contract was deployed at. Defaults to the value in `src/constants.ts`.
 * @param preSyncedTree       - A previously synced Merkle tree to avoid re-syncing from scratch.
 * @param blocksPerGetLogsReq - Max block range per `eth_getLogs` request. Defaults to 19 999.
 * @param backend             - Pre-initialized prover backend; omit to create one internally.
 *
 * --- Circuit constants (do not change unless you know what you're doing) ---
 * @param maxTreeDepth        - Maximum Merkle tree depth. Defaults to `MAX_TREE_DEPTH`. Changing this produces invalid proofs.
 */
export async function proofAndSelfRelay(
    recipient: Address,
    amount: bigint,
    burnViewKeyManager: BurnViewKeyManager,
    transwarpToken: TranswarpToken,
    archiveNode: PublicClient,
    signingEthAccount: Address,
    { burnAddresses, threads, callData = "0x", callValue = 0n, callCanFail = false, preSyncedTree, backends, deploymentBlock, blocksPerGetLogsReq, circuitSize, maxTreeDepth, encryptedBlobLen = ENCRYPTED_TOTAL_MINTED_PADDING + EAS_BYTE_LEN_OVERHEAD, powDifficulty, reMintLimit }:
        { burnAddresses?: Address[], threads?: number, callData?: Hex, callCanFail?: boolean, callValue?: bigint, preSyncedTree?: PreSyncedTree, backends?: BackendPerSize, deploymentBlock?: bigint, blocksPerGetLogsReq?: bigint, circuitSize?: number, maxTreeDepth?: number, encryptedBlobLen?: number, powDifficulty?: Hex, reMintLimit?: Hex } = {}
) {
    const chainId = BigInt(await archiveNode.getChainId())
    deploymentBlock ??= await transwarpToken.read.DEPLOYMENT_BLOCK()

    const { relayInputs: selfRelayInputs } = await createRelayerInputs(
        recipient,
        amount,
        burnViewKeyManager,
        transwarpToken.address,
        archiveNode,
        signingEthAccount,
        {
            powDifficulty,
            reMintLimit,
            chainId,
            callData,
            callValue,
            callCanFail,
            burnAddresses,
            circuitSize,
            encryptedBlobLen,
            threads,
            deploymentBlock,
            preSyncedTree,
            blocksPerGetLogsReq,
            backends,
            maxTreeDepth,
        }
    )

    return await selfRelayTx(
        selfRelayInputs,
        burnViewKeyManager.viemWallet,
    )
}

/**
 * Submits a self-relay `reMint` transaction.
 *
 * @param selfRelayInputs       - JSON-serializable relay inputs (all values are Hex strings).
 * @param wallet                - Viem WalletClient that signs and sends the transaction.
 * @param transwarpTokenContract - TranswarpToken contract instance with write access.
 */
export async function selfRelayTx(selfRelayInputs: SelfRelayInputs, wallet: WalletClient) {
    const transwarpTokenContract = getTranswarpTokenContract(selfRelayInputs.signatureInputs.contract, { wallet: wallet })
    const _totalMintedLeafs = selfRelayInputs.publicInputs.burn_data_public.map((v) => BigInt(v.total_minted_leaf))
    const _nullifiers = selfRelayInputs.publicInputs.burn_data_public.map((v) => BigInt(v.nullifier))
    const _root = BigInt(selfRelayInputs.publicInputs.root)
    const _snarkProof = selfRelayInputs.proof
    const _chainId = BigInt(selfRelayInputs.publicInputs.chain_id)
    // TODO not true. Is crossChain can be set to false. So this check can only live in BurnWallet ?
    // if(wallet.chain?.id && wallet.chain?.id !== Number(_chainId)) {throw new Error(`this proof can only be relayed in chainId ${Number(_chainId)}`)}
    const _signatureInputs =
    {
        amountToReMint: BigInt(selfRelayInputs.signatureInputs.amountToReMint),
        recipient: selfRelayInputs.signatureInputs.recipient,
        callData: selfRelayInputs.signatureInputs.callData,
        encryptedTotalMinted: selfRelayInputs.signatureInputs.encryptedTotalMinted,
        callCanFail: selfRelayInputs.signatureInputs.callCanFail,
        callValue: BigInt(selfRelayInputs.signatureInputs.callValue)

    }
    const reMintArgs = [
        _root,
        _chainId,
        _totalMintedLeafs,         // a commitment inserted in the merkle tree, tracks how much is spend after this transfer hash(prev_total_minted+amount, prev_account_nonce, viewing_key)
        _nullifiers,               // nullifies the previous account_note.  hash(prev_account_nonce, viewing_key)
        _snarkProof,
        _signatureInputs,
    ] as const
    const accountAddress = wallet.account?.address as Address
    const gas = await estimateGasCapped(() =>
        transwarpTokenContract.estimateGas.reMint(reMintArgs, { account: accountAddress, gas: GAS_LIMIT_TX })
    )
    return await transwarpTokenContract.write.reMint(reMintArgs, {
        account: accountAddress,
        gas: gas,
        chain: wallet.chain
    })
}

/**
 * Submits a relayer-paid `reMintRelayer` transaction.
 * @TODO does not check profitability
 *
 * @param relayInputs           - JSON-serializable relay inputs (all values are Hex strings).
 * @param wallet                - Viem WalletClient that signs and sends the transaction (the relayer).
 * @param transwarpTokenContract - TranswarpToken contract instance with write access.
 */
export async function relayTx(relayInputs: RelayInputs, wallet: WalletClient, account?: Address) {
    const transwarpTokenContract = getTranswarpTokenContract(relayInputs.signatureInputs.contract, { wallet: wallet })
    const _totalMintedLeafs = relayInputs.publicInputs.burn_data_public.map((v) => BigInt(v.total_minted_leaf))
    const _nullifiers = relayInputs.publicInputs.burn_data_public.map((v) => BigInt(v.nullifier))
    const _root = BigInt(relayInputs.publicInputs.root)
    const _snarkProof = relayInputs.proof
    const _chainId = BigInt(relayInputs.publicInputs.chain_id)
    // TODO not true. Is crossChain can be set to false. So this check can only live in BurnWallet ?
    // if(wallet.chain?.id && wallet.chain?.id !== Number(_chainId)) {throw new Error(`this proof can only be relayed in chainId ${Number(_chainId)}`)}
    const _signatureInputs =
    {
        amountToReMint: BigInt(relayInputs.signatureInputs.amountToReMint),
        recipient: relayInputs.signatureInputs.recipient,
        callData: relayInputs.signatureInputs.callData,
        encryptedTotalMinted: relayInputs.signatureInputs.encryptedTotalMinted,
        callCanFail: relayInputs.signatureInputs.callCanFail,
        callValue: BigInt(relayInputs.signatureInputs.callValue)

    }
    const _feeData = {
        tokensPerEthPrice: BigInt(relayInputs.signatureInputs.feeData.tokensPerEthPrice),
        maxFee: BigInt(relayInputs.signatureInputs.feeData.maxFee),
        amountForRecipient: BigInt(relayInputs.signatureInputs.feeData.amountForRecipient),
        relayerBonus: BigInt(relayInputs.signatureInputs.feeData.relayerBonus),
        estimatedGasCost: BigInt(relayInputs.signatureInputs.feeData.estimatedGasCost),
        estimatedPriorityFee: BigInt(relayInputs.signatureInputs.feeData.estimatedPriorityFee),
        refundAddress: relayInputs.signatureInputs.feeData.refundAddress,
        relayerAddress: relayInputs.signatureInputs.feeData.relayerAddress,

    }
    const reMintRelayerArgs = [
        _root,
        _chainId,
        _totalMintedLeafs,         // a commitment inserted in the merkle tree, tracks how much is spend after this transfer hash(prev_total_minted+amount, prev_account_nonce, viewing_key)
        _nullifiers,               // nullifies the previous account_note.  hash(prev_account_nonce, viewing_key)
        _snarkProof,
        _signatureInputs,
        _feeData
    ] as const
    const relayerAccount = account ?? wallet.account?.address ?? (await wallet.getAddresses())[0]
    const gas = await estimateGasCapped(() =>
        transwarpTokenContract.estimateGas.reMintRelayer(reMintRelayerArgs, { account: relayerAccount, gas: GAS_LIMIT_TX })
    )
    return await transwarpTokenContract.write.reMintRelayer(reMintRelayerArgs, {
        account: relayerAccount,
        gas: gas,
        chain: wallet.chain
    })
}

// estimateGas can over-shoot on the heavy ZK verifier path and exceed the EIP-7825 per-tx cap,
// in which case the node rejects the estimation itself. Fall back to the cap — if the real
// execution cost fits, the tx lands; if it doesn't, it'll OOG on-chain like any other over-budget tx.
async function estimateGasCapped(estimate: () => Promise<bigint>): Promise<bigint> {
    try {
        const estimated = await estimate()
        const buffered = estimated * GAS_ESTIMATE_BUFFER_PERCENT / 100n
        return buffered < GAS_LIMIT_TX ? buffered : GAS_LIMIT_TX
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        if (message.includes("cap")) return GAS_LIMIT_TX
        throw err
    }
}