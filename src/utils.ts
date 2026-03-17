import { bytesToHex, hexToBytes, padHex, toHex, type Address, type Hex } from "viem";
import type { WormholeTokenTest } from "../test/remint2.test.ts";
import type { BurnAccount, PrivateWalletData, U8AsHex, U8sAsHexArrLen32, U8sAsHexArrLen64, WormholeToken } from "./types.ts";
import type { BurnViewKeyManager } from "./BurnViewKeyManager.ts";
import { FIELD_MODULUS } from "./constants.ts";

export function padWithRandomHex({ arr, len, hexSize, dir }: { arr: Hex[], len: number, hexSize: number, dir: 'left' | 'right' }): Hex[] {
    const padding = Array.from({ length: len - arr.length }, () =>
        bytesToHex(crypto.getRandomValues(new Uint8Array(hexSize)))
    )
    return dir === 'left' ? [...padding, ...arr] : [...arr, ...padding]
}

// get random value until it fits within field limit (rejection sampling)
export function randomBN254FieldElement(): bigint {
    while (true) {
        const bytes = new Uint8Array(32);
        crypto.getRandomValues(bytes);
        const val = bytes.reduce((acc, b) => (acc << 8n) | BigInt(b), 0n);
        if (val < FIELD_MODULUS) return val;
    }
}

export function getAvailableThreads() {
    if (typeof navigator !== undefined && 'hardwareConcurrency' in navigator) {
        return navigator.hardwareConcurrency ?? 1;
    } else {
        // TODO naively assumes that it runs on node if not in browser!
        return (process as any).availableParallelism()
    }
}


export function padArray<T>({ arr, size, value, dir }: { arr: T[], size: number, value?: T, dir?: "left" | "right" }): T[] {
    if (arr.length > size) { throw new Array(`array is larger then target size. Array len: ${arr.length}, target len: ${size}`) }
    dir = dir ?? "right"
    if (value === undefined) {
        if (typeof arr[0] === 'string' && arr[0].startsWith('0x')) {
            value = "0x00" as T
        } else if (typeof arr[0] === "bigint") {
            value = 0n as T
        } else {//if (typeof arr[0] === "number") {
            value = 0 as T
        }
    }

    const padding = (new Array(size - arr.length)).fill(value)
    return dir === "left" ? [...padding, ...arr] : [...arr, ...padding]
}

// ------ type utils ------
export function hexToU8sAsHexArr(hex: Hex, len: number): U8AsHex[] {
    const unPadded = hexToByteArray(hex)
    const padded = padArray({ arr: unPadded, size: len, value: "0x00", dir: "left" })
    return padded as U8AsHex[]
}

export function hexToByteArray(hex: Hex): Hex[] {
    // Remove '0x' prefix and split into pairs of characters
    const hexWithoutPrefix = hex.slice(2)
    const bytes: Hex[] = []

    for (let i = 0; i < hexWithoutPrefix.length; i += 2) {
        bytes.push(`0x${hexWithoutPrefix.slice(i, i + 2)}` as Hex)
    }

    return bytes
}

export function hexToU8AsHexLen32(hex: Hex): U8sAsHexArrLen32 {
    const unPadded = [...hexToBytes(hex)].map((v) => toHex(v))
    return padArray({ size: 32, dir: "left", arr: unPadded }) as U8sAsHexArrLen32
}

export function hexToU8AsHexLen64(hex: Hex): U8sAsHexArrLen64 {
    const unPadded = [...hexToBytes(hex)].map((v) => toHex(v))
    return padArray({ size: 64, dir: "left", arr: unPadded }) as U8sAsHexArrLen64
}

// ------ wallet utils ------
function filterBurnAccounts(burnAccounts: Record<Hex, Record<Hex, BurnAccount[]>>, selectedDifficulties?: Hex[], selectedChainIds?: Hex[]): BurnAccount[] {
    selectedChainIds ??= Object.keys(burnAccounts) as Hex[];

    return selectedChainIds.flatMap(chainId => {
        const burnAccountsPerDiff = burnAccounts[chainId];
        if (!burnAccountsPerDiff) return [];

        // remember: can't use ??= here  it would assign on the first iteration and
        // carry over to all subsequent chainIds, ignoring their actual difficulties.
        const difficulties = selectedDifficulties ?? Object.keys(burnAccountsPerDiff) as Hex[];

        return difficulties.flatMap(difficulty => burnAccountsPerDiff[difficulty] ?? []);
    });
}

/**
 * 
 * Retrieves stored burn accounts, with optional filtering by chain ID, difficulty,
 * and account type.
 *
 * @param options - Optional filter configuration.
 * @param options.difficulties - If provided, only returns accounts matching these PoW difficulties.
 *   Defaults to all difficulties.
 * @param options.chainIds - If provided, only returns accounts matching these chain IDs.
 *   Defaults to all chain IDs.
 * @param options.deterministicAccounts - Whether to include deterministic accounts. Defaults to `true`.
 * @param options.nonDeterministicAccounts - Whether to include non-deterministic accounts. Defaults to `true`.
 *
 * @returns A flat array of matching {@link BurnAccount} objects.
 */
export function getAllBurnAccounts(privateData: PrivateWalletData, ethAccount:Address,
    { difficulties, chainIds, deterministicAccounts = true, nonDeterministicAccounts = true }:
        { difficulties?: bigint[], chainIds?: bigint[], deterministicAccounts?: boolean, nonDeterministicAccounts?: boolean } = {}
): BurnAccount[] {
    const difficultiesHex = difficulties !== undefined ? difficulties.map((diff) => padHex(toHex(diff), { size: 32 })) : undefined;
    const chainIdsHex = chainIds !== undefined ? chainIds.map((chainId) => padHex(toHex(chainId), { size: 32 })) : undefined;

    return [
        ...(deterministicAccounts ? filterBurnAccounts(privateData.burnAccounts[ethAccount], difficultiesHex, chainIdsHex) : []),
        ...(nonDeterministicAccounts ? filterBurnAccounts(privateData.burnAccounts[ethAccount], difficultiesHex, chainIdsHex) : []),
    ];
}

// TODO move this into BurnViewKeyManager
// it requires every function that requires a class as input, should just use `this` instead
export function getDeterministicBurnAccounts(burnWallet: BurnViewKeyManager, ethAccount:Address,
    { difficulty = burnWallet.defaults.powDifficulty, chainId = burnWallet.defaults.chainId }:
        { difficulty?: bigint, chainId?: bigint } = {}

): BurnAccount[] {
    const difficultyPadded = toHex(difficulty, { size: 32 })
    const chainIdPadded = toHex(chainId, { size: 32 })
    return burnWallet.privateData.burnAccounts[ethAccount].detBurnAccounts[chainIdPadded][difficultyPadded]
}

// TODO
// export async function getFreshBurnAccount(BurnViewKeyManager: BurnViewKeyManager, wormholeToken: WormholeTokenTest | WormholeToken) {
//     const neverUsedBurnAccounts = getAllBurnAccounts(BurnViewKeyManager.privateData, ethAccount).filter(async (b) => await wormholeToken.read.balanceOf([b.burnAddress]) === 0n)
// }

export async function getCircuitSizesFromContract(wormholeToken: WormholeToken | WormholeTokenTest) {
    const AMOUNT_OF_VERIFIERS = await wormholeToken.read.AMOUNT_OF_VERIFIERS()
    const sizes = await Promise.all(new Array(AMOUNT_OF_VERIFIERS).fill(0).map((v, index) => wormholeToken.read.VERIFIER_SIZES([BigInt(index)])))
    return sizes
}

export function getCircuitSize(amountBurnAddresses: number, circuitSizes: number[]) {
    return circuitSizes.find((v) => v >= amountBurnAddresses) as number
}
