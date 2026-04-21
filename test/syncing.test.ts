import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import { network } from "hardhat";

import { deployPoseidon2Huff } from "@warptoad/gigabridge-js";

import {
    TranswarpTokenContractName,
    reMint3InVerifierContractName,
    reMint32InVerifierContractName,
    reMint100InVerifierContractName,
    leanIMTPoseidon2ContractName,
    ZKTranscriptLibContractName100,
    POW_DIFFICULTY,
    RE_MINT_LIMIT,
    MAX_TREE_DEPTH,
} from "../src/constants.ts";
import { getSyncedMerkleTree, syncBurnAccount } from "../src/syncing.ts";
import type { BurnAccount } from "../src/types.ts";
import { BurnWallet } from "../src/BurnWallet.ts";
import type { ContractReturnType } from "@nomicfoundation/hardhat-viem/types";
import { getAddress, padHex, toHex, type PublicClient } from "viem";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { getBurnState } from "../src/utils.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PRE_MADE_BURN_ACCOUNTS = await readFile(join(__dirname, "./data/privateDataAlice.json"), { encoding: "utf-8" });

describe("syncing", async function () {
    const { viem } = await network.connect();
    const publicClient = await viem.getPublicClient() as PublicClient;
    let transwarpToken: ContractReturnType<typeof TranswarpTokenContractName>;
    const [deployer, alice, bob, carol, relayer, feeEstimator] = await viem.getWalletClients()

    beforeEach(async function () {
        const poseidon2Create2Salt = padHex("0x00", { size: 32 });
        await deployPoseidon2Huff(publicClient, deployer, poseidon2Create2Salt);
        const leanIMTPoseidon2 = await viem.deployContract(leanIMTPoseidon2ContractName, [], { libraries: {} });
        const ZKTranscriptLib = await viem.deployContract(ZKTranscriptLibContractName100, [], { libraries: {} });
        const reMintVerifier3 = await viem.deployContract(reMint3InVerifierContractName, [], { client: { wallet: deployer }, libraries: { ZKTranscriptLib: ZKTranscriptLib.address } });
        const reMintVerifier32 = await viem.deployContract(reMint32InVerifierContractName, [], { client: { wallet: deployer }, libraries: { ZKTranscriptLib: ZKTranscriptLib.address } });
        const reMintVerifier100 = await viem.deployContract(reMint100InVerifierContractName, [], { client: { wallet: deployer }, libraries: { ZKTranscriptLib: ZKTranscriptLib.address } });

        transwarpToken = await viem.deployContract(
            TranswarpTokenContractName,
            [
                toHex(POW_DIFFICULTY, { size: 32 }),
                RE_MINT_LIMIT,
                MAX_TREE_DEPTH,
                false,
                "TWRP",
                "zkTransWarpTestToken",
                "1",
                [
                    { contractAddress: reMintVerifier3.address, size: 3 },
                    { contractAddress: reMintVerifier32.address, size: 32 },
                    { contractAddress: reMintVerifier100.address, size: 100 },
                ],
                [],
            ],
            {
                client: { wallet: deployer },
                libraries: { leanIMTPoseidon2: leanIMTPoseidon2.address },
            },
        );

        await transwarpToken.write.getFreeTokens([deployer.account.address]);
    });

    // a transfer from deployer (tx.origin) to a different account gets counted as a burn
    // address by the contract, so it emits a NewLeaf. Varying amounts keep leaves unique.
    async function insertLeaf(to: `0x${string}`, amount: bigint) {
        const tx = await transwarpToken.write.transfer([to, amount]);
        const receipt = await publicClient.getTransactionReceipt({ hash: tx });
        return receipt.blockNumber;
    }

    it("syncs to the current head by default", async function () {
        await insertLeaf(alice.account.address, 1n);
        await insertLeaf(bob.account.address, 2n);
        await insertLeaf(carol.account.address, 3n);

        const synced = await getSyncedMerkleTree(transwarpToken.address, publicClient);
        const onchainRoot = await transwarpToken.read.root();

        assert.equal(synced.tree.size, 3);
        assert.equal(synced.tree.root, onchainRoot);
    });

    it("syncs to an exact past block (no preSyncedTree)", async function () {
        await insertLeaf(alice.account.address, 1n);
        await insertLeaf(alice.account.address, 2n);
        const snapshotBlock = await insertLeaf(alice.account.address, 3n);
        const expectedRoot = await transwarpToken.read.root({ blockNumber: snapshotBlock });

        // keep tree growing past snapshotBlock
        await insertLeaf(bob.account.address, 10n);
        await insertLeaf(bob.account.address, 11n);

        const synced = await getSyncedMerkleTree(transwarpToken.address, publicClient, {
            syncTillBlock: snapshotBlock,
        });

        assert.equal(synced.lastSyncedBlock, snapshotBlock);
        assert.equal(synced.tree.size, 3);
        assert.equal(synced.tree.root, expectedRoot);
    });

    it("forwards a preSyncedTree to an exact newer block", async function () {
        await insertLeaf(alice.account.address, 1n);
        await insertLeaf(alice.account.address, 2n);

        const preSynced = await getSyncedMerkleTree(transwarpToken.address, publicClient);
        assert.equal(preSynced.tree.size, 2);

        await insertLeaf(bob.account.address, 10n);
        await insertLeaf(bob.account.address, 11n);
        const targetBlock = await insertLeaf(bob.account.address, 12n);
        const expectedRoot = await transwarpToken.read.root({ blockNumber: targetBlock });

        // keep tree growing past snapshotBlock
        await insertLeaf(carol.account.address, 100n);
        await insertLeaf(carol.account.address, 101n);

        const synced = await getSyncedMerkleTree(transwarpToken.address, publicClient, {
            preSyncedTree: preSynced,
            syncTillBlock: targetBlock,
        });

        assert.equal(synced.lastSyncedBlock, targetBlock);
        assert.equal(synced.tree.size, 5);
        assert.equal(synced.tree.root, expectedRoot);
    });

    it("rewinds a preSyncedTree that is ahead of syncTillBlock", async function () {
        await insertLeaf(alice.account.address, 1n);
        await insertLeaf(alice.account.address, 2n);
        const snapshotBlock = await insertLeaf(alice.account.address, 3n);
        const expectedRoot = await transwarpToken.read.root({ blockNumber: snapshotBlock });

        await insertLeaf(bob.account.address, 10n);
        await insertLeaf(bob.account.address, 11n);
        await insertLeaf(carol.account.address, 100n);
        await insertLeaf(carol.account.address, 101n);

        const fullySynced = await getSyncedMerkleTree(transwarpToken.address, publicClient);
        assert.equal(fullySynced.tree.size, 7);

        const rewound = await getSyncedMerkleTree(transwarpToken.address, publicClient, {
            preSyncedTree: fullySynced,
            syncTillBlock: snapshotBlock,
        });

        assert.equal(rewound.lastSyncedBlock, snapshotBlock);
        assert.equal(rewound.tree.size, 3);
        assert.equal(rewound.tree.root, expectedRoot);
    });

    it("rewinds to a block that falls between two NewLeaf events", async function () {
        await insertLeaf(alice.account.address, 1n);
        const midBlock = await insertLeaf(alice.account.address, 2n);
        const expectedRoot = await transwarpToken.read.root({ blockNumber: midBlock });

        // bump the chain forward without emitting any NewLeaf (deployer -> deployer is skipped).
        // this makes syncTillBlock strictly greater than the block of the last kept leaf.
        await transwarpToken.write.transfer([deployer.account.address, 1n]);
        const targetBlock = await publicClient.getBlockNumber();
        assert.ok(targetBlock > midBlock);

        await insertLeaf(bob.account.address, 10n);
        await insertLeaf(bob.account.address, 11n);

        const fullySynced = await getSyncedMerkleTree(transwarpToken.address, publicClient);
        assert.equal(fullySynced.tree.size, 4);

        const rewound = await getSyncedMerkleTree(transwarpToken.address, publicClient, {
            preSyncedTree: fullySynced,
            syncTillBlock: targetBlock,
        });

        assert.equal(rewound.lastSyncedBlock, targetBlock);
        assert.equal(rewound.tree.size, 2);
        assert.equal(rewound.tree.root, expectedRoot);
    });

    it("sync when there are no leafs in the tree yet", async function () {
        const expectedRoot = await transwarpToken.read.root();
        const fullySynced = await getSyncedMerkleTree(transwarpToken.address, publicClient);
        // TODO make pr where leanIMT does `get root() ?? 0n` by it self
        // instead of doing it every call site where `fullySynced.tree.root`
        assert.equal(fullySynced.tree.root ?? 0n, expectedRoot);
    });

    // --- syncBurnAccount -----------------------------------------------------

    async function makeAliceBurnAccount() {
        const chainId = await publicClient.getChainId();
        const aliceBurnWallet = new BurnWallet(alice, { archiveNodes: { [chainId]: publicClient }, acceptedChainIds: [chainId] });
        // import pre-generated burn accounts so we skip PoW
        await aliceBurnWallet.importWallet(PRE_MADE_BURN_ACCOUNTS, transwarpToken.address);
        const aliceBurnAccount = await aliceBurnWallet.createBurnAccount(transwarpToken.address, { viewingKeyIndex: 0 });
        return { aliceBurnWallet, aliceBurnAccount, chainId };
    }

    async function burnTo(burnAddress: `0x${string}`, amount: bigint) {
        const tx = await transwarpToken.write.transfer([burnAddress, amount]);
        const receipt = await publicClient.getTransactionReceipt({ hash: tx });
        return receipt.blockNumber;
    }

    it("syncBurnAccount: totalBurned = 0 when nothing has been burned", async function () {
        const { aliceBurnAccount, chainId } = await makeAliceBurnAccount();

        const synced = await syncBurnAccount(aliceBurnAccount, transwarpToken.address, publicClient);
        const state = getBurnState(synced, chainId, transwarpToken.address);

        assert.equal(BigInt(state.totalBurned), 0n);
        assert.equal(BigInt(state.totalMinted), 0n);
        assert.equal(BigInt(state.accountNonce), 0n);
        assert.equal(BigInt(state.spendableBalance), 0n);
    });

    it("syncBurnAccount: syncs totalBurned at the current head by default", async function () {
       const { aliceBurnAccount, chainId } = await makeAliceBurnAccount();

        await burnTo(aliceBurnAccount.burnAddress, 100n);
        await burnTo(aliceBurnAccount.burnAddress, 200n);
        await burnTo(aliceBurnAccount.burnAddress, 300n);

        const synced = await syncBurnAccount(aliceBurnAccount, transwarpToken.address, publicClient);
        const state = getBurnState(synced, chainId, transwarpToken.address);

        assert.equal(BigInt(state.totalBurned), 600n);
        assert.equal(BigInt(state.spendableBalance), 600n);
    });

    it("syncBurnAccount: syncs to an exact past block", async function () {
       const { aliceBurnAccount, chainId } = await makeAliceBurnAccount();

        await burnTo(aliceBurnAccount.burnAddress, 100n);
        const snapshotBlock = await burnTo(aliceBurnAccount.burnAddress, 200n);
        // activity past the snapshot — must be excluded
        await burnTo(aliceBurnAccount.burnAddress, 300n);
        await burnTo(aliceBurnAccount.burnAddress, 400n);

        const synced = await syncBurnAccount(aliceBurnAccount, transwarpToken.address, publicClient, {
            syncTillBlock: snapshotBlock,
        });
        const state = getBurnState(synced, chainId, transwarpToken.address);

        assert.equal(BigInt(state.totalBurned), 300n);
        assert.equal(BigInt(state.lastSyncedBlock), snapshotBlock);
    });

    it("syncBurnAccount: syncs to a block before any burn happened", async function () {
       const { aliceBurnAccount, chainId } = await makeAliceBurnAccount();

        // empty-contract block — the burn account should look untouched here
        const preBurnBlock = await publicClient.getBlockNumber();

        await burnTo(aliceBurnAccount.burnAddress, 100n);
        await burnTo(aliceBurnAccount.burnAddress, 200n);

        const synced = await syncBurnAccount(aliceBurnAccount, transwarpToken.address, publicClient, {
            syncTillBlock: preBurnBlock,
        });
        const state = getBurnState(synced, chainId, transwarpToken.address);

        assert.equal(BigInt(state.totalBurned), 0n);
        assert.equal(BigInt(state.lastSyncedBlock), preBurnBlock);
    });

    it("syncBurnAccount: rewinds a previously-synced account to an earlier block", async function () {
       const { aliceBurnAccount, chainId } = await makeAliceBurnAccount();

        await burnTo(aliceBurnAccount.burnAddress, 100n);
        const snapshotBlock = await burnTo(aliceBurnAccount.burnAddress, 200n);
        await burnTo(aliceBurnAccount.burnAddress, 300n);
        await burnTo(aliceBurnAccount.burnAddress, 400n);

        // first sync all the way forward
        const fullySynced = await syncBurnAccount(aliceBurnAccount, transwarpToken.address, publicClient);
        const syncedState = getBurnState(fullySynced, chainId, transwarpToken.address);
        assert.equal(BigInt(syncedState.totalBurned), 1000n);

        // then re-sync the same account back to an earlier block
        const rewoundAccount = await syncBurnAccount(fullySynced, transwarpToken.address, publicClient, {
            syncTillBlock: snapshotBlock,
        });
        const rewoundState = getBurnState(rewoundAccount, chainId, transwarpToken.address);

        assert.equal(BigInt(rewoundState.totalBurned), 300n);
        assert.equal(BigInt(rewoundState.lastSyncedBlock), snapshotBlock);
        assert.equal(BigInt(rewoundState.accountNonce), 0n);
    });
});
