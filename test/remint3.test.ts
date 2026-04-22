import assert from "node:assert/strict";
import { beforeEach, describe, it, after } from "node:test";

import { network } from "hardhat";

// TODO fix @warptoad/gigabridge-js why it doesn't automatically gets @aztec/aztec.js
import { deployPoseidon2Huff } from "@warptoad/gigabridge-js"

import { FIELD_LIMIT, TransWarpTokenContractName, reMint3InVerifierContractName, reMint32InVerifierContractName, reMint100InVerifierContractName, leanIMTPoseidon2ContractName, ZKTranscriptLibContractName100, POW_DIFFICULTY, RE_MINT_LIMIT, MAX_TREE_DEPTH } from "../src/constants.ts";
import { getSyncedMerkleTree } from "../src/syncing.ts";
//import { noir_test_main_self_relay, noir_verify_sig } from "../src/noirtests.js";
import type { ContractReturnType } from "@nomicfoundation/hardhat-viem/types";
import { BurnWallet } from "../src/BurnWallet.ts";
import { getContract, padHex, parseEventLogs, toHex, type Hash, type Hex, type PublicClient } from "viem";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { GasReport } from "./utils/gasReport.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const path = join(__dirname, './data/privateDataAlice.json')

const CIRCUIT_SIZE = 3;
const provingThreads = 1 //1; //undefined  // giving the backend more threads makes it hang and impossible to debug // set to undefined to use max threads available
const PRE_MADE_BURN_ACCOUNTS = await readFile(path, { encoding: "utf-8" })

export type TransWarpTokenTest = ContractReturnType<typeof TransWarpTokenContractName>


let gas: any = { "transfers": {} }
const gasReport = new GasReport("remint3.test")
describe("Token", async function () {
    const SNARK_SCALAR_FIELD = BigInt("21888242871839275222246405745257275088548364400416034343698204186575808495617")

    const { viem } = await network.connect();
    const publicClient = await viem.getPublicClient() as PublicClient;
    let transwarpToken: ContractReturnType<typeof TransWarpTokenContractName>;
    let reMintVerifier3: ContractReturnType<typeof reMint3InVerifierContractName>;
    let reMintVerifier32: ContractReturnType<typeof reMint32InVerifierContractName>;
    let reMintVerifier100: ContractReturnType<typeof reMint100InVerifierContractName>;
    let leanIMTPoseidon2: ContractReturnType<typeof leanIMTPoseidon2ContractName>;
    let powDifficulty = 0n
    const [deployer, alice, bob, carol, relayer, feeEstimator] = await viem.getWalletClients()
    //let feeEstimatorPrivate: UnsyncedPrivateWallet


    beforeEach(async function () {
        const poseidon2Create2Salt = padHex("0x00", { size: 32 })
        await deployPoseidon2Huff(publicClient, deployer, poseidon2Create2Salt)
        leanIMTPoseidon2 = await viem.deployContract(leanIMTPoseidon2ContractName, [], { libraries: {} });
        const ZKTranscriptLib = await viem.deployContract(ZKTranscriptLibContractName100, [], { libraries: {} });
        reMintVerifier3 = await viem.deployContract(reMint3InVerifierContractName, [], { client: { wallet: deployer }, libraries: { ZKTranscriptLib: ZKTranscriptLib.address } });
        reMintVerifier32 = await viem.deployContract(reMint32InVerifierContractName, [], { client: { wallet: deployer }, libraries: { ZKTranscriptLib: ZKTranscriptLib.address } });
        reMintVerifier100 = await viem.deployContract(reMint100InVerifierContractName, [], { client: { wallet: deployer }, libraries: { ZKTranscriptLib: ZKTranscriptLib.address } });
        //PrivateTransferVerifier = await viem.deployContract(PrivateTransferVerifierContractName, [], { client: { wallet: deployer }, libraries: { } });
        const _powDifficulty = toHex(POW_DIFFICULTY, {size:32})
        const _reMintLimit = RE_MINT_LIMIT
        const _maxTreeDepth = MAX_TREE_DEPTH
        const _isCrossChain = false
        const _tokenName = "TWRP"
        const _tokenSymbol = "zkTransWarpTestToken"
        const _712Version = "1"
        const _verifiers = [
            { contractAddress: reMintVerifier3.address, size: 3},
            { contractAddress: reMintVerifier32.address, size: 32 },
            { contractAddress: reMintVerifier100.address, size: 100 }
        ]
        const _acceptedChainIds: bigint[] = []

        transwarpToken = await viem.deployContract(
            TransWarpTokenContractName,
            [
                _powDifficulty,
                _reMintLimit,
                _maxTreeDepth,
                _isCrossChain,
                _tokenName,
                _tokenSymbol,
                _712Version,
                _verifiers,
                _acceptedChainIds
            ],

            {
                client: { wallet: deployer },
                libraries: { leanIMTPoseidon2: leanIMTPoseidon2.address }
            },
        )
        powDifficulty = BigInt(await transwarpToken.read.POW_DIFFICULTY())
        //feeEstimatorPrivate = await getPrivateAccount({ wallet: feeEstimator, sharedSecret })
        //await transwarpToken.write.getFreeTokens([feeEstimatorPrivate.burnAddress])
    })

    after(function () {
        gasReport.print()
        if (provingThreads != 1) {
            console.log("if a test is skipped comment out process.exit(0) to see the error")
            //bb's wasm fucks with node not closing
            process.exit(0);
        }
    })

    describe("Token", async function () {
        it("Should transfer", async function () {
            const chainId = await publicClient.getChainId()
            const alicePrivate = new BurnWallet(alice, { archiveNodes: { [chainId]: publicClient }, acceptedChainIds: [chainId] })
            const aliceBurnAccount = await alicePrivate.createBurnAccount(transwarpToken.address, { viewingKeyIndex: 0 })

            let totalAmountInserts = 0
            const startIndex = 2
            for (let index = startIndex; index < 3; index++) {
                //it("Should transfer", async function () {
                const amountFreeTokens = await transwarpToken.read.amountFreeTokens()
                await transwarpToken.write.getFreeTokens([deployer.account.address]) //sends 1_000_000n token

                let transferTx: Hash = "0x00"
                const amountTransfers = 2 ** index + Math.floor(Math.random() * startIndex - startIndex / 2);// a bit of noise is always good!
                totalAmountInserts += amountTransfers + 1
                const firstTransferTx = await transwarpToken.write.transfer([alice.account.address, 420n])

                for (let index = 0; index < amountTransfers; index++) {
                    transferTx = await transwarpToken.write.transfer([aliceBurnAccount.burnAddress, 420n])
                }
                // if deployer send to it self. tx.origin == recipient, and the merkle insertion is skipped!
                // warm the slot
                await transwarpToken.write.transfer([deployer.account.address, 420n])
                const transferWithoutMerkleTx = await transwarpToken.write.transfer([deployer.account.address, 420n])
                const transferWithoutMerkleReceipt = await publicClient.getTransactionReceipt({ hash: transferWithoutMerkleTx })
                const firstTransferWithMerkleReceipt = await publicClient.getTransactionReceipt({ hash: firstTransferTx })
                gasReport.record("transfer (no merkle insert)", transferWithoutMerkleReceipt.gasUsed)
                gasReport.record("transfer (with merkle insert)", firstTransferWithMerkleReceipt.gasUsed)

                const syncedTree = await getSyncedMerkleTree(transwarpToken.address, publicClient)
                const jsRoot = syncedTree.tree.root
                const onchainRoot = await transwarpToken.read.root()
                assert.equal(jsRoot, onchainRoot, "jsRoot doesn't match onchainRoot")
                const transferWithMerkleReceipt = await publicClient.getTransactionReceipt({ hash: transferTx })
                gas["transfers"][index] = {
                    totalAmountInserts,
                    // dangling node inserts are cheaper so we take 2 measurements to hopefully catch a non dangling insert? @TODO find better method
                    transferWithoutMerkle: { high: transferWithoutMerkleReceipt.gasUsed, low: transferWithoutMerkleReceipt.gasUsed },
                    transferWithMerkle___: { high: transferWithMerkleReceipt.gasUsed, low: firstTransferWithMerkleReceipt.gasUsed },
                    depth: (await transwarpToken.read.tree())[1]
                }

            }
            const gasString = JSON.stringify(gas, (key, value) => typeof value === 'bigint' ? Number(value) : value, 2)
            //console.log(gasString)
        })

        it("reMint 5x in succession", async function () {
            const chainId = await publicClient.getChainId()
            const aliceBurnWallet = new BurnWallet(alice, { archiveNodes: { [chainId]: publicClient }, acceptedChainIds: [chainId] })
            await aliceBurnWallet.importWallet(PRE_MADE_BURN_ACCOUNTS, transwarpToken.address)
            const aliceBurnAccount = await aliceBurnWallet.createBurnAccount(transwarpToken.address, {viewingKeyIndex:0})

            const transwarpTokenAlice = getContract({ client: { public: publicClient, wallet: alice }, abi: transwarpToken.abi, address: transwarpToken.address });
            await transwarpTokenAlice.write.getFreeTokens([alice.account.address])

            await aliceBurnWallet.superSafeBurn(transwarpToken.address, 5n, aliceBurnAccount)
            for (let index = 0; index < 5; index++) {
                const proof = await aliceBurnWallet.easyProof(transwarpToken.address, alice.account.address, 1n, {threads:provingThreads})
                await aliceBurnWallet.selfRelayTx(proof)
                
            }
        })

        it("reMint 3x from 1 burn accounts", async function () {
            // ----------------- config test -----------------
            const amountOfBurnAccounts = 1
            // reMint 3 times since the 1st tx needs no commitment inclusion proof, the 2nd one the total spend balance read only contains information of one spend
            const reMintAmounts = [69n, 69000n, 420n * 10n ** 18n]
            // acceptedChainIds defaults to [1n], but our chainId is 31337 so we need to set it.
            // archiveNodes will default to the node inside the client (`alice`), but that is generally a bad idea in prod since those are heavily rate limited note even archive clients
            const chainId = await publicClient.getChainId()
            const aliceBurnWallet = new BurnWallet(alice, { archiveNodes: { [chainId]: publicClient }, acceptedChainIds: [chainId] })
            const reMintRecipient = bob.account.address
            // ---------------------------------------------



            const transwarpTokenAlice = getContract({ client: { public: publicClient, wallet: alice }, abi: transwarpToken.abi, address: transwarpToken.address });
            await transwarpTokenAlice.write.getFreeTokens([alice.account.address]) //sends 1_000_000n token

            // takes presynced merkle tree and exported burnAccounts inside `PRE_MADE_BURN_ACCOUNTS`
            // uses that contract address to verify the sync state of that account
            await aliceBurnWallet.importWallet(PRE_MADE_BURN_ACCOUNTS, transwarpToken.address)
            // PoW nonce hashing is with workers so can be done in parallel!
            // but we did importWallet with wallet data that is export with {paranoidMode:false} 
            // and we said {startingViewKeyIndex:0}, so it will find those accounts already imported with pow already done
            const aliceBurnAccounts = await aliceBurnWallet.createBurnAccountsBulk(transwarpToken.address, amountOfBurnAccounts, { startingViewKeyIndex: 0 })


            const claimableBurnAddress = aliceBurnAccounts.map((b) => b.burnAddress);

            let expectedRecipientBalance = 0n
            let reMintTxs: Hex[] = []
            for (const reMintAmount of reMintAmounts) {
                for (const aliceBurnAccount of aliceBurnAccounts) {
                    // you can use a regular transfer. But superSafeBurn will do extra checks so you know the burn account works for that token contract (like difficulty etc)
                    // you can also not pass the burnAccount and superSafeBurn will make a fresh one for you!
                    const burnTx = await aliceBurnWallet.superSafeBurn(transwarpToken.address, reMintAmount / BigInt(amountOfBurnAccounts) + 1n, aliceBurnAccount)
                    await gasReport.recordTx("superSafeBurn (transfer to burn address)", burnTx, publicClient)
                }
                const proof = await aliceBurnWallet.easyProof(
                    transwarpToken.address,
                    reMintRecipient,
                    reMintAmount,
                    {
                        burnAddresses: claimableBurnAddress,
                        signingEthAccount: alice.account.address,
                        threads: provingThreads, // test breaks if we set this higher then 1, defaults to max
                        circuitSize: CIRCUIT_SIZE // forces to use that size, even if smaller circuits also work, defaults to lowest
                    }
                )
                const reMintTx = await aliceBurnWallet.selfRelayTx(proof)
                await gasReport.recordTx(`reMint (selfRelay, size ${CIRCUIT_SIZE})`, reMintTx, publicClient)
                expectedRecipientBalance += reMintAmount
                reMintTxs.push(reMintTx)

                const balanceBobPublic = await transwarpTokenAlice.read.balanceOf([bob.account.address])

                assert.equal(balanceBobPublic, expectedRecipientBalance, "bob didn't receive the expected amount of re-minted tokens")
            }

            const receipts = await Promise.all(
                reMintTxs.map((tx) =>
                    publicClient.getTransactionReceipt({ hash: tx })
                )
            )
            const logs = receipts.flatMap((r) => r.logs)
            const nullifiedEvents = parseEventLogs({
                abi: transwarpToken.abi,
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
            // test wallet imports TODO move this
            const walletExport = aliceBurnWallet.exportWallet({ paranoidMode: false, merkleTree: false })
            const alicePrivate2 = new BurnWallet(alice, { archiveNodes: { [chainId]: publicClient }, acceptedChainIds: [chainId] })
            await alicePrivate2.importWallet(walletExport, transwarpToken.address)
        })

        it("reMint 5x from 3 burn accounts", async function () {
            // ----------------- config test -----------------
            const amountOfBurnAccounts = 3
            // reMint 3 times since the 1st tx needs no commitment inclusion proof, the 2nd one the total spend balance read only contains information of one spend
            const reMintAmounts = [69n, 69000n,69000n,69000n, 420n * 10n ** 18n]
            // acceptedChainIds defaults to [1n], but our chainId is 31337 so we need to set it.
            // archiveNodes will default to the node inside the client (`alice`), but that is generally a bad idea in prod since those are heavily rate limited note even archive clients
            const chainId = await publicClient.getChainId()
            const aliceBurnWallet = new BurnWallet(alice, { archiveNodes: { [chainId]: publicClient }, acceptedChainIds: [chainId] })
            const reMintRecipient = bob.account.address
            // ---------------------------------------------
            const contractConfig = await aliceBurnWallet.getContractConfig(transwarpToken.address)
            console.log({ contractConfig })



            const transwarpTokenAlice = getContract({ client: { public: publicClient, wallet: alice }, abi: transwarpToken.abi, address: transwarpToken.address });
            await transwarpTokenAlice.write.getFreeTokens([alice.account.address]) //sends 1_000_000n token

            // takes presynced merkle tree and exported burnAccounts inside `PRE_MADE_BURN_ACCOUNTS`
            // uses that contract address to verify the sync state of that account
            await aliceBurnWallet.importWallet(PRE_MADE_BURN_ACCOUNTS, transwarpToken.address)
            // PoW nonce hashing is with workers so can be done in parallel!
            // but we did importWallet with wallet data that is export with {paranoidMode:false} 
            // and we said {startingViewKeyIndex:0}, so it will find those accounts already imported with pow already done
            const aliceBurnAccounts = await aliceBurnWallet.createBurnAccountsBulk(transwarpToken.address, amountOfBurnAccounts, { startingViewKeyIndex: 0 })


            const claimableBurnAddress = aliceBurnAccounts.map((b) => b.burnAddress);

            let expectedRecipientBalance = 0n
            let reMintTxs: Hex[] = []
            for (const reMintAmount of reMintAmounts) {
                for (const aliceBurnAccount of aliceBurnAccounts) {
                    // you can use a regular transfer. But superSafeBurn will do extra checks so you know the burn account works for that token contract (like difficulty etc)
                    // you can also not pass the burnAccount and superSafeBurn will make a fresh one for you!
                    const burnTx = await aliceBurnWallet.superSafeBurn(transwarpToken.address, reMintAmount / BigInt(amountOfBurnAccounts) + 1n, aliceBurnAccount)
                    await gasReport.recordTx("superSafeBurn (transfer to burn address)", burnTx, publicClient)
                }

                const proof = await aliceBurnWallet.easyProof(
                    transwarpToken.address,
                    reMintRecipient,
                    reMintAmount,
                    {
                        burnAddresses: claimableBurnAddress,
                        signingEthAccount: alice.account.address,
                        threads: provingThreads, // test breaks if we set this higher then 1, defaults to max
                        circuitSize: CIRCUIT_SIZE // forces to use that size, even if smaller circuits also work, defaults to lowest
                    }
                )
                const reMintTx = await aliceBurnWallet.selfRelayTx(proof)
                await gasReport.recordTx(`reMint (selfRelay, size ${CIRCUIT_SIZE})`, reMintTx, publicClient)
                expectedRecipientBalance += reMintAmount
                reMintTxs.push(reMintTx)

                const balanceBobPublic = await transwarpTokenAlice.read.balanceOf([bob.account.address])

                assert.equal(balanceBobPublic, expectedRecipientBalance, "bob didn't receive the expected amount of re-minted tokens")
            }

            const receipts = await Promise.all(
                reMintTxs.map((tx) =>
                    publicClient.getTransactionReceipt({ hash: tx })
                )
            )
            const logs = receipts.flatMap((r) => r.logs)
            const nullifiedEvents = parseEventLogs({
                abi: transwarpToken.abi,
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
            // test wallet imports TODO move this
            const walletExport = aliceBurnWallet.exportWallet({ paranoidMode: false, merkleTree: false })
            const alicePrivate2 = new BurnWallet(alice, { archiveNodes: { [chainId]: publicClient }, acceptedChainIds: [chainId] })
            await alicePrivate2.importWallet(walletExport, transwarpToken.address)
        })
    })


})