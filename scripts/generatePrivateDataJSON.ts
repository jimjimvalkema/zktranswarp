import assert from "node:assert/strict";
import { beforeEach, describe, it, after } from "node:test";

import { network } from "hardhat";

// TODO fix @warptoad/gigabridge-js why it doesn't automatically gets @aztec/aztec.js
import { deployPoseidon2Huff } from "@warptoad/gigabridge-js"

import { WormholeTokenContractName, reMint3InVerifierContractName, reMint32InVerifierContractName, reMint100InVerifierContractName, leanIMTPoseidon2ContractName, ZKTranscriptLibContractName100, POW_DIFFICULTY, RE_MINT_LIMIT, MAX_TREE_DEPTH } from "../src/constants.ts";
//import { noir_test_main_self_relay, noir_verify_sig } from "../src/noirtests.js";
import { getBackend } from "../src/proving.ts";
import type { ContractReturnType } from "@nomicfoundation/hardhat-viem/types";
import { BurnWallet } from "../src/BurnWallet.ts";
import { getContract, padHex, toHex} from "viem";
import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { UnsyncedBurnAccount } from "../src/types.ts";

const CIRCUIT_SIZE = 100;
const provingThreads = 1 //1; //undefined  // giving the backend more threads makes it hang and impossible to debug // set to undefined to use max threads available

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
    const circuitBackend = await getBackend(CIRCUIT_SIZE, provingThreads);
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
                    { contractAddress: reMintVerifier100.address, size: 100 }
                ],
                []
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
            //process.exit(0);
        }
    })

    describe("Token", async function () {
        it("generate 200 burn accounts", async function () {
            const wormholeTokenAlice = getContract({ client: { public: publicClient, wallet: alice }, abi: wormholeToken.abi, address: wormholeToken.address });
            const amountFreeTokens = await wormholeTokenAlice.read.amountFreeTokens()
            await wormholeTokenAlice.write.getFreeTokens([alice.account.address]) //sends 1_000_000n token

            const alicePrivate = new BurnWallet(alice, { acceptedChainIds: [await publicClient.getChainId()] })
            const amountBurnAddresses = 200

            const burnAccounts: UnsyncedBurnAccount[] = await alicePrivate.createBurnAccountsBulk(wormholeToken.address, amountBurnAddresses, { async: true })
            await alicePrivate.superSafeBurn(wormholeToken.address,100000n,burnAccounts[0])
            // const proof1 = await alicePrivate.easyProof(wormholeToken.address,burnAccounts[1].burnAddress,69n,{threads:provingThreads})
            // await alicePrivate.selfRelayTx(proof1)
            // const proof2 = await alicePrivate.easyProof(wormholeToken.address,burnAccounts[2].burnAddress,69n,{threads:provingThreads})
            // await alicePrivate.selfRelayTx(proof2)
            const __dirname = dirname(fileURLToPath(import.meta.url));
            const path =  join(__dirname, '../test/data/privateDataAlice.json')
            console.log({path})
            // no paranoidMode, so we get our pow nonces
            await writeFile(path, alicePrivate.exportWallet({merkleTree:false, paranoidMode:false}), 'utf-8');
            
        })
    })


})