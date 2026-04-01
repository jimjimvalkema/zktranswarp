import type { Address, GetContractReturnType, Hex, PublicClient, WalletClient } from "viem";
import type { WormholeToken$Type } from "../artifacts/contracts/WormholeToken.sol/artifacts.js";
import type { InputMap } from "@noir-lang/noir_js";
import type { UltraHonkBackend } from "@aztec/bb.js";
import { LeanIMT } from "@zk-kit/lean-imt";
import type { DerivedBurnAccount, SyncedBurnAccount, UnknownBurnAccount, BurnAccountRecoverable, BurnAccountImportable, PubKeyHex, ExportedViewKeyData, PreSyncedTreeStringifyable } from "./schemas.ts";
import { number } from "zod";

export type WormholeClientArg =
    | { public: PublicClient; wallet: WalletClient }
    | { public: PublicClient }
    | { wallet: WalletClient };

export type WormholeToken<TClient extends WormholeClientArg = { public: PublicClient; wallet: WalletClient }> =
    GetContractReturnType<WormholeToken$Type["abi"], TClient>;
// we could use import type { FixedLengthArray } from 'type-fest';
// but for now i just do branded types so it yells at you if you do something stupid, but it doesn't check the length
export type U8AsHex = Hex & { __brand: 'u8AsHex' }
export type U8sAsHexArrLen32 = U8AsHex[] & { __brand: 'u8sAsHexArrLen32' }
export type U8sAsHexArrLen64 = U8AsHex[] & { __brand: 'u8sAsHexArrLen64' }
export type U32AsHex = Hex & { __brand: 'u32AsHex' }
export type U1AsHexArr = Hex[] & { __brand: 'u1AsHexArr' }

export type AtLeastOne<T> = Partial<T> & (
    { [K in keyof T]-?: Required<Pick<T, K>> }[keyof T]
);

export interface SignatureData extends InputMap {
    /** Must be exactly 32 bytes */
    public_key_x: U8sAsHexArrLen32;
    /** Must be exactly 32 bytes */
    public_key_y: U8sAsHexArrLen32;
    /** Must be exactly 64 bytes */
    signature: U8sAsHexArrLen64;
}

export interface FeeData {
    tokensPerEthPrice: Hex,
    maxFee: Hex,
    amountForRecipient: Hex,
    relayerBonus: Hex,
    estimatedGasCost: Hex,
    estimatedPriorityFee: Hex,
    refundAddress: Address,
    relayerAddress: Address,
}

export interface SignatureInputs {
    contract: Address,
    recipient: Address,
    amountToReMint: Hex,
    callData: Hex,
    callValue: Hex,
    callCanFail: boolean,
    encryptedTotalMinted: Hex[],
}

export interface SignatureInputsWithFee extends SignatureInputs {
    feeData: FeeData,
}

export interface MerkleData extends InputMap {
    depth: U32AsHex,
    // TODO maybe we can save on memory computing indices on the spot instead?
    indices: U1AsHexArr,
    siblings: Hex[],
}

export interface SpendableBalanceProof {
    totalSpendMerkleProofs: MerkleData,
    totalBurnedMerkleProofs: MerkleData,
    root: Hex
}

export interface BurnDataPublic extends InputMap {
    total_minted_leaf: Hex,
    nullifier: Hex,
}

export interface BurnDataPrivate extends InputMap {
    viewing_key: Hex,
    pow_nonce: Hex,
    total_burned: Hex,
    prev_total_minted: Hex,
    amount_to_mint: Hex,
    prev_account_nonce: Hex,
    prev_account_note_merkle_data: MerkleData,
    total_burned_merkle_data: MerkleData,
}

export interface PublicProofInputs extends InputMap {
    root: Hex,
    chain_id: Hex, // technically not public since we don't use the cross-chain functionality here, can be revealed does not leak user data
    amount: Hex,
    pow_difficulty: Hex,
    re_mint_limit: Hex
    signature_hash: U8sAsHexArrLen32,
    burn_data_public: BurnDataPublic[],
}

export interface PrivateProofInputs extends InputMap {
    signature_data: SignatureData,
    burn_data_private: BurnDataPrivate[],
    amount_burn_addresses: U32AsHex
}

export interface ProofInputs extends PublicProofInputs, PrivateProofInputs, InputMap { }

export interface ProofInputs1n extends ProofInputs {
    amount_burn_addresses: '0x0' & U32AsHex | '0x1' & U32AsHex;
}

export interface ProofInputs4n extends ProofInputs {
    amount_burn_addresses: '0x0' & U32AsHex | '0x1' & U32AsHex | '0x2' & U32AsHex | '0x3' & U32AsHex | '0x4' & U32AsHex;
}

export interface FakeBurnAccount {
    readonly viewingKey: Hex,
}

// burn account types are inferred from Zod schemas — edit shapes in burnAccountSchemas.ts
export type {
    BurnAccountBase,
    BurnAccountSyncFields,
    BurnAccountSyncData,
    UnsyncedDerivedBurnAccount,
    DerivedBurnAccountRecoverable,
    DerivedBurnAccountImportable,
    SyncedDerivedBurnAccount,
    DerivedBurnAccount,
    UnsyncedUnknownBurnAccount,
    UnknownBurnAccountRecoverable,
    UnknownBurnAccountImportable,
    SyncedUnknownBurnAccount,
    UnknownBurnAccount,
    BurnAccountImportable,
    BurnAccount,
    UnsyncedBurnAccount,
    SyncedBurnAccount,
    BurnAccountRecoverable,
    AnyBurnAccount,
    PubKeyHex,
    BurnAccountType,
    BurnAccountDerivation,
    BurnAccountState,
    ParsedBurnAccount,
    ParsedBurnAccounts,
    FullViewKeyData,
    ExportedViewKeyData,
    PreSyncedTreeStringifyable
} from "./schemas.ts";

export interface SignatureHashPreImg {
    recipientAddress: Address,
    amount: Hex,
    callData: Hex,
}

export interface PreSyncedTree {
    tree: LeanIMT<bigint>
    lastSyncedBlock: bigint,
    firstSyncedBlock: bigint
}

export interface SelfRelayInputs {
    publicInputs: PublicProofInputs,
    proof: Hex,
    signatureInputs: SignatureInputs,
}

export interface RelayInputs {
    publicInputs: PublicProofInputs,
    proof: Hex,
    signatureInputs: SignatureInputsWithFee,
}

/**backend per circuit size */
export type BackendPerSize =  {[key: number]:UltraHonkBackend}
//functions
export type CreateRelayerInputsOpts = {
    fullNode?: PublicClient
    threads?: number;
    callData?: Hex;
    callCanFail?: boolean;
    callValue?: bigint;
    burnAddresses?: Address[];
    /**backend per circuit size */
    backends?: BackendPerSize;
    deploymentBlock?: bigint;
    blocksPerGetLogsReq?: bigint;
    circuitSize?: number;
    encryptedBlobLen?: number;

    // cache-able
    preSyncedTree?: PreSyncedTree;

    chainId?: bigint;

    powDifficulty?: Hex;
    reMintLimit?: Hex;
    circuitSizes?: number[];
    maxTreeDepth?: number;
};

export interface BurnAccountProof {
    burnAccount: SyncedBurnAccount,
    merkleProofs: SpendableBalanceProof,
    claimAmount: bigint,
    chainId: import("viem").Hex
}

export interface FakeBurnAccountProof {
    burnAccount: FakeBurnAccount,
}

export interface ClientPerChainId {[chainId:number]:PublicClient}

export interface WormholeContractConfig {
    VERIFIER_SIZES: number[],
    VERIFIERS_PER_SIZE:{[size:number]:Address}
    POW_DIFFICULTY: Hex,
    RE_MINT_LIMIT: Hex,
    MAX_TREE_DEPTH: number
}
