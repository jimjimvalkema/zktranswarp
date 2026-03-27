import { z } from "zod";
import { isHex, isAddress } from "viem";

// --- zodified viem types  ---------------------------------------------------------------

const HexSchema = z.custom<import("viem").Hex>(
    (val) => typeof val === "string" && isHex(val),
    "Invalid hex"
);
const AddressSchema = z.custom<import("viem").Address>(
    (val) => typeof val === "string" && isAddress(val),
    "Invalid address"
);

// --- base schemas -------------------------------------------------------------

export const BurnAccountBaseSchema = z.object({
    // always needed
    ethAccount: AddressSchema,
    difficulty: HexSchema,
    chainId: HexSchema,

    // needed for standard viewKey derivation to recover the rest
    viewKeySigMessage: z.string(),
    viewingKeyIndex: z.number().int().nonnegative(),

    // always recoverable
    burnAddress: AddressSchema,
    blindedAddressDataHash: HexSchema,
    spendingPubKeyX: HexSchema,

    // recoverable via BurnViewKeyManager.createBurnAccount({viewKeySigMessage, viewingKeyIndex, difficulty, chainId, ethAccount})
    powNonce: HexSchema,
    viewingKey: HexSchema,
});

export const BurnAccountSyncDataSchema = z.object({
    // state
    accountNonce: HexSchema,
    totalSpent: HexSchema,
    totalBurned: HexSchema,
    spendableBalance: HexSchema,

    // syncing stopped at this block (includes that block)
    lastSyncedBlock: HexSchema,

    // TODO maybe remove minProvableBlock, technically it's the last block accountNonce got update or the last tx the burn account received. Which ever is lowest. But then i need to scan for that tx when it received something. Not worth the rpc calls
    // SyncBurnAccount uses the "Nothing happened rule" which is not totally accurate. It's never too low, but usually too high. Maybe not minProvableBlock, but knownLowSafeProvableBlock. You can look for lower if you want

    // a know lower possible block where a root can be used to proof
    minProvableBlock: HexSchema,
});


/**
 * DerivedBurnAccounts:
 * Uses the standard way to derive viewing keys and the PoWNonces for burn accounts.
 * ViewingKey: Uses a standard message to sign to derive a root key, uses poseidon2 and a index to derive the viewingKey
 * PowNonce: repeatedly hashes the ViewingKey to arrive at a valid PoW
 * 
 * UnknownBurnAccounts: 
 * It's unknown how the viewKey is derived.
 * Does not have `derivationKeys` = `viewingKeyIndex` and `viewKeySigMessage`
 * 
 * UnsyncedTypes:
 * These are the base types, does not have sync data like totalSpent, accountNonce
 * All keys required and readonly
 * 
 * SyncedTypes:
 * Like UnsyncedTypes, all keys are required 
 * but the added keys from `BurnAccountSyncDataSchema` are mutable, rest is readonly.
 * 
 * RecoverableTypes:
 * Like UnsyncedTypes, but all keys that can be recovered are optional
 * 
 * ImportableTypes:
 * Like RecoverableTypes, but includes accountNonce, and blockNumbers for faster syncing when imported
 * 
 */

// Keys Derived + Recoverable types do *not* have
// when viewKey derivation is known, these keys can always be recovered
const derivedRecoverableKeys = { spendingPubKeyX: true, burnAddress: true, powNonce: true, viewingKey: true, blindedAddressDataHash: true } as const;

// Keys Derived + Recoverable types do *not* have
// same as derived but powNonce + viewingKey can't be recovered since derivation is unknown
const unknownRecoverableKeys = { spendingPubKeyX: true, burnAddress: true, blindedAddressDataHash: true } as const;

// Keys Importable is *required* to also have 
// Importable also needs Recoverable keys
// This speeds syncing the account when imported
const importableSyncData = { accountNonce: true, lastSyncedBlock: true, minProvableBlock: true } as const

// keys Derived family is *required* to have. And Unknown family does *not* have
const derivationKeys = { viewKeySigMessage: true, viewingKeyIndex: true } as const;

// --- derived family -----------------------------------------------------------

export const UnsyncedDerivedBurnAccountSchema = BurnAccountBaseSchema;
export const DerivedBurnAccountRecoverableSchema = BurnAccountBaseSchema.partial(derivedRecoverableKeys);
export const DerivedBurnAccountImportableSchema = DerivedBurnAccountRecoverableSchema.extend(BurnAccountSyncDataSchema.pick(importableSyncData).shape);
export const SyncedDerivedBurnAccountSchema = BurnAccountBaseSchema.extend(BurnAccountSyncDataSchema.shape);
export const DerivedBurnAccountSchema = BurnAccountBaseSchema.extend(BurnAccountSyncDataSchema.partial().shape);

// --- unknown family ----------------------------------------------------------

export const UnsyncedUnknownBurnAccountSchema = BurnAccountBaseSchema.omit(derivationKeys);
export const UnknownBurnAccountRecoverableSchema = UnsyncedUnknownBurnAccountSchema.partial(unknownRecoverableKeys);
export const UnknownBurnAccountImportableSchema = UnknownBurnAccountRecoverableSchema.extend(BurnAccountSyncDataSchema.pick(importableSyncData).shape);
export const SyncedUnknownBurnAccountSchema = UnsyncedUnknownBurnAccountSchema.extend(BurnAccountSyncDataSchema.shape);
export const UnknownBurnAccountSchema = UnsyncedUnknownBurnAccountSchema.extend(BurnAccountSyncDataSchema.partial().shape);

// --- unions ------------------------------------------------------------------
// merges families Derived + Unknown
export const BurnAccountImportableSchema = z.union([
    DerivedBurnAccountImportableSchema,
    UnknownBurnAccountImportableSchema,
]);

export const BurnAccountSchema = z.union([
    DerivedBurnAccountSchema,
    UnknownBurnAccountSchema,
]);

export const UnsyncedBurnAccountSchema = z.union([
    UnsyncedDerivedBurnAccountSchema,
    UnsyncedUnknownBurnAccountSchema,
]);

export const SyncedBurnAccountSchema = z.union([
    SyncedDerivedBurnAccountSchema,
    SyncedUnknownBurnAccountSchema,
]);

export const AnyBurnAccountSchema = z.union([
    BurnAccountSchema,
    BurnAccountImportableSchema,
    UnsyncedBurnAccountSchema,
    SyncedBurnAccountSchema,
]);

// --- inferred types ----------------------------------------------------------

// Zod doesn't infer `readonly`, so we re-apply it after inference.
// BaseFieldKeys are the fields that were readonly in the original BurnAccountBase.
type BaseFieldKeys = keyof z.infer<typeof BurnAccountBaseSchema>;
type WithReadonlyBase<T> = Omit<T, BaseFieldKeys> & Readonly<Pick<T, Extract<keyof T, BaseFieldKeys>>>;

export type BurnAccountBase = Readonly<z.infer<typeof BurnAccountBaseSchema>>;
export type BurnAccountSyncData = z.infer<typeof BurnAccountSyncDataSchema>;

export type UnsyncedDerivedBurnAccount = WithReadonlyBase<z.infer<typeof UnsyncedDerivedBurnAccountSchema>>;
export type DerivedBurnAccountRecoverable = WithReadonlyBase<z.infer<typeof DerivedBurnAccountRecoverableSchema>>;
export type DerivedBurnAccountImportable = WithReadonlyBase<z.infer<typeof DerivedBurnAccountImportableSchema>>;
export type SyncedDerivedBurnAccount = WithReadonlyBase<z.infer<typeof SyncedDerivedBurnAccountSchema>>;
export type DerivedBurnAccount = WithReadonlyBase<z.infer<typeof DerivedBurnAccountSchema>>;

export type UnsyncedUnknownBurnAccount = WithReadonlyBase<z.infer<typeof UnsyncedUnknownBurnAccountSchema>>;
export type UnknownBurnAccountRecoverable = WithReadonlyBase<z.infer<typeof UnknownBurnAccountRecoverableSchema>>;
export type UnknownBurnAccountImportable = WithReadonlyBase<z.infer<typeof UnknownBurnAccountImportableSchema>>;
export type SyncedUnknownBurnAccount = WithReadonlyBase<z.infer<typeof SyncedUnknownBurnAccountSchema>>;
export type UnknownBurnAccount = WithReadonlyBase<z.infer<typeof UnknownBurnAccountSchema>>;

export type BurnAccount = WithReadonlyBase<z.infer<typeof BurnAccountSchema>>;
export type UnsyncedBurnAccount = WithReadonlyBase<z.infer<typeof UnsyncedBurnAccountSchema>>;
export type SyncedBurnAccount = WithReadonlyBase<z.infer<typeof SyncedBurnAccountSchema>>;

// union types
export type BurnAccountImportable = DerivedBurnAccountImportable | UnknownBurnAccountImportable;
export type BurnAccountRecoverable = DerivedBurnAccountRecoverable | UnknownBurnAccountRecoverable;
export type AnyBurnAccount = BurnAccount | BurnAccountImportable | BurnAccountRecoverable;


// --- type guards -------------------------------------------------------------

// Use these instead of `"viewKeySigMessage" in x` — TypeScript cannot narrow
// through WithReadonlyBase with a plain `in` check.
export const isDerivedBurnAccount = (x: AnyBurnAccount): x is DerivedBurnAccount =>
    "viewKeySigMessage" in x;

export const isUnknownBurnAccount = (x: AnyBurnAccount): x is UnknownBurnAccount =>
    !("viewKeySigMessage" in x);

export const isSyncedBurnAccount = (x: BurnAccount): x is SyncedBurnAccount =>
    "totalSpent" in x && x.totalSpent !== undefined;

// --- types for type identification  -----------------------------------------------------------

export type BurnAccountDerivation = "Derived" | "Unknown";
export type BurnAccountState = "Recoverable" | "Importable" | "Unsynced" | "Synced";

export type BurnAccountType = {
    derivation: BurnAccountDerivation;
    state: BurnAccountState;
};

export type ParsedBurnAccount =
    | { derivation: "Derived"; state: "Synced"; account: SyncedDerivedBurnAccount }
    | { derivation: "Derived"; state: "Unsynced"; account: DerivedBurnAccount }
    | { derivation: "Derived"; state: "Importable"; account: DerivedBurnAccountImportable }
    | { derivation: "Derived"; state: "Recoverable"; account: DerivedBurnAccountRecoverable }
    | { derivation: "Unknown"; state: "Synced"; account: SyncedUnknownBurnAccount }
    | { derivation: "Unknown"; state: "Unsynced"; account: UnknownBurnAccount }
    | { derivation: "Unknown"; state: "Importable"; account: UnknownBurnAccountImportable }
    | { derivation: "Unknown"; state: "Recoverable"; account: UnknownBurnAccountRecoverable };

export type ParsedBurnAccounts = {
    full: {
        derived: DerivedBurnAccount[];
        unknown: UnknownBurnAccount[];
    };
    imported: {
        derived: (DerivedBurnAccountImportable | DerivedBurnAccountRecoverable)[];
        unknown: (UnknownBurnAccountImportable | UnknownBurnAccountRecoverable)[];
    };
};

// --- parse -------------------------------------------------------------------

/** Validates a single burn account of any variant. Use identifyBurnAccount to get the precise type. */
export function parseBurnAccount(item: unknown): AnyBurnAccount {
    return AnyBurnAccountSchema.parse(item);
}

/**
 * Identifies the family and variant of a burn account and returns it with the precise type.
 * Checks from most specific to least specific.
 * Uses presence of `viewKeySigMessage` to split Derived vs Unknown family.
 */
export function identifyBurnAccount(account: AnyBurnAccount): ParsedBurnAccount {
    if ("viewKeySigMessage" in account) {
        if (SyncedDerivedBurnAccountSchema.safeParse(account).success) return { derivation: "Derived", state: "Synced", account: SyncedDerivedBurnAccountSchema.parse(account) };
        if (DerivedBurnAccountImportableSchema.safeParse(account).success) return { derivation: "Derived", state: "Importable", account: DerivedBurnAccountImportableSchema.parse(account) };
        if (DerivedBurnAccountRecoverableSchema.safeParse(account).success) return { derivation: "Derived", state: "Recoverable", account: DerivedBurnAccountRecoverableSchema.parse(account) };
        return { derivation: "Derived", state: "Unsynced", account: DerivedBurnAccountSchema.parse(account) };
    } else {
        if (SyncedUnknownBurnAccountSchema.safeParse(account).success) return { derivation: "Unknown", state: "Synced", account: SyncedUnknownBurnAccountSchema.parse(account) };
        if (UnknownBurnAccountImportableSchema.safeParse(account).success) return { derivation: "Unknown", state: "Importable", account: UnknownBurnAccountImportableSchema.parse(account) };
        if (UnknownBurnAccountRecoverableSchema.safeParse(account).success) return { derivation: "Unknown", state: "Recoverable", account: UnknownBurnAccountRecoverableSchema.parse(account) };
        return { derivation: "Unknown", state: "Unsynced", account: UnknownBurnAccountSchema.parse(account) };
    }
}

/**
 * Parses a JSON string containing an array of burn accounts of any variant.
 * Throws on the first invalid account.
 * Returns accounts grouped by family and whether they are full or importable/recoverable.
 */
export function parseBurnAccountArray(json: string): ParsedBurnAccounts {
    const parsed = JSON.parse(json);
    if (!Array.isArray(parsed)) throw new Error("Import must be a JSON array");

    const result: ParsedBurnAccounts = {
        full: { derived: [], unknown: [] },
        imported: { derived: [], unknown: [] },
    };

    parsed.forEach((item) => {
        const idAccount = identifyBurnAccount(parseBurnAccount(item));

        if (idAccount.derivation === "Derived") {
            if (idAccount.state === "Unsynced" || idAccount.state === "Synced") {
                result.full.derived.push(idAccount.account as DerivedBurnAccount);
            } else {
                result.imported.derived.push(idAccount.account as DerivedBurnAccountImportable | DerivedBurnAccountRecoverable);
            }
        } else {
            if (idAccount.state === "Unsynced" || idAccount.state === "Synced") {
                result.full.unknown.push(idAccount.account as UnknownBurnAccount);
            } else {
                result.imported.unknown.push(idAccount.account as UnknownBurnAccountImportable | UnknownBurnAccountRecoverable);
            }
        }
    });

    return result;
}
// --- compound schemas --------------------------------------------------------

// 32-byte padded hex — used as chainId and difficulty keys (0x + 64 hex chars)
const Hex32Schema = z.custom<import("viem").Hex>(
    (val) => typeof val === "string" && isHex(val) && val.length === 66,
    "Invalid 32-byte hex (expected 0x + 64 hex chars)"
);

// Zod doesn't validate record keys natively — this helper adds superRefine to do so.
function keyValidatedRecord<S extends z.ZodTypeAny>(keySchema: z.ZodTypeAny, valueSchema: S) {
    return z.record(z.string(), valueSchema).superRefine((obj, ctx) => {
        for (const key of Object.keys(obj)) {
            const result = keySchema.safeParse(key);
            if (!result.success) {
                ctx.addIssue({
                    code: z.ZodIssueCode.custom,
                    message: `Invalid key "${key}": ${result.error.issues.map((i: z.ZodIssue) => i.message).join(", ")}`,
                    path: [key],
                });
            }
        }
    }) as z.ZodType<Record<string, z.infer<S>>>;
}

export const PubKeyHexSchema = z.object({
    x: HexSchema,
    y: HexSchema,
});

export type PubKeyHex = z.infer<typeof PubKeyHexSchema>;


const ViewKeyDataSchema = <T extends z.ZodTypeAny>(burnAccountSchema: T) => z.object({
    viewKeySigMessage: z.string(),
    detViewKeyRoot: HexSchema.optional(),
    burnAccounts: keyValidatedRecord(
        AddressSchema,
        z.object({
            pubKey: PubKeyHexSchema.optional(),
            detViewKeyCounter: z.number().int().nonnegative(),
            burnAccounts: keyValidatedRecord(
                Hex32Schema,
                keyValidatedRecord(
                    Hex32Schema,
                    z.object({
                        derivedBurnAccounts: z.array(burnAccountSchema),
                        unknownBurnAccounts: keyValidatedRecord(AddressSchema, burnAccountSchema),
                    })
                )
            ),
        })
    ),
});

// concrete schemas
export const FullViewKeyDataSchema = ViewKeyDataSchema(BurnAccountSchema);
export const ExportedViewKeyDataSchema = ViewKeyDataSchema(BurnAccountImportableSchema);
export const ExportedViewKeyDataParanoidSchema = ViewKeyDataSchema(z.union([DerivedBurnAccountRecoverableSchema, UnknownBurnAccountRecoverableSchema]));

// inferred types
export type FullViewKeyData = z.infer<typeof FullViewKeyDataSchema>;

// manually defined using WithReadonlyBase-wrapped types to avoid structural mismatch with Zod inference
export type ExportedViewKeyData<T = BurnAccountImportable> = Omit<FullViewKeyData, 'burnAccounts'> & {
    burnAccounts: Record<import("viem").Address, {
        pubKey?: PubKeyHex;
        detViewKeyCounter: number;
        burnAccounts: Record<import("viem").Hex, Record<import("viem").Hex, {
            derivedBurnAccounts: T[];
            unknownBurnAccounts: Record<import("viem").Address, T>;
        }>>;
    }>;
};

export const BurnAccountStorageSchema = FullViewKeyDataSchema.shape.burnAccounts;
export type BurnAccountStorage = z.infer<typeof BurnAccountStorageSchema>;