import { hashTypedData, hexToBigInt, recoverPublicKey, type Address, type Hash, type Hex, type Signature } from "viem";
import type { SignatureData, SignatureInputs, SignatureInputsWithFee, U8sAsHexArrLen32, U8sAsHexArrLen64 } from "./types.ts";
import { getPrivateReMintDomain, PRIVATE_RE_MINT_712_TYPES, PRIVATE_RE_MINT_RELAYER_712_TYPES } from "./constants.ts";
import type { BurnViewKeyManager } from "./BurnViewKeyManager.ts";
import { poseidon2Hash } from "@zkpassport/poseidon2";
import { hexToU8sAsHexArr } from "./utils.ts";

export async function extractPubKeyFromSig({hash, signature}:{hash: Hash, signature: Signature | Hex}) {
    const publicKey = await recoverPublicKey({
        hash: hash,
        signature: signature
    });
    const pubKeyX = "0x" + publicKey.slice(4).slice(0, 64) as Hex
    const pubKeyY = "0x" + publicKey.slice(4).slice(64, 128) as Hex
    return { pubKeyX, pubKeyY }
}

export function getViewingKey({ signature }: { signature: Hex }) {
    // deterministically create a viewing key from a signature
    // sigR is split in 2 and hashed since it can be larger then the field limit (could do modulo but didn't feel like worrying about bias)
    const sigR = signature.slice(0, 2 + 128)
    const sigRLow = hexToBigInt(sigR.slice(0, 2 + 32) as Hex)
    const sigRHigh = hexToBigInt("0x" + sigR.slice(2 + 32, 2 + 64) as Hex)
    const viewingKey = poseidon2Hash([sigRLow, sigRHigh])
    return viewingKey
}

export async function signPrivateTransfer(
    burnViewKeyManager: BurnViewKeyManager, signatureInputs: SignatureInputs | SignatureInputsWithFee, chainId: number, tokenAddress: Address, signingEthAccount: Address
): Promise<{ viemFormatSignature: { signature: Hex; pubKeyX: Hex; pubKeyY: Hex; }, signatureData: SignatureData, signatureHash: Hex }>;

export async function signPrivateTransfer(
    burnViewKeyManager: BurnViewKeyManager, signatureInputs: SignatureInputs | SignatureInputsWithFee, chainId: number, tokenAddress: Address, signingEthAccount: Address
): Promise<{ viemFormatSignature: { signature: Hex; pubKeyX: Hex; pubKeyY: Hex; }, signatureData: SignatureData, signatureHash: Hex }>;

// TODO make signingEthAccount optional, and have BurnViewKeyManager have a list that the user can order, where top one is the default account used
export async function signPrivateTransfer(burnViewKeyManager: BurnViewKeyManager, signatureInputs: SignatureInputs | SignatureInputsWithFee, chainId: number, tokenAddress: Address, signingEthAccount: Address):
    Promise<{ viemFormatSignature: { signature: Hex; pubKeyX: Hex; pubKeyY: Hex; }, signatureData: SignatureData, signatureHash: Hex }> {
    chainId ??= await burnViewKeyManager.viemWallet.getChainId()
    const domain = getPrivateReMintDomain(chainId, signatureInputs.contract)

    const baseMessage = {
        _recipient: signatureInputs.recipient,
        _amount: BigInt(signatureInputs.amountToReMint),
        _callData: signatureInputs.callData,
        _callCanFail: signatureInputs.callCanFail,
        _callValue: BigInt(signatureInputs.callValue),
        _encryptedTotalMinted: signatureInputs.encryptedTotalMinted,
    }

    let types, primaryType, message, hash, signature
    if ("feeData" in signatureInputs && signatureInputs.feeData) {
        types = PRIVATE_RE_MINT_RELAYER_712_TYPES
        primaryType = "reMintRelayer" as const
        message = {
            ...baseMessage,
            _feeData: {
                tokensPerEthPrice: BigInt(signatureInputs.feeData.tokensPerEthPrice),
                maxFee: BigInt(signatureInputs.feeData.maxFee),
                amountForRecipient: BigInt(signatureInputs.feeData.amountForRecipient),
                relayerBonus: BigInt(signatureInputs.feeData.relayerBonus),
                estimatedGasCost: BigInt(signatureInputs.feeData.estimatedGasCost),
                estimatedPriorityFee: BigInt(signatureInputs.feeData.estimatedPriorityFee),
                refundAddress: signatureInputs.feeData.refundAddress,
                relayerAddress: signatureInputs.feeData.relayerAddress,
            },
        }
        // hash and sign: else case does exactly the same but typescript freaks out if outside of if clause
        hash = hashTypedData({ domain, types, primaryType, message })
        signature = await burnViewKeyManager.viemWallet.signTypedData({ account: signingEthAccount, domain, types, primaryType, message })
    } else {
        types = PRIVATE_RE_MINT_712_TYPES
        primaryType = "reMint" as const
        message = baseMessage
        // hash and sign: same as above but typescript freaks out if outside of if clause
        hash = hashTypedData({ domain, types, primaryType, message })
        signature = await burnViewKeyManager.viemWallet.signTypedData({ account: signingEthAccount, domain, types, primaryType, message })
    }
    const { pubKeyX, pubKeyY } = await extractPubKeyFromSig({ hash, signature })
    return {
        viemFormatSignature: { signature, pubKeyX, pubKeyY },
        signatureData: {
            public_key_x: hexToU8sAsHexArr(pubKeyX, 32) as U8sAsHexArrLen32,
            public_key_y: hexToU8sAsHexArr(pubKeyY, 32) as U8sAsHexArrLen32,
            signature: hexToU8sAsHexArr(signature.slice(0, 2 + 128) as Hex, 64) as U8sAsHexArrLen64,
        },
        signatureHash: hash,
    }
}