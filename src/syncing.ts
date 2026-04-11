import { queryEventInChunks } from "@warptoad/gigabridge-js/viem-utils"
import type { LeanIMTHashFunction } from "@zk-kit/lean-imt"
import { LeanIMT } from "@zk-kit/lean-imt"
import type { Address, Hex, PublicClient, WalletClient } from "viem"
import { bytesToHex, concatHex, getAddress, getContract, hexToBytes, sliceHex, toHex } from "viem"
import { ENCRYPTED_TOTAL_MINTED_PADDING } from "./constants.ts"
import type { BurnAccount, PreSyncedTree, SyncedBurnAccount, WormholeToken } from "./types.ts"
import { poseidon2Hash } from "@zkpassport/poseidon2"
import { hashNullifier } from "./hashing.ts"
import { BurnViewKeyManager } from "./BurnViewKeyManager.ts"
import { getAllBurnAccounts, getWormholeTokenContract, wormholeTokenAbi } from "./utils.ts"

export const poseidon2IMTHashFunc: LeanIMTHashFunction = (a: bigint, b: bigint) => poseidon2Hash([a, b])

export async function getSyncedMerkleTree(
    tokenAddress: Address, archiveNode: PublicClient,
    { syncTillBlock, fullNode, preSyncedTree, deploymentBlock, blocksPerGetLogsReq }: { syncTillBlock?: bigint, fullNode?: PublicClient, preSyncedTree?: PreSyncedTree, deploymentBlock?: bigint, blocksPerGetLogsReq?: bigint } = {}
) {
    fullNode ??= archiveNode;
    const wormholeTokenFull = getWormholeTokenContract(tokenAddress, { public: fullNode })
    const wormholeTokenArchive = getWormholeTokenContract(tokenAddress, { public: archiveNode })
    deploymentBlock ??= await wormholeTokenFull.read.DEPLOYMENT_BLOCK()
    let firstSyncBlock = deploymentBlock
    let originalStartSyncBlock = deploymentBlock
    let preSyncedLeaves: bigint[] = []
    const isAlreadySynced: boolean = (syncTillBlock !== undefined && preSyncedTree !== undefined && preSyncedTree.lastSyncedBlock > syncTillBlock)

    if (preSyncedTree) {
        // check preSyncedTree 
        if (preSyncedTree.firstSyncedBlock > deploymentBlock) { throw new Error(`preSyncedTree is not synced from deployment block (${deploymentBlock}), this is not supported`) }
        if (preSyncedTree.firstSyncedBlock < deploymentBlock) { console.warn(`preSyncedTree has been synced from a block before deployment block. Is this the right tree?`) }
        const isValidRoot = Boolean(preSyncedTree.tree.root) && await wormholeTokenFull.read.roots([preSyncedTree.tree.root]);
        const neverBeenSynced = preSyncedTree.lastSyncedBlock === preSyncedTree.firstSyncedBlock;
        if (isValidRoot === false && neverBeenSynced === false) { throw new Error(`preSyncedTrees root is not in the "roots" mapping of tree onchain. preSyncedTreeRoot: ${preSyncedTree.tree.root}, lastPreSyncedBlockNumber:${preSyncedTree.lastSyncedBlock}`) }

        // use preSyncedTree data. lastSyncedBlock was inclusive and so is firstSyncBlock. So +1n
        firstSyncBlock = preSyncedTree.lastSyncedBlock + 1n
        originalStartSyncBlock = preSyncedTree.firstSyncedBlock
        preSyncedLeaves = preSyncedTree.tree.leaves;
        // detect if preSyncedTree was synced too far ahead
        if (isAlreadySynced) {

            // get's last event happened since block: syncTillBlock
            // get that leaf. And remove all leaves that happened after that leaf
            const lastLeafAtBlock = await queryEventInChunks({
                publicClient: archiveNode,
                contract: wormholeTokenArchive,
                eventName: "NewLeaf",
                reverseOrder: true,
                maxEvents: 1,
                lastBlock: syncTillBlock,
                chunkSize: blocksPerGetLogsReq,
            })
            if (lastLeafAtBlock[0]) {
                const lastLeaf = lastLeafAtBlock[0].args.leaf
                const lastIndex = preSyncedLeaves.lastIndexOf(lastLeaf)
                preSyncedLeaves = preSyncedLeaves.toSpliced(lastIndex + 1)

            } else {
                // no leaves
                preSyncedLeaves = []
            }

        }
    }

    // sync it
    let leafs
    if (isAlreadySynced) {
        leafs = preSyncedLeaves
    } else {
        const timeBefore = Date.now()
        syncTillBlock ??= BigInt(await fullNode.getBlockNumber())
        console.log(`syncing merkle tree from ${firstSyncBlock} till ${syncTillBlock}`)
        // TODO: queryEventInChunks has a bug where firstBlock === lastBlock produces 0 iterations.
        // Adding 1n to lastBlock works around this since getLogs toBlock is inclusive anyway,
        // and the extra block is either empty or not yet mined.
        const events = await queryEventInChunks({
            publicClient: archiveNode,
            contract: wormholeTokenArchive,
            eventName: "NewLeaf",
            firstBlock: firstSyncBlock,
            lastBlock: syncTillBlock,
            chunkSize: blocksPerGetLogsReq,
        })
        console.log(`done syncing merkle tree from ${firstSyncBlock} till ${syncTillBlock} \n it took: ${Date.now() - timeBefore} ms`)
        // formatting
        const sortedEvents = events.sort((a: any, b: any) => Number(a.args.index - b.args.index))
        leafs = [...preSyncedLeaves, ...sortedEvents.map((event) => event.args.leaf)]

    }

    const tree = new LeanIMT(poseidon2IMTHashFunc, leafs)
    

    // check root against chain
    const isValidRoot = await wormholeTokenArchive.read.root({blockNumber:syncTillBlock}) === (tree.root ?? 0n)
    if (isValidRoot === false) { throw new Error(`getSyncedMerkleTree synced but got invalid root`) }

    return { tree, lastSyncedBlock: syncTillBlock, firstSyncedBlock: originalStartSyncBlock } as PreSyncedTree
}

async function encrypt({ plaintext, viewingKey, padding = ENCRYPTED_TOTAL_MINTED_PADDING }: { plaintext: string, viewingKey: bigint, padding?: number }): Promise<Hex> {
    if (plaintext.length > padding) {
        throw new Error(`Plaintext too long: ${plaintext.length} > ${padding}`)
    }
    const padded = plaintext.padEnd(padding, '\0')

    const iv = crypto.getRandomValues(new Uint8Array(12))

    const key = await crypto.subtle.importKey(
        'raw',
        hexToBytes(toHex(viewingKey, { size: 32 })).slice(),
        'AES-GCM',
        false,
        ['encrypt']
    )

    const encrypted = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv },
        key,
        new TextEncoder().encode(padded)
    )

    const encryptedBlob = concatHex([
        bytesToHex(iv),
        bytesToHex(new Uint8Array(encrypted))
    ])

    return encryptedBlob
}

async function decrypt({ viewingKey, cipherText }: { viewingKey: bigint, cipherText: Hex }) {
    const iv = hexToBytes(sliceHex(cipherText, 0, 12)).slice()
    const encrypted = hexToBytes(sliceHex(cipherText, 12)).slice()

    const key = await crypto.subtle.importKey(
        'raw',
        hexToBytes(toHex(viewingKey, { size: 32 })).slice(),
        'AES-GCM',
        false,
        ['decrypt']
    )

    const decrypted = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv },
        key,
        encrypted
    )

    return new TextDecoder().decode(decrypted).replace(/\0+$/, '')
}

export async function encryptTotalMinted({ viewingKey, amount }: { viewingKey: bigint, amount: bigint }): Promise<Hex> {
    const json = { totalMinted: toHex(amount, { size: 32 }) }
    return await encrypt({ plaintext: JSON.stringify(json), viewingKey })
}

export async function decryptTotalMinted({ viewingKey, totalMintedEncrypted }: { viewingKey: bigint, totalMintedEncrypted: Hex }): Promise<bigint> {
    const decryptedJson = JSON.parse(await decrypt({ viewingKey: viewingKey, cipherText: totalMintedEncrypted }))
    return BigInt(decryptedJson.totalMinted)
}


/**
 * @TODO make version that works without archive node. Although that one is clumsy to use, it might be use full for user to be able to sync without archive node
 * @param burnAccount 
 * @param tokenAddress 
 * @param archiveNode 
 * @param param3 
 * @returns 
 */
export async function syncBurnAccount(burnAccount: BurnAccount, tokenAddress: Address, archiveNode: PublicClient, {syncTillBlock, maxNonce, chainId }: {syncTillBlock?:bigint, maxNonce?: bigint, chainId?: Hex } = {}
): Promise<SyncedBurnAccount> {
    tokenAddress = getAddress(tokenAddress)
    chainId ??= toHex(await archiveNode.getChainId())
    syncTillBlock ??= await archiveNode.getBlockNumber()
    const wormholeTokenArchive = getWormholeTokenContract(tokenAddress, { public: archiveNode })

    const viewingKey = BigInt(burnAccount.viewingKey)
    const prevSyncFields = burnAccount.syncData?.[chainId]?.[tokenAddress]
    const initialAccountNonce = BigInt(prevSyncFields?.accountNonce ?? 0n)
    let accountNonce = initialAccountNonce
    //accountNonce = accountNonce === 0n ? 0n : accountNonce - 1n
    let totalMinted = BigInt(prevSyncFields?.totalMinted ?? 0n)
    let isNullified: boolean | null = null;
    let lastSpendBlockNum: bigint | null = null
    let lastNullifier: bigint | null = null;

    const totalBurned = await wormholeTokenArchive.read.balanceOf([burnAccount.burnAddress], {blockNumber:syncTillBlock});
    // nothing burned = nothing spent = nothing to sync
    if (totalBurned !== 0n) {
        while ((isNullified || isNullified === null) && (maxNonce === undefined || accountNonce < maxNonce)) {
            const nullifier = hashNullifier({ accountNonce: accountNonce, viewingKey: viewingKey })
            const nullifiedAtBlock = await wormholeTokenArchive.read.nullifiers([nullifier], {blockNumber:syncTillBlock})
            // if not nullified
            if (nullifiedAtBlock === 0n) {
                // we are at the first iteration and accountNonce is not at 0. 
                // this means the account was previously synced, and didn't need another sync
                const wasPreviouslySynced = isNullified === null && accountNonce !== 0n;
                if (wasPreviouslySynced) {
                    const prevNullifier = hashNullifier({ accountNonce: accountNonce - 1n, viewingKey: viewingKey })
                    // another rpc call but trust me i got stuck on this stupid ah bug for hours and it took claude a while to find it as well 
                    const prevNullifiedAtBlock = await wormholeTokenArchive.read.nullifiers([prevNullifier], {blockNumber:syncTillBlock})
                    if (prevNullifiedAtBlock === 0n) {
                        throw new Error(`
                        provided burnAccount has an invalid accountNonce. Account nonce was set to a non 0 number but it's previous nonce was not nullified
                        previous nonce expected to be nullified: ${toHex(prevNullifier, { size: 32 })} (accountNonce: ${accountNonce - 1n})
                        current nonce nullifier: ${toHex(nullifier, { size: 32 })} (accountNonce: ${accountNonce})
                        
                        burnAccount: 
                        ${JSON.stringify(burnAccount)}
                        `)
                    }
                }
                break
            }
            isNullified = nullifiedAtBlock > 0n
            accountNonce += 1n
            lastSpendBlockNum = nullifiedAtBlock
            lastNullifier = nullifier
        }
        // the above loop will have lastSpendBlockNum and lastNullifier. Set to 0n, if the account is already synced.
        // so we need to skip getContractEvents since no event is at block 0 and we don't need totalMintedEncrypted, we are already synced
        if (accountNonce > initialAccountNonce) {
            if (lastSpendBlockNum === null) {
                throw new Error("nullifiedAtBlock can't be null")
            } else {
                const logs = await archiveNode.getContractEvents({
                    address: tokenAddress,
                    abi: wormholeTokenAbi,
                    eventName: "Nullified",
                    fromBlock: lastSpendBlockNum,
                    toBlock: lastSpendBlockNum,
                    args: {
                        nullifier: lastNullifier,
                    },
                })
                const totalMintedEncrypted = logs[0].args.encryptedTotalMinted as Hex;
                totalMinted = await decryptTotalMinted({ totalMintedEncrypted: totalMintedEncrypted, viewingKey: BigInt(viewingKey) });
            }
        }
    }

    const nothingHappened = totalBurned === 0n || prevSyncFields?.totalBurned !== undefined && totalBurned === BigInt(prevSyncFields.totalBurned) && initialAccountNonce === accountNonce
    const syncedBurnAccount = burnAccount as SyncedBurnAccount
    syncedBurnAccount.syncData ??= {}
    syncedBurnAccount.syncData[chainId] ??= {}
    const lastSyncedBlock = toHex(syncTillBlock)
    syncedBurnAccount.syncData[chainId][tokenAddress] = {
        totalMinted: toHex(totalMinted),
        accountNonce: toHex(accountNonce),
        totalBurned: toHex(totalBurned),
        spendableBalance: toHex(totalBurned - totalMinted),
        lastSyncedBlock,
        // TODO maybe remove minProvableBlock, technically it's the last block accountNonce got update or the last tx the burn account received. Which ever is lowest. But then i need to scan for that tx when it received something. Not worth the rpc calls
        // Nothing happened rule also works, but not totally accurate. It's never too low, but usually too high. Maybe not minProvableBlock, but knownLowSafeProvableBlock. You can look for lower if you want
        minProvableBlock: nothingHappened && prevSyncFields?.lastSyncedBlock !== undefined ? prevSyncFields.lastSyncedBlock : lastSyncedBlock,
    }
    return syncedBurnAccount
}

/**
 * @TODO return at what block it's synced
 * defaults to syncing all burn accounts
 * @notice sync concurrently all accounts, this might overwhelm rpcs
 * @notice When using UnknownBurnAccount this becomes O(n × m). It uses `BurnViewKeyManager.updateBurnAccount` which will loop over all unknown burnAccounts to find which one to update
 * This is not an issue in most cases () but when using singe use burn accounts (for relayer refunds for example), or as utxo's, pls use the DerivedBurnAccount type.
 * TODO use p-limit
 * TODO make walletObject that has syncBurnAccount in it so importBurnAccount is not used since it will do checks in the future (which are redundant rn)
 * @param param0 
 * @returns 
 */
export async function syncMultipleBurnAccounts(
    burnViewKeyManager: BurnViewKeyManager, tokenAddress: Address, archiveNode: PublicClient,
    {syncTillBlock, burnAddressesToSync, ethAccounts, maxNonce, chainId }: {syncTillBlock?:bigint, maxNonce?: bigint, ethAccounts?: Address[], burnAddressesToSync?: Address[], chainId?: Hex }={}) {
    const allBurnAccounts = getAllBurnAccounts(burnViewKeyManager.privateData, { ethAccounts })
    burnAddressesToSync = burnAddressesToSync ? burnAddressesToSync.map((a) => getAddress(a)) : allBurnAccounts.map((v) => getAddress(v.burnAddress))
    const syncedBurnAccounts = await Promise.all(allBurnAccounts.map((burnAccount) => {
        if (burnAddressesToSync.includes(getAddress(burnAccount.burnAddress))) {
            return syncBurnAccount(burnAccount, tokenAddress, archiveNode, { maxNonce, chainId, syncTillBlock})
        } else {
            return burnAccount
        }
    }))
    await Promise.all(syncedBurnAccounts.map((burnAccount) => burnViewKeyManager.updateBurnAccount(burnAccount)))
    return burnViewKeyManager
}