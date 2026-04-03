import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";
//@ts-ignore hardhat ignition does not understand file extensions
import { leanIMTPoseidon2ContractName, ZKTranscriptLibContractName2, WormholeTokenContractName, ZKTranscriptLibContractName100, reMint2InVerifierContractName, reMint32InVerifierContractName, reMint100InVerifierContractName } from "../../src/constants.ts";
import { POW_DIFFICULTY, RE_MINT_LIMIT, MAX_TREE_DEPTH } from "../../src/constants.ts";
import { toHex } from "viem";

export default buildModule("wormholeToken", (m) => {
    const leanIMTPoseidon2 = m.contract(leanIMTPoseidon2ContractName, [], { libraries: {} });
    //const ZKTranscriptLib100in = m.contract(ZKTranscriptLibContractName100in, [], { libraries: {} });
    const ZKTranscriptLib2in = m.contract(ZKTranscriptLibContractName2, [], { libraries: {} });
    //const ZKTranscriptLib100in = m.contract(ZKTranscriptLibContractName100in, [], { libraries: {} });
    const reMintVerifier2 = m.contract(reMint2InVerifierContractName, [], { libraries: { ZKTranscriptLib: ZKTranscriptLib2in } });
    const reMintVerifier32 = m.contract(reMint32InVerifierContractName, [], { libraries: { ZKTranscriptLib: ZKTranscriptLib2in } });
    const reMintVerifier100 = m.contract(reMint100InVerifierContractName, [], { libraries: { ZKTranscriptLib: ZKTranscriptLib2in } });

    const _powDifficulty = toHex(POW_DIFFICULTY, {size:32})
    const _reMintLimit = RE_MINT_LIMIT
    const _maxTreeDepth = MAX_TREE_DEPTH
    const _isCrossChain = false
    const _tokenName = "TWRP"
    const _tokenSymbol = "zkTransWarpTestToken"
    const _712Version = "1"
    const _verifiers = [
        { contractAddress: reMintVerifier2, size: 2 },
        { contractAddress: reMintVerifier32, size: 32 },
        { contractAddress: reMintVerifier100, size: 100 }
    ]
    const _acceptedChainIds: bigint[] = []
    const wormholeToken = m.contract(
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
        { libraries: { leanIMTPoseidon2: leanIMTPoseidon2 } }
    );

    return { wormholeToken, reMintVerifier2, reMintVerifier32, reMintVerifier100, ZKTranscriptLib: ZKTranscriptLib2in, leanIMTPoseidon2 };
});