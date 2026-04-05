import type { Address, Hex } from "viem";
import { getAddress, padHex, toHex } from "viem"
import type { LeanIMTMerkleProof } from "@zk-kit/lean-imt";
import deployedAddressesSepolia from "../ignition/deployments/chain-11155111/deployed_addresses.json" with {"type": "json"};

// ---- contract args -------------
// at 17n you got 10 years of bitcoin network doing hashes non stop
export const ADDED_BITS_SECURITY = 8n; // 88 bits total, ~2.5s (max ~10s) pow time , $2.6 trillion attack cost ($10b * 2**(16/2)), 
export const POW_BITS = ADDED_BITS_SECURITY * 2n; //  ADDED_BITS_SECURITY*2 because PoW is only added to burn address, so problem only becomes half as hard
export const POW_DIFFICULTY = 2n ** (256n - POW_BITS) - 1n//16n ** (64n - POW_LEADING_ZEROS) - 1n;
// i recommend picking a number far below the cost of attack and that is max 1% of total supply.
// if needed you can periodically and programmatically change this number in the contract instead.
// How ever do know it's public input. Meaning even the slightest change will invalidate pending tx, so please only update that number infrequently!
// i chose this number since my token is ony a demo and has a uncapped supply
export const RE_MINT_LIMIT = 100_000_000n * 10n ** 18n;

// ---- circuit constants ---------------------
// domain separators
export const BURN_ADDRESS_TYPE = 0x5a4b574f524d484f4c45n;               // UTF8("ZKWORMHOLE").toHex() [...new TextEncoder().encode("ZKWORMHOLE")].map(b=>b.toString(16)).join('')
export const TOTAL_BURNED_DOMAIN = 0x544f54414c5f4255524e4544n;         // UTF8("TOTAL_BURNED").toHex()
export const TOTAL_MINTED_DOMAIN = 0x544f54414c5f4d494e544544n;         // UTF8("TOTAL_MINTED").toHex()
export const NULLIFIER_DOMAIN = 0x4e554c4c4946494552n;                          // UTF8("NULLIFIER").toHex()
export const FAKE_LEAF_DOMAIN = 0x46414b455f4c454146n;                  // UTF8("FAKE_LEAF").toHex()
export const FAKE_NULLIFIER_DOMAIN = 0x46414b455f4e554c4c4946494552n;   // UTF8("FAKE_NULLIFIER").toHex()

export const MAX_TREE_DEPTH = 44 as const;

//---------------- 

export const ENCRYPTED_TOTAL_MINTED_PADDING = 256 // leaving some space for other things. Fits about 3 other key value pairs
export const EAS_BYTE_LEN_OVERHEAD = 28

export const VIEWING_KEY_SIG_MESSAGE = `
You are about to create your viewing key for your zkwormhole account! \n
Signing this on compromised site will result in leaking all private data. But *not* loss of funds.
So please double check the url! 
`

//------------
export const WormholeTokenContractName = "WormholeToken"
export const leanIMTPoseidon2ContractName = "leanIMTPoseidon2"
export const reMint3InVerifierContractName = "reMint3Verifier"
export const reMint32InVerifierContractName = "reMint32Verifier"
export const reMint100InVerifierContractName = "reMint100Verifier"
export const ZKTranscriptLibContractName2 = "contracts/reMint3Verifier.sol:ZKTranscriptLib"
export const ZKTranscriptLibContractName32 = "contracts/reMint32Verifier.sol:ZKTranscriptLib"
export const ZKTranscriptLibContractName100 = "contracts/reMint100Verifier.sol:ZKTranscriptLib"


// @TODO double check this field limit. Should be fine but claude gave me a different number
export const FIELD_LIMIT = 21888242871839275222246405745257275088548364400416034343698204186575808495616n;
export const FIELD_MODULUS = 21888242871839275222246405745257275088548364400416034343698204186575808495617n

// estimation is some time so high it goes over the per tx limit on sepolia
export const GAS_LIMIT_TX = 16000000n

export const WORMHOLE_TOKEN_DEPLOYMENT_BLOCK: { [chainId: number]: bigint; } = {
    11155111: 10369210n // https://sepolia.etherscan.io/tx/0xcaba5105591843eae94db3dea983086a23c01af20f45460f415e4ff238122ffd
}


//------------- zero values ---------------------------------
export const EMPTY_UNFORMATTED_MERKLE_PROOF: LeanIMTMerkleProof<bigint> = {
    root: 0n,
    leaf: 0n,
    index: 0,
    siblings: [],
}
export const zeroAddress = getAddress(padHex("0x00", { size: 20 }))
// -----------------------------


// ---------- eip 712 ----------------------

export function getPrivateReMintDomain(chainId: number, verifyingContract: Address, name: string, version: string) {
    return {
        name: name,
        version: version,
        chainId: chainId,
        verifyingContract: verifyingContract,
    } as const;
}

export const PRIVATE_RE_MINT_712_TYPES = {
    reMint: [
        { name: "_recipient", type: "address" },
        { name: "_amount", type: "uint256" },
        { name: "_callData", type: "bytes" },
        { name: "_callCanFail", type: "bool" },
        { name: "_callValue", type: "uint256" },
        { name: "_encryptedTotalMinted", type: "bytes[]" },
    ],
} as const;

export const PRIVATE_RE_MINT_RELAYER_712_TYPES = {
    reMintRelayer: [
        { name: "_recipient", type: "address" },
        { name: "_amount", type: "uint256" },
        { name: "_callData", type: "bytes" },
        { name: "_callCanFail", type: "bool" },
        { name: "_callValue", type: "uint256" },
        { name: "_encryptedTotalMinted", type: "bytes[]" },
        { name: "_feeData", type: "FeeData" },
    ],
    FeeData: [
        { name: "tokensPerEthPrice", type: "uint256" },
        { name: "maxFee", type: "uint256" },
        { name: "amountForRecipient", type: "uint256" },
        { name: "relayerBonus", type: "uint256" },
        { name: "estimatedGasCost", type: "uint256" },
        { name: "estimatedPriorityFee", type: "uint256" },
        { name: "refundAddress", type: "address" },
        { name: "relayerAddress", type: "address" },
    ],
} as const;

// --------------------
export const RE_MINT_RELAYER_GAS_DEFAULT_L1 = {
    [3]: toHex(100000n),
    [32]: toHex(100000n),
    [100]: toHex(100000n),
} as const

// TODO if using create2 we could also set other chainIds
export const RE_MINT_RELAYER_GAS: { [chainId: Hex]: { [contract: Address]: { [circuitSize: number]: Hex } } } = {
    // [toHex(1)]: RE_MINT_RELAYER_GAS_DEFAULT_L1,
    // [toHex(31337)]: RE_MINT_RELAYER_GAS_DEFAULT_L1,
    [toHex(11155111)]: {
        [deployedAddressesSepolia["wormholeToken#WormholeToken"]]: RE_MINT_RELAYER_GAS_DEFAULT_L1
    },
    //[toHex(17000)]: RE_MINT_RELAYER_GAS_DEFAULT_L1,
} as const