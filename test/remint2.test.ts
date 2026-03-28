import assert from "node:assert/strict";
import { beforeEach, describe, it, after } from "node:test";

import { network } from "hardhat";

// TODO fix @warptoad/gigabridge-js why it doesn't automatically gets @aztec/aztec.js
import { deployPoseidon2Huff } from "@warptoad/gigabridge-js"

import { FIELD_LIMIT, WormholeTokenContractName, reMint2InVerifierContractName, reMint32InVerifierContractName, reMint100InVerifierContractName, leanIMTPoseidon2ContractName, ZKTranscriptLibContractName100, POW_DIFFICULTY, RE_MINT_LIMIT, MAX_TREE_DEPTH } from "../src/constants.ts";
import { getSyncedMerkleTree } from "../src/syncing.ts";
//import { noir_test_main_self_relay, noir_verify_sig } from "../src/noirtests.js";
import { getBackend } from "../src/proving.ts";
import type { ContractReturnType } from "@nomicfoundation/hardhat-viem/types";
import { proofAndSelfRelay, relayTx, safeBurn, superSafeBurn } from "../src/transact.ts";
import { BurnWallet } from "../src/BurnWallet.ts";
import { getContract, padHex, parseEventLogs, toHex, type Hash, type Hex } from "viem";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const path =  join(__dirname, './data/privateDataAlice.json')

const CIRCUIT_SIZE = 2;
const provingThreads = 1 //1; //undefined  // giving the backend more threads makes it hang and impossible to debug // set to undefined to use max threads available
const PRE_MADE_BURN_ACCOUNTS = await readFile(path, { encoding: "utf-8" })

export type WormholeTokenTest = ContractReturnType<typeof WormholeTokenContractName>


let gas: any = { "transfers": {} }
describe("Token", async function () {
    const SNARK_SCALAR_FIELD = BigInt("21888242871839275222246405745257275088548364400416034343698204186575808495617")

    const { viem } = await network.connect();
    const publicClient = await viem.getPublicClient();
    let wormholeToken: ContractReturnType<typeof WormholeTokenContractName>;
    let reMintVerifier2: ContractReturnType<typeof reMint2InVerifierContractName>;
    let reMintVerifier32: ContractReturnType<typeof reMint32InVerifierContractName>;
    let reMintVerifier100: ContractReturnType<typeof reMint100InVerifierContractName>;
    let leanIMTPoseidon2: ContractReturnType<typeof leanIMTPoseidon2ContractName>;
    let powDifficulty = 0n
    const circuitBackend = await getBackend(CIRCUIT_SIZE, provingThreads);
    const [deployer, alice, bob, carol, relayer, feeEstimator] = await viem.getWalletClients()
    //let feeEstimatorPrivate: UnsyncedPrivateWallet


    beforeEach(async function () {
        const poseidon2Create2Salt = padHex("0x00", { size: 32 })
        await deployPoseidon2Huff(publicClient, deployer, poseidon2Create2Salt)
        leanIMTPoseidon2 = await viem.deployContract(leanIMTPoseidon2ContractName, [], { libraries: {} });
        const ZKTranscriptLib = await viem.deployContract(ZKTranscriptLibContractName100, [], { libraries: {} });
        reMintVerifier2 = await viem.deployContract(reMint2InVerifierContractName, [], { client: { wallet: deployer }, libraries: { ZKTranscriptLib: ZKTranscriptLib.address } });
        reMintVerifier32 = await viem.deployContract(reMint32InVerifierContractName, [], { client: { wallet: deployer }, libraries: { ZKTranscriptLib: ZKTranscriptLib.address } });
        reMintVerifier100 = await viem.deployContract(reMint100InVerifierContractName, [], { client: { wallet: deployer }, libraries: { ZKTranscriptLib: ZKTranscriptLib.address } });
        //PrivateTransferVerifier = await viem.deployContract(PrivateTransferVerifierContractName, [], { client: { wallet: deployer }, libraries: { } });
        wormholeToken = await viem.deployContract(
            WormholeTokenContractName,
            [
                [
                    {contractAddress: reMintVerifier2.address, size: 2},
                    {contractAddress: reMintVerifier32.address, size: 32},
                    {contractAddress: reMintVerifier100.address, size: 100}
                ],
                toHex(POW_DIFFICULTY, { size: 32 }),
                RE_MINT_LIMIT,
                MAX_TREE_DEPTH
            ],
            {
                client: { wallet: deployer },
                libraries: { leanIMTPoseidon2: leanIMTPoseidon2.address }
            },
        )
        powDifficulty = BigInt(await wormholeToken.read.POW_DIFFICULTY())
        //feeEstimatorPrivate = await getPrivateAccount({ wallet: feeEstimator, sharedSecret })
        //await wormholeToken.write.getFreeTokens([feeEstimatorPrivate.burnAddress])
    })

    after(function () {
        if (provingThreads != 1) {
            console.log("if a test is skipped comment out process.exit(0) to see the error")
            //bb's wasm fucks with node not closing
            process.exit(0);
        }
    })

    describe("Token", async function () {
        it("Should transfer", async function () {
            const alicePrivate = new BurnWallet(alice, powDifficulty, { acceptedChainIds: [BigInt(await publicClient.getChainId())] })
            const aliceBurnAccount = await alicePrivate.createBurnAccount({viewingKeyIndex:0})

            let totalAmountInserts = 0
            const startIndex = 2
            for (let index = startIndex; index < 3; index++) {
                //it("Should transfer", async function () {
                const amountFreeTokens = await wormholeToken.read.amountFreeTokens()
                await wormholeToken.write.getFreeTokens([deployer.account.address]) //sends 1_000_000n token

                let transferTx: Hash = "0x00"
                const amountTransfers = 2 ** index + Math.floor(Math.random() * startIndex - startIndex / 2);// a bit of noise is always good!
                totalAmountInserts += amountTransfers + 1
                const firstTransferTx = await wormholeToken.write.transfer([(await alice.getAddresses())[0], 420n])

                for (let index = 0; index < amountTransfers; index++) {
                    transferTx = await wormholeToken.write.transfer([aliceBurnAccount.burnAddress, 420n])
                }
                // if deployer send to it self. tx.origin == recipient, and the merkle insertion is skipped!
                // warm the slot
                await wormholeToken.write.transfer([deployer.account.address, 420n])
                const transferWithoutMerkleTx = await wormholeToken.write.transfer([deployer.account.address, 420n])
                const transferWithoutMerkleReceipt = await publicClient.getTransactionReceipt({ hash: transferWithoutMerkleTx })
                const firstTransferWithMerkleReceipt = await publicClient.getTransactionReceipt({ hash: firstTransferTx })

                const syncedTree = await getSyncedMerkleTree({ wormholeToken, publicClient })
                const jsRoot = syncedTree.tree.root
                const onchainRoot = await wormholeToken.read.root()
                assert.equal(jsRoot, onchainRoot, "jsRoot doesn't match onchainRoot")
                const transferWithMerkleReceipt = await publicClient.getTransactionReceipt({ hash: transferTx })
                gas["transfers"][index] = {
                    totalAmountInserts,
                    // dangling node inserts are cheaper so we take 2 measurements to hopefully catch a non dangling insert? @TODO find better method
                    transferWithoutMerkle: { high: transferWithoutMerkleReceipt.gasUsed, low: transferWithoutMerkleReceipt.gasUsed },
                    transferWithMerkle___: { high: transferWithMerkleReceipt.gasUsed, low: firstTransferWithMerkleReceipt.gasUsed },
                    depth: (await wormholeToken.read.tree())[1]
                }

            }
            const gasString = JSON.stringify(gas, (key, value) => typeof value === 'bigint' ? Number(value) : value, 2)
            //console.log(gasString)
        })

        it("reMint 3x from 1 burn account", async function () {
            const wormholeTokenAlice = getContract({ client: { public: publicClient, wallet: alice }, abi: wormholeToken.abi, address: wormholeToken.address });
            const amountFreeTokens = await wormholeTokenAlice.read.amountFreeTokens()
            await wormholeTokenAlice.write.getFreeTokens([(await alice.getAddresses())[0]]) //sends 1_000_000n token

            const alicePrivate = new BurnWallet(alice, powDifficulty, { acceptedChainIds: [BigInt(await publicClient.getChainId())], powDifficulty: powDifficulty })
            await alicePrivate.importWallet(PRE_MADE_BURN_ACCOUNTS, wormholeToken, publicClient)
            const aliceBurnAccount = await alicePrivate.createBurnAccount({viewingKeyIndex:0})
            const amountToBurn = 1000n * 10n ** 18n;
            await safeBurn(aliceBurnAccount, amountToBurn, wormholeTokenAlice, (await alice.getAddresses())[0])

            const claimableBurnAddress = [aliceBurnAccount.burnAddress];
            const reMintRecipient = bob.account.address

            // reMint 3 times since the 1st tx needs no commitment inclusion proof, the 2nd one the total spend balance read only contains information of one spend
            const reMintAmounts = [69n, 69000n, 420n * 10n ** 18n]
            let expectedRecipientBalance = 0n
            let reMintTxs: Hex[] = []
            for (const reMintAmount of reMintAmounts) {
                const reMintTx = await proofAndSelfRelay(
                    reMintRecipient,
                    reMintAmount,
                    alicePrivate.burnViewKeyManager,
                    wormholeToken,
                    publicClient,
                    (await alice.getAddresses())[0],
                    {
                        //callData, 
                        //fullNodeClient, 
                        //preSyncedTree, 
                        backend: circuitBackend,
                        burnAddresses:claimableBurnAddress,
                        //deploymentBlock,
                        //blocksPerGetLogsReq 
                        circuitSize: CIRCUIT_SIZE
                    }
                )
                expectedRecipientBalance += reMintAmount
                reMintTxs.push(reMintTx)

                const balanceBobPublic = await wormholeTokenAlice.read.balanceOf([bob.account.address])

                assert.equal(balanceBobPublic, expectedRecipientBalance, "bob didn't receive the expected amount of re-minted tokens")
            }

            const receipts = await Promise.all(
                reMintTxs.map((tx) =>
                    publicClient.getTransactionReceipt({ hash: tx })
                )
            )
            const logs = receipts.flatMap((r) => r.logs)
            const nullifiedEvents = parseEventLogs({
                abi: wormholeToken.abi,
                logs: logs,
                eventName: "Nullified"
            })

            // first one is always real. The rest should be the same size as the real one
            const expectedEncryptedBlobByteLen = (nullifiedEvents[0].args.encryptedTotalMinted.length - 2) / 2 // remove 0x, divide by 2 because hex string len is double byte len
            for (const nullifiedEvent of nullifiedEvents) {
                const encryptedBlobByteLen = (nullifiedEvent.args.encryptedTotalMinted.length - 2) / 2
                assert.equal(encryptedBlobByteLen, expectedEncryptedBlobByteLen, "encrypted blob length is not consistent")
                assert.ok(nullifiedEvent.args.nullifier <= FIELD_LIMIT, `Nullifier exceeded the FIELD_LIMIT. expected ${nullifiedEvent.args.nullifier} to be less than ${FIELD_LIMIT}`)
                assert.notEqual(nullifiedEvent.args.nullifier, 0n, "nullifier not set")
            }

            // finally check if enough was burned
            const balanceAlicePublic = await wormholeTokenAlice.read.balanceOf([(await alice.getAddresses())[0]])
            const burnedBalanceAlicePrivate = await wormholeTokenAlice.read.balanceOf([claimableBurnAddress[0]])
            assert.equal(burnedBalanceAlicePrivate, amountToBurn, "alicePrivate.burnAddress didn't burn the expected amount of tokens")
            assert.equal(balanceAlicePublic, amountFreeTokens - amountToBurn, "alice didn't burn the expected amount of tokens")
        })

        it("reMint 3x from 2 burn accounts", async function () {
            const wormholeTokenAlice = getContract({ client: { public: publicClient, wallet: alice }, abi: wormholeToken.abi, address: wormholeToken.address });
            const amountFreeTokens = await wormholeTokenAlice.read.amountFreeTokens()
            await wormholeTokenAlice.write.getFreeTokens([(await alice.getAddresses())[0]]) //sends 1_000_000n token

                        const alicePrivate = new BurnWallet(alice, powDifficulty, { acceptedChainIds: [BigInt(await publicClient.getChainId())], powDifficulty: powDifficulty })
            await alicePrivate.importWallet(PRE_MADE_BURN_ACCOUNTS, wormholeToken, publicClient)
            // PoW nonce hashing is with workers so can be done in parallel!
            const [aliceBurnAccount1, aliceBurnAccount2] = await Promise.all([alicePrivate.createBurnAccount({viewingKeyIndex:0, async: true }), alicePrivate.createBurnAccount({viewingKeyIndex:1, async: true })])


            const claimableBurnAddress = [aliceBurnAccount1.burnAddress, aliceBurnAccount2.burnAddress];
            const reMintRecipient = bob.account.address

            // reMint 3 times since the 1st tx needs no commitment inclusion proof, the 2nd one the total spend balance read only contains information of one spend
            const reMintAmounts = [69n, 69000n, 420n * 10n ** 18n]
            let expectedRecipientBalance = 0n
            let reMintTxs: Hex[] = []
            for (const reMintAmount of reMintAmounts) {
                await superSafeBurn(aliceBurnAccount1, reMintAmount / 2n + 1n, wormholeTokenAlice, (await alice.getAddresses())[0])
                await superSafeBurn(aliceBurnAccount2, reMintAmount / 2n + 1n, wormholeTokenAlice, (await alice.getAddresses())[0])
                const reMintTx = await proofAndSelfRelay(
                    reMintRecipient,
                    reMintAmount,
                    alicePrivate.burnViewKeyManager,
                    wormholeToken,
                    publicClient,
                    (await alice.getAddresses())[0],
                    {
                        burnAddresses: claimableBurnAddress,
                        //callData, 
                        //fullNodeClient, 
                        //preSyncedTree, 
                        backend: circuitBackend,
                        //deploymentBlock,
                        //blocksPerGetLogsReq 
                        circuitSize: CIRCUIT_SIZE
                    })
                expectedRecipientBalance += reMintAmount
                reMintTxs.push(reMintTx)

                const balanceBobPublic = await wormholeTokenAlice.read.balanceOf([bob.account.address])

                assert.equal(balanceBobPublic, expectedRecipientBalance, "bob didn't receive the expected amount of re-minted tokens")
            }

            const receipts = await Promise.all(
                reMintTxs.map((tx) =>
                    publicClient.getTransactionReceipt({ hash: tx })
                )
            )
            const logs = receipts.flatMap((r) => r.logs)
            const nullifiedEvents = parseEventLogs({
                abi: wormholeToken.abi,
                logs: logs,
                eventName: "Nullified"
            })

            // first one is always real. The rest should be the same size as the real one
            const expectedEncryptedBlobByteLen = (nullifiedEvents[0].args.encryptedTotalMinted.length - 2) / 2 // remove 0x, divide by 2 because hex string len is double byte len
            for (const nullifiedEvent of nullifiedEvents) {
                const encryptedBlobByteLen = (nullifiedEvent.args.encryptedTotalMinted.length - 2) / 2
                assert.equal(encryptedBlobByteLen, expectedEncryptedBlobByteLen, "encrypted blob length is not consistent")
                assert.ok(nullifiedEvent.args.nullifier <= FIELD_LIMIT, `Nullifier exceeded the FIELD_LIMIT. expected ${nullifiedEvent.args.nullifier} to be less than ${FIELD_LIMIT}`)
                assert.notEqual(nullifiedEvent.args.nullifier, 0n, "nullifier not set")
            }
            const walletExport = alicePrivate.exportWallet({paranoidMode:false, merkleTree:false})
            const alicePrivate2 = new BurnWallet(alice, powDifficulty, {walletDataImport:PRE_MADE_BURN_ACCOUNTS, acceptedChainIds: [BigInt(await publicClient.getChainId())] })
            await alicePrivate2.importWallet(walletExport, wormholeToken, publicClient,{merkleTree:false,viewKeyData:true})
            //console.log(JSON.stringify(alicePrivate2.burnViewKeyManager.privateData.burnAccounts,null,2))
            // const balanceAlicePublic = await wormholeTokenAlice.read.balanceOf([(await alice.getAddresses())[0]])
            // const burnedBalanceAlicePrivate1 = await wormholeTokenAlice.read.balanceOf([claimableBurnAddress[0]])
            // const burnedBalanceAlicePrivate2 = await wormholeTokenAlice.read.balanceOf([claimableBurnAddress[1]])
            // assert.equal(burnedBalanceAlicePrivate1, amountToBurn, "alicePrivate.burnAddress didn't burn the expected amount of tokens")
            // assert.equal(burnedBalanceAlicePrivate2, amountToBurn, "alicePrivate.burnAddress didn't burn the expected amount of tokens")
            // assert.equal(balanceAlicePublic, amountFreeTokens - amountToBurn*2n, "alice didn't burn the expected amount of tokens")
        })
    })


})