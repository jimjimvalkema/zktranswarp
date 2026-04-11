import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import { network } from "hardhat";

import { deployPoseidon2Huff } from "@warptoad/gigabridge-js";

import {
    WormholeTokenContractName,
    reMint3InVerifierContractName,
    reMint32InVerifierContractName,
    reMint100InVerifierContractName,
    leanIMTPoseidon2ContractName,
    ZKTranscriptLibContractName100,
    POW_DIFFICULTY,
    RE_MINT_LIMIT,
    MAX_TREE_DEPTH,
} from "../src/constants.ts";
import { getSyncedMerkleTree } from "../src/syncing.ts";
import type { ContractReturnType } from "@nomicfoundation/hardhat-viem/types";
import { padHex, toHex, type PublicClient } from "viem";

describe("getSyncedMerkleTree", async function () {
    const { viem } = await network.connect();
    const publicClient = await viem.getPublicClient() as PublicClient;
    let wormholeToken: ContractReturnType<typeof WormholeTokenContractName>;
    const [deployer, alice, bob, carol] = await viem.getWalletClients();

    beforeEach(async function () {
        const poseidon2Create2Salt = padHex("0x00", { size: 32 });
        await deployPoseidon2Huff(publicClient, deployer, poseidon2Create2Salt);
        const leanIMTPoseidon2 = await viem.deployContract(leanIMTPoseidon2ContractName, [], { libraries: {} });
        const ZKTranscriptLib = await viem.deployContract(ZKTranscriptLibContractName100, [], { libraries: {} });
        const reMintVerifier3 = await viem.deployContract(reMint3InVerifierContractName, [], { client: { wallet: deployer }, libraries: { ZKTranscriptLib: ZKTranscriptLib.address } });
        const reMintVerifier32 = await viem.deployContract(reMint32InVerifierContractName, [], { client: { wallet: deployer }, libraries: { ZKTranscriptLib: ZKTranscriptLib.address } });
        const reMintVerifier100 = await viem.deployContract(reMint100InVerifierContractName, [], { client: { wallet: deployer }, libraries: { ZKTranscriptLib: ZKTranscriptLib.address } });

        wormholeToken = await viem.deployContract(
            WormholeTokenContractName,
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

        await wormholeToken.write.getFreeTokens([deployer.account.address]);
    });

    // a transfer from deployer (tx.origin) to a different account gets counted as a burn
    // address by the contract, so it emits a NewLeaf. Varying amounts keep leaves unique.
    async function insertLeaf(to: `0x${string}`, amount: bigint) {
        const tx = await wormholeToken.write.transfer([to, amount]);
        const receipt = await publicClient.getTransactionReceipt({ hash: tx });
        return receipt.blockNumber;
    }

    it("syncs to the current head by default", async function () {
        await insertLeaf(alice.account.address, 1n);
        await insertLeaf(bob.account.address, 2n);
        await insertLeaf(carol.account.address, 3n);

        const synced = await getSyncedMerkleTree(wormholeToken.address, publicClient);
        const onchainRoot = await wormholeToken.read.root();

        assert.equal(synced.tree.size, 3);
        assert.equal(synced.tree.root, onchainRoot);
    });

    it("syncs to an exact past block (no preSyncedTree)", async function () {
        await insertLeaf(alice.account.address, 1n);
        await insertLeaf(alice.account.address, 2n);
        const snapshotBlock = await insertLeaf(alice.account.address, 3n);
        const expectedRoot = await wormholeToken.read.root({ blockNumber: snapshotBlock });

        // keep tree growing past snapshotBlock
        await insertLeaf(bob.account.address, 10n);
        await insertLeaf(bob.account.address, 11n);

        const synced = await getSyncedMerkleTree(wormholeToken.address, publicClient, {
            syncTillBlock: snapshotBlock,
        });

        assert.equal(synced.lastSyncedBlock, snapshotBlock);
        assert.equal(synced.tree.size, 3);
        assert.equal(synced.tree.root, expectedRoot);
    });

    it("forwards a preSyncedTree to an exact newer block", async function () {
        await insertLeaf(alice.account.address, 1n);
        await insertLeaf(alice.account.address, 2n);

        const preSynced = await getSyncedMerkleTree(wormholeToken.address, publicClient);
        assert.equal(preSynced.tree.size, 2);

        await insertLeaf(bob.account.address, 10n);
        await insertLeaf(bob.account.address, 11n);
        const targetBlock = await insertLeaf(bob.account.address, 12n);
        const expectedRoot = await wormholeToken.read.root({ blockNumber: targetBlock });

        // keep tree growing past snapshotBlock
        await insertLeaf(carol.account.address, 100n);
        await insertLeaf(carol.account.address, 101n);

        const synced = await getSyncedMerkleTree(wormholeToken.address, publicClient, {
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
        const expectedRoot = await wormholeToken.read.root({ blockNumber: snapshotBlock });

        await insertLeaf(bob.account.address, 10n);
        await insertLeaf(bob.account.address, 11n);
        await insertLeaf(carol.account.address, 100n);
        await insertLeaf(carol.account.address, 101n);

        const fullySynced = await getSyncedMerkleTree(wormholeToken.address, publicClient);
        assert.equal(fullySynced.tree.size, 7);

        const rewound = await getSyncedMerkleTree(wormholeToken.address, publicClient, {
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
        const expectedRoot = await wormholeToken.read.root({ blockNumber: midBlock });

        // bump the chain forward without emitting any NewLeaf (deployer -> deployer is skipped).
        // this makes syncTillBlock strictly greater than the block of the last kept leaf.
        await wormholeToken.write.transfer([deployer.account.address, 1n]);
        const targetBlock = await publicClient.getBlockNumber();
        assert.ok(targetBlock > midBlock);

        await insertLeaf(bob.account.address, 10n);
        await insertLeaf(bob.account.address, 11n);

        const fullySynced = await getSyncedMerkleTree(wormholeToken.address, publicClient);
        assert.equal(fullySynced.tree.size, 4);

        const rewound = await getSyncedMerkleTree(wormholeToken.address, publicClient, {
            preSyncedTree: fullySynced,
            syncTillBlock: targetBlock,
        });

        assert.equal(rewound.lastSyncedBlock, targetBlock);
        assert.equal(rewound.tree.size, 2);
        assert.equal(rewound.tree.root, expectedRoot);
    });

    it("sync when there are no leafs in the tree yet", async function () {
        const expectedRoot = await wormholeToken.read.root();
        const fullySynced = await getSyncedMerkleTree(wormholeToken.address, publicClient);
        console.log({expectedRoot, fullySyncedRoot: fullySynced.tree.root})
        // TODO make pr where leanIMT does `get root() ?? 0n` by it self
        // instead of doing it every call site where `fullySynced.tree.root`
        assert.equal(fullySynced.tree.root ?? 0n, expectedRoot);
    });
});
