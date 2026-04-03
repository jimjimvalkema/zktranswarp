import type { Address, Hex, PublicClient, WalletClient } from "viem";
import { toHex } from "viem";
import type { WormholeTokenTest } from "../test/remint2.test.ts";
import type { BackendPerSize, BurnAccount, PreSyncedTree, RelayInputs, SelfRelayInputs, UnsyncedBurnAccount, WormholeToken } from "./types.ts";
import { UltraHonkBackend } from "@aztec/bb.js";
import { getDeploymentBlock } from "./syncing.ts";
import { getBurnAddressSafe, hashBlindedAddressData } from "./hashing.ts";
import { BurnViewKeyManager } from "./BurnViewKeyManager.ts";
import { EAS_BYTE_LEN_OVERHEAD, ENCRYPTED_TOTAL_MINTED_PADDING, GAS_LIMIT_TX } from "./constants.ts";
import { createRelayerInputs } from "./proving.ts";
import type { BurnWallet } from "./BurnWallet.ts";
import { getWormholeTokenContract } from "./utils.ts";


/**
 * that the merkle tree is not full and the balance of the recipient wont exceed reMintLimit
 * @notice does not check that the blindedAddressDataHash is correct!
 * TODO maybe put max tree depth in contract
 * @param burnAccount 
 * @param wormholeToken 
 * @param amount 
 * @param maxTreeDepth 
 * @param difficulty 
 * @returns 
 */
export async function burn(
    burnAddress: Address, amount: bigint, wormholeToken: WormholeTokenTest, signingEthAccount: Address,
    { difficulty, reMintLimit, maxTreeDepth }: { difficulty?: bigint, reMintLimit?: bigint, maxTreeDepth?: number } = {}
) {
    difficulty ??= BigInt(await wormholeToken.read.POW_DIFFICULTY())
    reMintLimit ??= BigInt(await wormholeToken.read.RE_MINT_LIMIT())
    maxTreeDepth ??= await wormholeToken.read.MAX_TREE_DEPTH()
    // nvm this wont result in anything dangerous
    // const nonce = await fullNode.getTransactionCount({address: burnAddress})
    // if (nonce !== 0) { throw new Error("This address has an account nonce that is not 0. This is a EOA. Please do a regular transfer instead")}
    const balance = await wormholeToken.read.balanceOf([burnAddress])
    const newBurnBalance = balance + amount
    const treeSize = await wormholeToken.read.treeSize()
    const safeDistanceFromFullTree = (35_000n / 10n) * 60n * 60n // 35_000 burn tx's for 1 hour.  assumes a 35_000 tps chain and burn txs being 10x expensive
    const fullTreeSize = 2n ** BigInt(maxTreeDepth)
    if (treeSize >= fullTreeSize) { throw new Error("Tree is FULL this tx WILL RESULT IS LOSS OF ALL FUNDS SEND. DO NOT SEND ANY BURN TRANSACTION!!!") }
    if (treeSize + safeDistanceFromFullTree >= fullTreeSize) { throw new Error("Tree is almost full and the risk is high this burn tx will result in loss of all funds send") }
    if (newBurnBalance < reMintLimit === false) { throw new Error(`This transfer will cause the balance to go over the RE_MINT_LIMIT. This wil result in LOSS OF ALL FUNDS OVER THE LIMIT!! DO NOT SEND THIS TRANSACTION!!\n new balance: ${newBurnBalance} \n limit:       ${reMintLimit}`) }
    return await (wormholeToken as WormholeTokenTest).write.transfer([burnAddress, amount], { account: signingEthAccount })

}

/**
 * checks that at least the PoW nonce is correct,
 * that the merkle tree is not full and the balance of the recipient wont exceed reMintLimit
 * @notice does not check that the blindedAddressDataHash is correct!
 * TODO maybe put max tree depth in contract
 * @param burnAccount
 * @param wormholeToken
 * @param amount
 * @param maxTreeDepth
 * @param difficulty
 * @returns
 */
export async function safeBurn(
    burnAccount: BurnAccount, amount: bigint, wormholeToken: WormholeTokenTest, signingEthAccount: Address,
    { difficulty, reMintLimit, maxTreeDepth }: { difficulty?: bigint, reMintLimit?: bigint, maxTreeDepth?: number } = {}
) {
    difficulty ??= BigInt(await wormholeToken.read.POW_DIFFICULTY())
    reMintLimit ??= BigInt(await wormholeToken.read.RE_MINT_LIMIT())
    maxTreeDepth ??= await wormholeToken.read.MAX_TREE_DEPTH()
    const burnAddress = getBurnAddressSafe({ blindedAddressDataHash: BigInt(burnAccount.blindedAddressDataHash), powNonce: BigInt(burnAccount.powNonce), difficulty: difficulty })
    const balance = await wormholeToken.read.balanceOf([burnAddress])
    const newBurnBalance = balance + amount
    const treeSize = await wormholeToken.read.treeSize()
    const safeDistanceFromFullTree = (35_000n / 10n) * 60n * 60n // 35_000 burn tx's for 1 hour.  assumes a 35_000 tps chain and burn txs being 10x expensive
    const fullTreeSize = 2n ** BigInt(maxTreeDepth)
    if (treeSize >= fullTreeSize) { throw new Error("Tree is FULL this tx WILL RESULT IS LOSS OF ALL FUNDS SEND. DO NOT SEND ANY BURN TRANSACTION!!!") }
    if (treeSize + safeDistanceFromFullTree >= fullTreeSize) { throw new Error("Tree is almost full and the risk is high this burn tx will result in loss of all funds send") }
    if (newBurnBalance < reMintLimit === false) { throw new Error(`This transfer will cause the balance to go over the RE_MINT_LIMIT. This wil result in LOSS OF ALL FUNDS OVER THE LIMIT!! DO NOT SEND THIS TRANSACTION!!\n new balance: ${newBurnBalance} \n limit:       ${reMintLimit}`) }
    return await (wormholeToken as WormholeTokenTest).write.transfer([burnAddress, amount], { account: signingEthAccount })
}


/**
 * checks that at least the PoW nonce is correct
 * and that the merkle tree is not full
 * does also check that the blindedAddressDataHash is correct!
 * @notice but can *only* be used by the one who has the viewing keys!
 * @param burnAccount
 * @param wormholeToken
 * @param amount
 * @param maxTreeDepth
 * @param difficulty
 * @returns
 */
export async function superSafeBurn(
    burnAccount: BurnAccount, amount: bigint, tokenAddress: Address, wallet: WalletClient, fullNode: PublicClient, signingEthAccount: Address,
    { difficulty, reMintLimit, maxTreeDepth }: { difficulty?: bigint, reMintLimit?: bigint, maxTreeDepth?: number } = {}
) {
    const wormholeTokenFull = getWormholeTokenContract(tokenAddress,{wallet,public:fullNode})
    difficulty ??= BigInt(await wormholeTokenFull.read.POW_DIFFICULTY())
    reMintLimit ??= BigInt(await wormholeTokenFull.read.RE_MINT_LIMIT())
    maxTreeDepth ??= await wormholeTokenFull.read.MAX_TREE_DEPTH()
    const blindedAddressDataHash = hashBlindedAddressData({ spendingPubKeyX: burnAccount.spendingPubKeyX, viewingKey: BigInt(burnAccount.viewingKey), chainId: BigInt(burnAccount.chainId) })
    const burnAddress = getBurnAddressSafe({ blindedAddressDataHash: blindedAddressDataHash, powNonce: BigInt(burnAccount.powNonce), difficulty: difficulty })
    const balance = await wormholeTokenFull.read.balanceOf([burnAddress])
    const newBurnBalance = balance + amount
    const treeSize = await wormholeTokenFull.read.treeSize()
    const safeDistanceFromFullTree = (35_000n / 10n) * 60n * 60n // 35_000 burn tx's for 1 hour.  assumes a 35_000 tps chain and burn txs being 10x expensive
    const fullTreeSize = 2n ** BigInt(maxTreeDepth)
    if (treeSize >= fullTreeSize) { throw new Error("Tree is FULL this tx WILL RESULT IS LOSS OF ALL FUNDS SEND. DO NOT SEND ANY BURN TRANSACTION!!!") }
    if (treeSize + safeDistanceFromFullTree >= fullTreeSize) { throw new Error("Tree is almost full and the risk is high this burn tx will result in loss of all funds send") }
    if (newBurnBalance < reMintLimit === false) { throw new Error(`This transfer will cause the balance to go over the RE_MINT_LIMIT. This wil result in LOSS OF ALL FUNDS OVER THE LIMIT!! DO NOT SEND THIS TRANSACTION!!\n new balance: ${newBurnBalance} \n limit:       ${reMintLimit}`) }
    return await wormholeTokenFull.write.transfer([burnAddress, amount], { account: signingEthAccount, chain:null })
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
 * @param wormholeToken       - Contract instance for the WormholeToken (required).
 * @param archiveNode       - Archive-node viem PublicClient used for syncing and log queries (required).
 *
 * --- Defaults via RPC call if not set ---
 * @param powDifficulty       - Proof-of-work difficulty. Defaults to on-chain value from `wormholeToken.POW_DIFFICULTY()`.
 * @param reMintLimit - Max cumulative re-mint cap. Defaults to on-chain value from `wormholeToken.RE_MINT_LIMIT()`.
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
    wormholeToken: WormholeToken | WormholeTokenTest,
    archiveNode: PublicClient,
    signingEthAccount: Address,
    { burnAddresses, threads, callData = "0x", callValue = 0n, callCanFail = false, preSyncedTree, backends, deploymentBlock, blocksPerGetLogsReq, circuitSize, maxTreeDepth, encryptedBlobLen = ENCRYPTED_TOTAL_MINTED_PADDING + EAS_BYTE_LEN_OVERHEAD, powDifficulty, reMintLimit }:
        { burnAddresses?: Address[], threads?: number, callData?: Hex, callCanFail?: boolean, callValue?: bigint, preSyncedTree?: PreSyncedTree, backends?: BackendPerSize, deploymentBlock?: bigint, blocksPerGetLogsReq?: bigint, circuitSize?: number, maxTreeDepth?: number, encryptedBlobLen?: number, powDifficulty?: Hex, reMintLimit?: Hex } = {}
) {
    const chainId = BigInt(await archiveNode.getChainId())
    deploymentBlock ??= getDeploymentBlock(Number(chainId))

    const { relayInputs: selfRelayInputs } = await createRelayerInputs(
        recipient,
        amount,
        burnViewKeyManager,
        wormholeToken.address,
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
 * @param wormholeTokenContract - WormholeToken contract instance with write access.
 */
export async function selfRelayTx(selfRelayInputs: SelfRelayInputs, wallet: WalletClient) {
    const wormholeTokenContract = getWormholeTokenContract(selfRelayInputs.signatureInputs.contract,{wallet:wallet})
    const _totalMintedLeafs = selfRelayInputs.publicInputs.burn_data_public.map((v) => BigInt(v.total_minted_leaf))
    const _nullifiers = selfRelayInputs.publicInputs.burn_data_public.map((v) => BigInt(v.nullifier))
    const _root = BigInt(selfRelayInputs.publicInputs.root)
    const _snarkProof = selfRelayInputs.proof
    const _signatureInputs =
    {
        amountToReMint: BigInt(selfRelayInputs.signatureInputs.amountToReMint),
        recipient: selfRelayInputs.signatureInputs.recipient,
        callData: selfRelayInputs.signatureInputs.callData,
        encryptedTotalMinted: selfRelayInputs.signatureInputs.encryptedTotalMinted,
        callCanFail: selfRelayInputs.signatureInputs.callCanFail,
        callValue: BigInt(selfRelayInputs.signatureInputs.callValue)

    }
    return await (wormholeTokenContract as WormholeTokenTest).write.reMint([
        _totalMintedLeafs,
        _nullifiers,
        _root,
        _snarkProof,
        _signatureInputs
        // estimation is some time so high it goes over the per tx limit on sepolia
        // to not scare users. we wont set the gas limit super high when the amount of _totalMintedLeafs is only 2 (circuit size)
    ], { account: wallet.account?.address as Address, gas: _totalMintedLeafs.length > 32 ? GAS_LIMIT_TX : undefined })
}

/**
 * Submits a relayer-paid `reMintRelayer` transaction.
 * @TODO does not check profitability
 *
 * @param relayInputs           - JSON-serializable relay inputs (all values are Hex strings).
 * @param wallet                - Viem WalletClient that signs and sends the transaction (the relayer).
 * @param wormholeTokenContract - WormholeToken contract instance with write access.
 */
export async function relayTx(relayInputs: RelayInputs, wallet: WalletClient, account?:Address) {
    const wormholeTokenContract = getWormholeTokenContract(relayInputs.signatureInputs.contract,{wallet:wallet})
    const _totalMintedLeafs = relayInputs.publicInputs.burn_data_public.map((v) => BigInt(v.total_minted_leaf))
    const _nullifiers = relayInputs.publicInputs.burn_data_public.map((v) => BigInt(v.nullifier))
    const _root = BigInt(relayInputs.publicInputs.root)
    const _snarkProof = relayInputs.proof
    const _signatureInputs =
    {
        amountToReMint: BigInt(relayInputs.signatureInputs.amountToReMint),
        recipient: relayInputs.signatureInputs.recipient,
        callData: relayInputs.signatureInputs.callData,
        encryptedTotalMinted: relayInputs.signatureInputs.encryptedTotalMinted,
        callCanFail: relayInputs.signatureInputs.callCanFail,
        callValue: BigInt(relayInputs.signatureInputs.callValue)

    }
    const feeData = {
        tokensPerEthPrice: BigInt(relayInputs.signatureInputs.feeData.tokensPerEthPrice),
        maxFee: BigInt(relayInputs.signatureInputs.feeData.maxFee),
        amountForRecipient: BigInt(relayInputs.signatureInputs.feeData.amountForRecipient),
        relayerBonus: BigInt(relayInputs.signatureInputs.feeData.relayerBonus),
        estimatedGasCost: BigInt(relayInputs.signatureInputs.feeData.estimatedGasCost),
        estimatedPriorityFee: BigInt(relayInputs.signatureInputs.feeData.estimatedPriorityFee),
        refundAddress: relayInputs.signatureInputs.feeData.refundAddress,
        relayerAddress: relayInputs.signatureInputs.feeData.relayerAddress,

    }
    return await (wormholeTokenContract as WormholeTokenTest).write.reMintRelayer([
        _totalMintedLeafs,
        _nullifiers,
        _root,
        _snarkProof,
        _signatureInputs,
        feeData
        // estimation is some time so high it goes over the per tx limit on sepolia
        // to not scare users. we wont set the gas limit super high when the amount of _totalMintedLeafs is only 2 (circuit size)
    ], {
        account: account ?? wallet.account?.address ?? (await wallet.getAddresses())[0] , 
        gas: _totalMintedLeafs.length > 32 ? GAS_LIMIT_TX : undefined 
    })
}