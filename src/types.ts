import type { Address, GetContractReturnType, Hex, PublicClient, WalletClient } from "viem";
import type { WormholeToken$Type } from "../artifacts/contracts/WormholeToken.sol/artifacts.js";
import type { InputMap } from "@noir-lang/noir_js";
import type { UltraHonkBackend } from "@aztec/bb.js";
import { LeanIMT } from "@zk-kit/lean-imt";

export type WormholeToken = GetContractReturnType<WormholeToken$Type["abi"], Required<{ public?: PublicClient; wallet?: WalletClient; }>>

// we could use import type { FixedLengthArray } from 'type-fest';
// but for now i just do branded types so it yells at you if you do something stupid, but it doesn't check the length
export type U8AsHex = Hex & { __brand: 'u8AsHex' }
export type U8sAsHexArrLen32 = U8AsHex[] & { __brand: 'u8sAsHexArrLen32' }
export type U8sAsHexArrLen64 = U8AsHex[] & { __brand: 'u8sAsHexArrLen64' }
export type U32AsHex = Hex & { __brand: 'u32AsHex' }
export type U1AsHexArr = Hex[] & { __brand: 'u1AsHexArr' }

type PartialBy<T, K extends keyof T> = Omit<T, K> & Partial<Pick<T, K>>;

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
    recipient: Address,
    amountToReMint: Hex,
    callData: Hex,
    callValue: Hex,
    callCanFail: boolean,
    encryptedTotalMinted: Hex[],
}

export interface SignatureInputsWithFee {
    recipient: Address,
    amountToReMint: Hex,
    callData: Hex,
    callValue: Hex,
    callCanFail: boolean,
    encryptedTotalMinted: Hex[],
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

export type BurnAccountBase = {
    // always needed
    readonly ethAccount: Address,
    readonly difficulty: Hex,
    readonly chainId: Hex;

    // needed for standard viewKey derivation to recover the rest
    readonly viewKeySigMessage: string;
    readonly viewingKeyIndex: number;

    // always recoverable
    readonly burnAddress: Address;
    readonly blindedAddressDataHash: Hex;
    readonly spendingPubKeyX: Hex,

    // recoverable in standard viewKey derivation with ex: BurnViewKeyManager.createBurnAccount({viewKeySigMessage, viewingKeyIndex, difficulty, chainId, ethAccount}) 
    readonly powNonce: Hex;
    readonly viewingKey: Hex;
}

export type BurnAccountSyncData = {
    // state
    accountNonce: Hex,
    totalSpent: Hex,
    totalBurned: Hex,
    spendableBalance: Hex,

    // syncing stopped at this block (includes that block)
    lastSyncedBlock: Hex,
    // lowest possible block where a root can be used to proof
    minProvableBlock: Hex,
}

// when viewKey derivation is known, these keys can always be recovered
type DerivedRecoverableKeys = "spendingPubKeyX" | "burnAddress" | "powNonce" | "viewingKey" | "blindedAddressDataHash";
type DerivationKeys = "viewKeySigMessage" | "viewingKeyIndex";
// same as derived but "powNonce" "viewingKey" cant be derived since derivation is unknown
type UnknownRecoverableKeys = "spendingPubKeyX" | "burnAddress" | "blindedAddressDataHash";

// -------------- known derivation types -------------------------
export type UnsyncedDerivedBurnAccount = BurnAccountBase;
export type UnsyncedDerivedBurnAccountRecoverable = PartialBy<BurnAccountBase, DerivedRecoverableKeys>;
export type UnsyncedDerivedBurnAccountImportable = UnsyncedDerivedBurnAccountRecoverable & Pick<BurnAccountSyncData, "accountNonce" | "lastSyncedBlock" | "minProvableBlock">
export type SyncedDerivedBurnAccount = UnsyncedDerivedBurnAccount & BurnAccountSyncData;
export type DerivedBurnAccount = UnsyncedDerivedBurnAccount & Partial<BurnAccountSyncData>;

// -------------- unknown derivation types -------------------------
export type UnsyncedUnknownBurnAccount = Omit<BurnAccountBase, DerivationKeys>;
export type UnsyncedUnknownBurnAccountRecoverable = PartialBy<Omit<BurnAccountBase, DerivationKeys>, UnknownRecoverableKeys>;
export type UnsyncedUnknownBurnAccountImportable = UnsyncedUnknownBurnAccountRecoverable & Pick<BurnAccountSyncData, "accountNonce" | "lastSyncedBlock" | "minProvableBlock">
export type SyncedUnknownBurnAccount = UnsyncedUnknownBurnAccount & BurnAccountSyncData;
export type UnknownBurnAccount = UnsyncedUnknownBurnAccount & Partial<BurnAccountSyncData>;

export type BurnAccount = UnknownBurnAccount | DerivedBurnAccount;
export type UnsyncedBurnAccount = UnsyncedUnknownBurnAccount | UnsyncedDerivedBurnAccountRecoverable
export type SyncedBurnAccount = SyncedUnknownBurnAccount | SyncedDerivedBurnAccount

export interface PubKeyHex { x: Hex, y: Hex }

export type BurnAccountStorage = Record<Address, {
    pubKey?: PubKeyHex,
    detViewKeyCounter: number,
    /** stores mapping of chainId=>powDifficulty=>{detBurnAccount:BurnAccount[]}. Where chainId and powDifficulty are 32 byte padded Hex. 
    * burnAccounts[toHex(chainId,{size:32})][toHex(powDifficulty,{size:32})] = BurnAccount */
    burnAccounts: Record<Hex, Record<Hex,
        {
            derivedBurnAccounts: DerivedBurnAccount[],
            unknownBurnAccounts: UnknownBurnAccount[]
        }>>,
}>
export interface PrivateWalletData {
    readonly viewKeySigMessage: string,
    detViewKeyRoot?: Hex,

    // ethAccountAddress(spending key)=>detBurnAccount=>chainId=>powDifficulty=>viewKeyIndex=>BurnAccount
    burnAccounts: BurnAccountStorage
}
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

export interface PreSyncedTreeStringifyable {
    exportedNodes: string,
    lastSyncedBlock: Hex,
    firstSyncedBlock: Hex,
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


//functions
export type CreateRelayerInputsOpts = {
    threads?: number;
    chainId?: bigint;
    callData?: Hex;
    callCanFail?: boolean;
    callValue?: bigint;
    burnAddresses?: Address[];
    preSyncedTree?: PreSyncedTree;
    backend?: UltraHonkBackend;
    deploymentBlock?: bigint;
    blocksPerGetLogsReq?: bigint;
    circuitSize?: number;
    powDifficulty?: Hex;
    reMintLimit?: Hex;
    maxTreeDepth?: number;
    encryptedBlobLen?: number;
    circuitSizes?: number[];
};

export interface BurnAccountProof {
    burnAccount: SyncedBurnAccount,
    merkleProofs: SpendableBalanceProof,
    claimAmount: bigint
}

export interface FakeBurnAccountProof {
    burnAccount: FakeBurnAccount,
}