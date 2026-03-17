import type { Hex, Signature, Account, Hash, WalletClient, Address, } from "viem";
import { recoverPublicKey, hashMessage, hexToBigInt, hexToBytes, toHex, getAddress, keccak256, toPrefixedMessage, encodePacked, padHex, bytesToHex, hashTypedData } from "viem";
import { poseidon2Hash } from "@zkpassport/poseidon2"
import { BURN_ADDRESS_TYPE, EAS_BYTE_LEN_OVERHEAD, ENCRYPTED_TOTAL_SPENT_PADDING, FAKE_LEAF_DOMAIN, FAKE_NULLIFIER_DOMAIN, getPrivateReMintDomain, NULLIFIER_DOMAIN, PRIVATE_RE_MINT_712_TYPES, PRIVATE_RE_MINT_RELAYER_712_TYPES, TOTAL_BURNED_DOMAIN as TOTAL_BURNED_DOMAIN, TOTAL_MINTED_DOMAIN, VIEWING_KEY_SIG_MESSAGE } from "./constants.ts";
import type { FeeData, SignatureData, SignatureInputs, SignatureInputsWithFee, U8AsHex, U8sAsHexArrLen32, U8sAsHexArrLen64 } from "./types.ts";
import { BurnViewKeyManager } from "./BurnViewKeyManager.ts"
import { encryptTotalSpend } from "./syncing.ts";

// ------------- circuit spec -------------------

export function hashAddress({ blindedAddressDataHash, powNonce }: { blindedAddressDataHash: bigint, powNonce: bigint }) {
    //const pubKeyField = hexToBigInt("0x" + pubKeyX.slice(2 + 2) as Hex) //slice first byte so it fits in a field
    const addressHash = poseidon2Hash([blindedAddressDataHash, powNonce, BURN_ADDRESS_TYPE]);
    return addressHash
}

export function getBurnAddress({ blindedAddressDataHash, powNonce }: { blindedAddressDataHash: bigint, powNonce: bigint }) {
    const addressHash = hashAddress({ blindedAddressDataHash, powNonce })
    return getAddress("0x" + toHex(addressHash, { size: 32 }).slice(2 + 24)) //slice off bytes and make it the address type in viem
}

export function verifyPowNonce({ blindedAddressDataHash, powNonce, difficulty }: { blindedAddressDataHash: bigint, powNonce: bigint, difficulty: bigint }) {
    const powHash = hashPow({ blindedAddressDataHash, powNonce });
    return powHash < difficulty
}

export function hashBlindedAddressData(
    { spendingPubKeyX, viewingKey, chainId }:
        { spendingPubKeyX: Hex, viewingKey: bigint, chainId: bigint, }
): bigint {
    //slice first byte so it fits in a field
    const spendingPubKeyXField = hexToBigInt("0x" + spendingPubKeyX.slice(2 + 2) as Hex)
    //const viewingKeyField = hexToBigInt("0x" + viewingKey.slice(2 + 2) as Hex)
    const blindedAddressDataHash = poseidon2Hash([spendingPubKeyXField, viewingKey, chainId]);
    return blindedAddressDataHash
}

export function hashFakeLeaf({viewingKey}:{viewingKey:bigint}): bigint {
    return poseidon2Hash([viewingKey, FAKE_LEAF_DOMAIN])
}

export function hashFakeNullifier({viewingKey}:{viewingKey:bigint}): bigint {
    return poseidon2Hash([viewingKey, FAKE_NULLIFIER_DOMAIN])
}

export function hashPow({ blindedAddressDataHash, powNonce }: { blindedAddressDataHash: bigint, powNonce: bigint }) {
    const powHash = poseidon2Hash([blindedAddressDataHash, powNonce]);
    return powHash
}

// prev_account_nonce makes sure the hash is never the same even when the total_spent is not different
// secret is so others cant try and find the pre-image (since this hash is posted onchain)
export function hashTotalSpentLeaf({ totalSpent, accountNonce, blindedAddressDataHash, viewingKey }: { totalSpent: bigint, accountNonce: bigint, blindedAddressDataHash: bigint, viewingKey: bigint }) {
    return poseidon2Hash([totalSpent, accountNonce, blindedAddressDataHash, viewingKey, TOTAL_MINTED_DOMAIN])
}

// prev_account_nonce makes sure the hash is never the same even when the total_spent is not different
// secret is so others cant try and find the pre-image (since this hash is posted onchain)
export function hashNullifier({ accountNonce, viewingKey }: { accountNonce: bigint, viewingKey: bigint }) {
    return poseidon2Hash([accountNonce, viewingKey, NULLIFIER_DOMAIN])
}

export function hashTotalBurnedLeaf({ burnAddress, totalBurned }: { burnAddress: Address, totalBurned: bigint }) {
    return poseidon2Hash([hexToBigInt(burnAddress as Hex), totalBurned, TOTAL_BURNED_DOMAIN])
}

// ----------
export function hashViewKeyFromRoot(viewKeyRoot:bigint, viewingKeyIndex:bigint) {
    return poseidon2Hash([
            viewKeyRoot,
            viewingKeyIndex
        ])

}
// ------------


// ----------- ease of use -----------------


export function getBurnAddressSafe({ blindedAddressDataHash, powNonce, difficulty }: { blindedAddressDataHash: bigint, powNonce: bigint, difficulty: bigint }) {
    const addressHash = hashAddress({ blindedAddressDataHash, powNonce })
    const powHash = hashPow({blindedAddressDataHash,powNonce});
    if (powHash < difficulty === false) {
        throw new Error(`
Invalid powNonce. 
powNonce:${toHex(powNonce, { size: 32 })} 
blindedAddressDataHash: ${toHex(blindedAddressDataHash, { size: 32 })}
results in a PoW hash of: ${toHex(powHash, { size: 32 })}
    `)
    }
    return getAddress("0x" + toHex(addressHash, { size: 32 }).slice(2 + 24)) //slice off bytes and make it the address type in viem
}

export function findPoWNonce({ blindedAddressDataHash, startingValue, difficulty }: { blindedAddressDataHash: bigint, startingValue: bigint, difficulty: bigint }) {
    let powNonce: bigint = startingValue;
    let powHash: bigint = hashPow({ blindedAddressDataHash, powNonce });
    let hashingRounds = 0
    const start = Date.now()
    console.log(`doing PoW. difficulty:${toHex(difficulty, { size: 32 })}`)
    do {
        if (powHash < difficulty) {
            break;
        }
        powNonce = powHash;
        powHash = hashPow({ blindedAddressDataHash, powNonce })
        hashingRounds += 1
    } while (powHash >= difficulty)
    console.log(
// `
// found powNonce:${toHex(powNonce, { size: 32 })} 
// with blindedAddressDataHash:${toHex(blindedAddressDataHash, { size: 32 })}, 
// `
// +
`did ${hashingRounds} hashing rounds. 
It took ${Date.now() - start}ms`)
    return powNonce
}

/**
 * @param param0 
 * @returns 
 */
export async function findPoWNonceAsync({
    blindedAddressDataHash,
    startingValue,
    difficulty,
}: {
    blindedAddressDataHash: bigint;
    startingValue: bigint;
    difficulty: bigint;
}): Promise<bigint> {
    const params = { blindedAddressDataHash, startingValue, difficulty };
    const isNode = typeof process !== "undefined" && process.versions != null && process.versions.node != null;
    if (isNode) {
        // node worker thread
        const { Worker } = await import("worker_threads");
        return new Promise((resolve, reject) => {
            const worker = new Worker(
                new URL("workers/findPowNonce.node.ts", import.meta.url),
                {
                    workerData: params,
                    execArgv: ["--import", "tsx"],
                },
            );
            worker.on("message", resolve);
            worker.on("error", reject);
            worker.on("exit", (code) => {
                if (code !== 0) reject(new Error(`Worker exited with code ${code}`));
            });
        });
    } else {
        // browser worker
        return new Promise((resolve, reject) => {
            const worker = new Worker(
                new URL("workers/findPowNonce.browser.js", import.meta.url),
                { type: "module" },
            );
            worker.onmessage = (e) => {
                resolve(e.data);
                worker.terminate();
            };
            worker.onerror = (e) => reject(e);
            worker.postMessage(params);
        });
    }
}



