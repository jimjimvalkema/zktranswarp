import assert from "node:assert/strict";
import { beforeEach, describe, it, after } from "node:test";

import { network } from "hardhat";

// TODO fix @warptoad/gigabridge-js why it doesn't automatically gets @aztec/aztec.js
import { deployPoseidon2Huff } from "@warptoad/gigabridge-js"

import { FIELD_LIMIT, WormholeTokenContractName, reMint2InVerifierContractName, reMint32InVerifierContractName, reMint100InVerifierContractName, leanIMTPoseidon2ContractName, ZKTranscriptLibContractName100, POW_DIFFICULTY, RE_MINT_LIMIT, MAX_TREE_DEPTH } from "../src/constants.ts";
import { getSyncedMerkleTree } from "../src/syncing.ts";
//import { noir_test_main_self_relay, noir_verify_sig } from "../src/noirtests.js";
import { createRelayerInputs, getBackend } from "../src/proving.ts";
import type { ContractReturnType } from "@nomicfoundation/hardhat-viem/types";
import { proofAndSelfRelay, relayTx, safeBurn, superSafeBurn } from "../src/transact.ts";
import { getContract, padHex, parseEventLogs, parseUnits, toHex, type Hash, type Hex } from "viem";
import type { BurnAccount, FeeData } from "../src/types.ts";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { BurnViewKeyManager } from "../src/BurnViewKeyManager.ts";
import { BurnWallet } from "../src/BurnWallet.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const path = join(__dirname, './data/privateDataAlice.json')

const CIRCUIT_SIZE = 100;
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
                    { contractAddress: reMintVerifier2.address, size: 2 },
                    { contractAddress: reMintVerifier32.address, size: 32 },
                    { contractAddress: reMintVerifier100.address, size: 100 }
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
        it("reMint 1x from 1 burn account with relayer", async function () {
            const wormholeTokenAlice = getContract({ client: { public: publicClient, wallet: alice }, abi: wormholeToken.abi, address: wormholeToken.address });
            const amountFreeTokens = await wormholeTokenAlice.read.amountFreeTokens()
            await wormholeTokenAlice.write.getFreeTokens([(await alice.getAddresses())[0]]) //sends 1_000_000n token

            const chainId = BigInt(await publicClient.getChainId())
            const alicePrivate = new BurnWallet(alice, powDifficulty, { acceptedChainIds: [BigInt(await publicClient.getChainId())], powDifficulty: powDifficulty })
            await alicePrivate.importWallet(PRE_MADE_BURN_ACCOUNTS, wormholeToken, publicClient)
            const aliceBurnAccount = await alicePrivate.createBurnAccount({ viewingKeyIndex: 0 })
            const aliceRefundBurnAccount = await alicePrivate.createBurnAccount({ viewingKeyIndex: 1 })
            const decimalsToken = await wormholeToken.read.decimals()
            const amountToBurn = parseUnits("42069", decimalsToken);
            await safeBurn(aliceBurnAccount, amountToBurn, wormholeTokenAlice, (await alice.getAddresses())[0])

            const decimalsTokenPrice = 8;
            // 1 eth will give you 69 token. the eth price of token is 0.0144 eth (1/69)
            const tokensPerEthPrice = parseUnits("69", decimalsTokenPrice)
            const maxFee = parseUnits("5", decimalsToken)
            const amountForRecipient = parseUnits("420", decimalsToken)
            const reMintAmount = amountForRecipient + maxFee
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


            const reMintRecipient = bob.account.address
            const { relayInputs: relayerInputs } = await createRelayerInputs(
                reMintRecipient,
                reMintAmount,
                alicePrivate.burnViewKeyManager,
                wormholeToken,
                publicClient,
                (await alice.getAddresses())[0],
                {
                    chainId: chainId,
                    //callData, 
                    //burnAddresses: [aliceBurnAccount.burnAddress],
                    //fullNodeClient, 
                    //preSyncedTree, 
                    backend: circuitBackend,
                    //deploymentBlock,
                    //blocksPerGetLogsReq,
                    feeData: feeData,
                    circuitSize: CIRCUIT_SIZE

                })
            const reMintTx = await relayTx(relayerInputs, alice, wormholeTokenAlice)
            const recipientBalance = await wormholeToken.read.balanceOf([bob.account.address])
            const refundAddressBalance = await wormholeToken.read.balanceOf([aliceRefundBurnAccount.burnAddress])
            const relayerBalance = await wormholeToken.read.balanceOf([relayer.account.address])

            const txReceipt = await publicClient.getTransactionReceipt({ hash: reMintTx });
            console.log({
                gasCost: txReceipt.gasUsed,
                effectiveGasPrice: txReceipt.effectiveGasPrice,
                estimatedPriorityFee, estimatedGasCost
            })
            const totalReMinted = relayerBalance + refundAddressBalance + recipientBalance
            assert.equal(totalReMinted, reMintAmount, "amount reMinted not matched");
            assert.equal(recipientBalance, amountForRecipient, "recipient did not receive enough tokens");
            assert(relayerBalance > relayerBonus, "relayer did not receive enough tokens");
            assert.equal(refundAddressBalance, maxFee - relayerBalance, "refund is not equal to maxFee - relayerBalance")
        })

    })


})