import { z } from 'zod';

/**
 * A zod enum that accepts any casing / surrounding whitespace and normalises to the canonical spelling.
 *
 * Why: the platform itself spells OS values three ways (`ANDROID` on application records, `Android` on devices,
 * `android` in query strings), so agents routinely echo one spelling into a tool whose enum wants another — observed
 * in the fidelity eval (`osType: "ANDROID"` → "expected one of ios|android"; `os: "ANDROID"` → "expected iOS|Android").
 * The published JSON schema still lists only the canonical values (verified: zod-to-json-schema renders the inner enum).
 */
export function caseInsensitiveEnum<const T extends readonly [string, ...string[]]>(values: T): ReturnType<typeof enumCore<T>>;
export function caseInsensitiveEnum<const T extends readonly [string, ...string[]]>(values: T, opts: { default: T[number] }): ReturnType<typeof enumCoreWithDefault<T>>;
export function caseInsensitiveEnum<const T extends readonly [string, ...string[]]>(values: T, opts?: { default: T[number] }) {
  return opts ? enumCoreWithDefault(values, opts.default) : enumCore(values);
}

function canonicalizer<const T extends readonly [string, ...string[]]>(values: T) {
  return (v: unknown) => {
    if (typeof v !== 'string') return v;
    const key = v.trim().toLowerCase();
    return values.find((c) => c.toLowerCase() === key) ?? v;
  };
}

function enumCore<const T extends readonly [string, ...string[]]>(values: T) {
  return z.preprocess(canonicalizer(values), z.enum(values));
}

/**
 * The default must live INSIDE the preprocess: `z.preprocess(...).optional().default(x)` drops `default` from the
 * published JSON schema (verified with zod 4.6), while `z.preprocess(fn, z.enum(values).optional().default(x))`
 * keeps it and still normalises casing. Pass `{ default }` instead of chaining `.optional().default()`.
 */
function enumCoreWithDefault<const T extends readonly [string, ...string[]]>(values: T, def: T[number]) {
  return z.preprocess(canonicalizer(values), z.enum(values).optional().default(def));
}

/** OS as the applications / query-string endpoints spell it. */
export const osTypeLower = () => caseInsensitiveEnum(['ios', 'android']);
/** OS as device and transaction records spell it. */
export const osTypeTitle = () => caseInsensitiveEnum(['Android', 'iOS']);
