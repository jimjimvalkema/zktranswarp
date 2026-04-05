import assert from "node:assert/strict";
import { beforeEach, describe, it, after } from "node:test";

import { network } from "hardhat";

// TODO fix @warptoad/gigabridge-js why it doesn't automatically gets @aztec/aztec.js
import { deployPoseidon2Huff } from "@warptoad/gigabridge-js"

import { FIELD_LIMIT, WormholeTokenContractName, reMint3InVerifierContractName, reMint32InVerifierContractName, reMint100InVerifierContractName, leanIMTPoseidon2ContractName, ZKTranscriptLibContractName100, POW_DIFFICULTY, RE_MINT_LIMIT, MAX_TREE_DEPTH } from "../src/constants.ts";
import { getSyncedMerkleTree } from "../src/syncing.ts";
//import { noir_test_main_self_relay, noir_verify_sig } from "../src/noirtests.js";
import { createRelayerInputs, getBackend } from "../src/proving.ts";
import type { ContractReturnType } from "@nomicfoundation/hardhat-viem/types";
import { proofAndSelfRelay, relayTx, safeBurn, superSafeBurn } from "../src/transact.ts";
import { getAddress, getContract, padHex, parseEventLogs, parseUnits, toHex, type Hash, type Hex } from "viem";
import type { BurnAccount, FeeData, RelayInputs } from "../src/types.ts";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { BurnViewKeyManager } from "../src/BurnViewKeyManager.ts";
import { BurnWallet } from "../src/BurnWallet.ts";
import { wormholeTokenAbi } from "../src/utils.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const path = join(__dirname, './data/privateDataAlice.json')

const CIRCUIT_SIZE = 3;
const provingThreads = 1 //1; //undefined  // giving the backend more threads makes it hang and impossible to debug // set to undefined to use max threads available
const PRE_MADE_BURN_ACCOUNTS = await readFile(path, { encoding: "utf-8" })

export type WormholeTokenTest = ContractReturnType<typeof WormholeTokenContractName>


let gas: any = { "transfers": {} }
describe("Token", async function () {
    const SNARK_SCALAR_FIELD = BigInt("21888242871839275222246405745257275088548364400416034343698204186575808495617")

    const { viem } = await network.connect();
    const publicClient = await viem.getPublicClient();
    let wormholeToken: ContractReturnType<typeof WormholeTokenContractName>;
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

        wormholeToken = await viem.deployContract(
            WormholeTokenContractName,
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
        it("reMint 1x from 1 burn account with relayer", async function () {
            // ----------------- config test -----------------
            const amountOfBurnAccounts = 2
            // reMint 3 times since the 1st tx needs no commitment inclusion proof, the 2nd one the total spend balance read only contains information of one spend
            const amountsForRecipient = [69n, 69000n, 420n * 10n ** 18n]
            // acceptedChainIds defaults to [1n], but our chainId is 31337 so we need to set it.
            // archiveNodes will default to the node inside the client (`alice`), but that is generally a bad idea in prod since those are heavily rate limited note even archive clients
            const chainId = await publicClient.getChainId()
            const aliceBurnWallet = new BurnWallet(alice, { archiveNodes: { [chainId]: publicClient }, acceptedChainIds: [chainId] })
            const relayerBurnWallet = new BurnWallet(relayer, { archiveNodes: { [chainId]: publicClient }, acceptedChainIds: [chainId] })
            const reMintRecipient = bob.account.address
            const aliceRefundBurnAccount = await aliceBurnWallet.createBurnAccount(wormholeToken.address, { viewingKeyIndex: 0 })
            // ---------------------------------------------
            const contractConfig = await aliceBurnWallet.getContractConfig(wormholeToken.address)
            console.log({ contractConfig })


            const decimalsToken = await wormholeToken.read.decimals()
            // TODO maybe add this to contract and BurnWallet.#getContractConfig? Or move to constants.ts!!!
            const decimalsTokenPrice = 8;


            const wormholeTokenAlice = getContract({ client: { public: publicClient, wallet: alice }, abi: wormholeToken.abi, address: wormholeToken.address });
            // WalletClient.account.address = only true "which account is connected"
            await wormholeTokenAlice.write.getFreeTokens([alice.account.address]) //sends 1_000_000n token
            await wormholeTokenAlice.write.getFreeTokens([alice.account.address])
            await wormholeTokenAlice.write.getFreeTokens([alice.account.address])

            // takes presynced merkle tree and exported burnAccounts inside `PRE_MADE_BURN_ACCOUNTS`
            // uses that contract address to verify the sync state of that account
            await aliceBurnWallet.importWallet(PRE_MADE_BURN_ACCOUNTS, wormholeToken.address)
            // PoW nonce hashing is with workers so can be done in parallel!
            // but we did importWallet with wallet data that is export with {paranoidMode:false} 
            // and we said {startingViewKeyIndex:0}, so it will find those accounts already imported with pow already done
            const aliceBurnAccounts = await aliceBurnWallet.createBurnAccountsBulk(wormholeToken.address, amountOfBurnAccounts, { startingViewKeyIndex: 1 })


            const claimableBurnAddress = aliceBurnAccounts.map((b) => b.burnAddress);

            let expectedRecipientBalance = 0n
            let expectedRelayerBalance = 0n
            let expectedRefundBalance = 0n
            let reMintTxs: Hex[] = []
            for (const amountForRecipient of amountsForRecipient) {
                const tokensPerEthPrice = parseUnits("69", decimalsTokenPrice)
                const maxFee = parseUnits("5", decimalsToken)
                const reMintAmount = amountForRecipient + maxFee

                for (const aliceBurnAccount of aliceBurnAccounts) {
                    // you can use a regular transfer. But superSafeBurn will do extra checks so you know the burn account works for that token contract (like difficulty etc)
                    // you can also not pass the burnAccount and superSafeBurn will make a fresh one for you!
                    // TODO  BigInt(amountOfBurnAccounts) in remint100
                    await aliceBurnWallet.superSafeBurn(wormholeToken.address, reMintAmount / BigInt(amountOfBurnAccounts) + 1n, aliceBurnAccount)
                }
                // 1 eth will give you 69 token. the eth price of token is 0.0144 eth (1/69)
                const relayerBonus = parseUnits("1", decimalsToken)
                const estimatedGasCost = 3_092_125n
                const estimatedPriorityFee = await publicClient.estimateMaxPriorityFeePerGas()
                const feeData: FeeData = {
                    tokensPerEthPrice: toHex(tokensPerEthPrice),
                    maxFee: toHex(maxFee),
                    amountForRecipient: toHex(amountForRecipient),
                    relayerBonus: toHex(relayerBonus),
                    estimatedGasCost: toHex(estimatedGasCost),
                    estimatedPriorityFee: toHex(estimatedPriorityFee),
                    refundAddress: aliceRefundBurnAccount.burnAddress,
                    relayerAddress: relayer.account.address,
                }


                // 1. start tree sync asap, so it can sync even when user is still deciding on signing
                const syncedTreePromise = aliceBurnWallet.syncTree(wormholeToken.address)

                // 2. sync burn accounts (needed before selection)
                await aliceBurnWallet.syncBurnAccounts(wormholeToken.address, { burnAddressesToSync: claimableBurnAddress })

                // 3. select burn accounts for spend
                const selection = await aliceBurnWallet.selectBurnAccountsForSpend(wormholeToken.address, reMintAmount, {
                    burnAddresses: claimableBurnAddress,
                    circuitSize: CIRCUIT_SIZE,
                })

                // 4. sign
                const signed = await aliceBurnWallet.signReMint(reMintRecipient, selection, {
                    feeData: feeData,
                })

                // 5. ensure tree is synced before proving
                const syncedTree = await syncedTreePromise

                // 6. prove with the resolved tree
                const relayInputs = await aliceBurnWallet.proof(signed, { syncedTree, threads: provingThreads, feeData })

                // 7. relay
                // BurnWallets can also do it. But tbh the relayer probably do not want their own burn accounts
                //const reMintTx = await relayerBurnWallet.relayTx(relayInputs)
                const reMintTx = await relayTx(relayInputs, relayer)
                const txReceipt = await publicClient.getTransactionReceipt({ hash: reMintTx });
                const logs = parseEventLogs({
                    abi: wormholeTokenAbi,
                    logs: txReceipt.logs,
                    eventName: "Transfer"
                })
                const relayerAddress = relayer.account.address
                const recipientReceived = logs.find((l) => getAddress(l.args.to) === getAddress(reMintRecipient))
                const relayerReceived = logs.find((l) => getAddress(l.args.to) === getAddress(relayerAddress))
                const refundReceived = logs.find((l) => getAddress(l.args.to) === getAddress(aliceRefundBurnAccount.burnAddress))

                assert(relayerReceived !== undefined, "relayer did not receive a transfer")
                assert(recipientReceived !== undefined, "recipient did not receive a transfer")
                assert(refundReceived !== undefined, "refund account did not receive a transfer")
                expectedRecipientBalance += recipientReceived!.args.value
                expectedRelayerBalance += relayerReceived!.args.value
                expectedRefundBalance += refundReceived!.args.value
                reMintTxs.push(reMintTx)
            }

            const balanceBobPublic = await wormholeTokenAlice.read.balanceOf([bob.account.address])

            assert.equal(balanceBobPublic, expectedRecipientBalance, "bob didn't receive the expected amount of re-minted tokens")
            const recipientBalance = await wormholeToken.read.balanceOf([bob.account.address])
            // TODO use fresh accounts instead
            const refundAddressBalance = await wormholeToken.read.balanceOf([aliceRefundBurnAccount.burnAddress])
            const relayerBalance = await wormholeToken.read.balanceOf([relayer.account.address])
            const totalMinted = recipientBalance + relayerBalance + refundAddressBalance
            const expectedTotalReMinted = expectedRecipientBalance + expectedRelayerBalance + expectedRefundBalance

            console.log({
                relayerBalance__________: relayerBalance,
                recipientBalance________: recipientBalance,
                refundAddressBalance____: refundAddressBalance,
            })
            console.log({
                expectedRelayerBalance__: expectedRelayerBalance,
                expectedRecipientBalance: expectedRecipientBalance,
                expectedRefundBalance___: expectedRefundBalance
            })
            console.log({
                totalMinted__________: totalMinted,
                expectedTotalReMinted: expectedTotalReMinted
            })
            assert.equal(expectedTotalReMinted, totalMinted, "amount reMinted not matched");
            assert.equal(recipientBalance, expectedRecipientBalance, "recipient did not receive enough tokens");
            assert(relayerBalance >= expectedRelayerBalance, "relayer did not receive enough tokens");
            assert.equal(refundAddressBalance, expectedRefundBalance, "refund is not equal to maxFee - relayerBalance")
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
            // test wallet imports TODO move this
            const walletExport = aliceBurnWallet.exportWallet({ paranoidMode: false, merkleTree: false })
            const alicePrivate2 = new BurnWallet(alice, { archiveNodes: { [chainId]: publicClient }, acceptedChainIds: [chainId] })
            await alicePrivate2.importWallet(walletExport, wormholeToken.address)
        })

    })
})