import { describe, it, after } from "node:test";

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
import { BurnWallet } from "../src/BurnWallet.ts";
import { getContract, padHex, toHex, type Hex, type PublicClient } from "viem";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PRE_MADE_BURN_ACCOUNTS = await readFile(
    join(__dirname, "./data/privateDataAlice.json"),
    { encoding: "utf-8" },
);

// only 1 thread, otherwise bb's wasm hangs the test runner (see remint3.test.ts)
const provingThreads = 1;

// Each entry: circuit size and how many burnAccounts to fund so easyProof picks that size
const SIZES: { circuitSize: number; amountOfBurnAccounts: number }[] = [
    { circuitSize: 3, amountOfBurnAccounts: 2 },
    { circuitSize: 32, amountOfBurnAccounts: 2 },
    { circuitSize: 100, amountOfBurnAccounts: 2 },
];

describe("Verifier gas", async function () {
    const { viem } = await network.connect();
    const publicClient = (await viem.getPublicClient()) as PublicClient;
    const [deployer, alice, bob] = await viem.getWalletClients();

    // deploy once - verifiers are pure/view so we can reuse across all sizes
    const poseidon2Create2Salt = padHex("0x00", { size: 32 });
    await deployPoseidon2Huff(publicClient, deployer, poseidon2Create2Salt);
    const leanIMTPoseidon2 = await viem.deployContract(leanIMTPoseidon2ContractName, [], { libraries: {} });
    const ZKTranscriptLib = await viem.deployContract(ZKTranscriptLibContractName100, [], { libraries: {} });
    const reMintVerifier3 = await viem.deployContract(reMint3InVerifierContractName, [], {
        client: { wallet: deployer },
        libraries: { ZKTranscriptLib: ZKTranscriptLib.address },
    });
    const reMintVerifier32 = await viem.deployContract(reMint32InVerifierContractName, [], {
        client: { wallet: deployer },
        libraries: { ZKTranscriptLib: ZKTranscriptLib.address },
    });
    const reMintVerifier100 = await viem.deployContract(reMint100InVerifierContractName, [], {
        client: { wallet: deployer },
        libraries: { ZKTranscriptLib: ZKTranscriptLib.address },
    });
    const verifiersBySize: Record<number, { address: `0x${string}`; abi: any }> = {
        3: { address: reMintVerifier3.address, abi: reMintVerifier3.abi },
        32: { address: reMintVerifier32.address, abi: reMintVerifier32.abi },
        100: { address: reMintVerifier100.address, abi: reMintVerifier100.abi },
    };

    const wormholeToken = await viem.deployContract(
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

    const gasReport: Record<number, { proofBytes: number; publicInputsCount: number; verifyGas: bigint }> = {};

    after(function () {
        const pretty = Object.fromEntries(
            Object.entries(gasReport).map(([k, v]) => [
                k,
                { proofBytes: v.proofBytes, publicInputsCount: v.publicInputsCount, verifyGas: Number(v.verifyGas) },
            ]),
        );
        console.log("\n=== verifier.verify() gas (isolated, no merkle/transfer/event overhead) ===");
        console.table(pretty);

        if (provingThreads != 1) process.exit(0);
    });

    for (const { circuitSize, amountOfBurnAccounts } of SIZES) {
        it(`measures verify() gas for circuit size ${circuitSize}`, async function () {
            const chainId = await publicClient.getChainId();
            const aliceBurnWallet = new BurnWallet(alice, {
                archiveNodes: { [chainId]: publicClient },
                acceptedChainIds: [chainId],
            });

            const wormholeTokenAlice = getContract({
                client: { public: publicClient, wallet: alice },
                abi: wormholeToken.abi,
                address: wormholeToken.address,
            });
            await wormholeTokenAlice.write.getFreeTokens([alice.account.address]);

            await aliceBurnWallet.importWallet(PRE_MADE_BURN_ACCOUNTS, wormholeToken.address);
            const aliceBurnAccounts = await aliceBurnWallet.createBurnAccountsBulk(
                wormholeToken.address,
                amountOfBurnAccounts,
                { startingViewKeyIndex: 0 },
            );
            const claimableBurnAddress = aliceBurnAccounts.map((b) => b.burnAddress);

            const reMintAmount = 420n * 10n ** 18n;
            for (const aliceBurnAccount of aliceBurnAccounts) {
                await aliceBurnWallet.superSafeBurn(
                    wormholeToken.address,
                    reMintAmount / BigInt(amountOfBurnAccounts) + 1n,
                    aliceBurnAccount,
                );
            }

            const selfRelayInputs = await aliceBurnWallet.easyProof(
                wormholeToken.address,
                bob.account.address,
                reMintAmount,
                {
                    burnAddresses: claimableBurnAddress,
                    signingEthAccount: alice.account.address,
                    threads: provingThreads,
                    circuitSize,
                },
            );

            // Reconstruct the exact bytes32[] publicInputs the contract feeds the verifier.
            // Reuse WormholeToken._formatPublicInputs (it's public) so we don't duplicate that logic here.
            const _totalMintedLeafs = selfRelayInputs.publicInputs.burn_data_public.map((v) =>
                BigInt(v.total_minted_leaf),
            );
            const _nullifiers = selfRelayInputs.publicInputs.burn_data_public.map((v) => BigInt(v.nullifier));
            const _root = BigInt(selfRelayInputs.publicInputs.root);
            const _chainId = BigInt(selfRelayInputs.publicInputs.chain_id);
            const _amount = BigInt(selfRelayInputs.signatureInputs.amountToReMint);
            // signatureHash is computed inside reMint(); recompute via the helper on the contract
            const signatureHash = await wormholeToken.read._hashSignatureInputs([
                {
                    //contract: selfRelayInputs.signatureInputs.contract,
                    amountToReMint: _amount,
                    recipient: selfRelayInputs.signatureInputs.recipient,
                    callData: selfRelayInputs.signatureInputs.callData,
                    encryptedTotalMinted: selfRelayInputs.signatureInputs.encryptedTotalMinted,
                    callCanFail: selfRelayInputs.signatureInputs.callCanFail,
                    callValue: BigInt(selfRelayInputs.signatureInputs.callValue),
                },
            ]);
            const publicInputs = (await wormholeToken.read._formatPublicInputs([
                _root,
                _chainId,
                _amount,
                signatureHash,
                _totalMintedLeafs,
                _nullifiers,
            ])) as readonly Hex[];

            const proof = selfRelayInputs.proof as Hex;
            const verifier = verifiersBySize[circuitSize];
            const verifyGas = await publicClient.estimateContractGas({
                address: verifier.address,
                abi: verifier.abi,
                functionName: "verify",
                args: [proof, publicInputs],
                account: deployer.account,
            });

            gasReport[circuitSize] = {
                proofBytes: (proof.length - 2) / 2,
                publicInputsCount: publicInputs.length,
                verifyGas,
            };
        });
    }
});
