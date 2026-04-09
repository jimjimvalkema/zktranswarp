import type { Hash, PublicClient } from "viem";

/**
 * Tiny reusable gas tracker for tests.
 *
 * Usage:
 *   const report = new GasReport("Token");
 *   await report.recordTx("transfer", txHash, publicClient);
 *   report.record("verify", gasBigInt);
 *   report.print(); // logs a min/max/avg table per label
 */
export class GasReport {
    readonly title: string;
    readonly samples: Record<string, bigint[]> = {};

    constructor(title: string = "gas report") {
        this.title = title;
    }

    record(label: string, gas: bigint): void {
        (this.samples[label] ??= []).push(gas);
    }

    async recordTx(label: string, hash: Hash, publicClient: PublicClient): Promise<bigint> {
        const receipt = await publicClient.getTransactionReceipt({ hash });
        this.record(label, receipt.gasUsed);
        return receipt.gasUsed;
    }

    summary(): Record<string, { count: number; min: number; max: number; avg: number }> {
        const out: Record<string, { count: number; min: number; max: number; avg: number }> = {};
        for (const [label, values] of Object.entries(this.samples)) {
            if (values.length === 0) continue;
            let min = values[0];
            let max = values[0];
            let sum = 0n;
            for (const v of values) {
                if (v < min) min = v;
                if (v > max) max = v;
                sum += v;
            }
            out[label] = {
                count: values.length,
                min: Number(min),
                max: Number(max),
                avg: Number(sum / BigInt(values.length)),
            };
        }
        return out;
    }

    print(): void {
        console.log(`\n=== ${this.title} (gas) ===`);
        console.table(this.summary());
    }
}
