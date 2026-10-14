import { z } from 'zod';

/**
 * A zod enum that accepts any casing / surrounding whitespace and normalises to the canonical spelling.
 *
 * Why: the platform itself spells OS values three ways (`ANDROID` on application records, `Android` on devices,
 * `android` in query strings), so agents routinely echo one spelling into a tool whose enum wants another — observed
 * in the fidelity eval (`osType: "ANDROID"` → "expected one of ios|android"; `os: "ANDROID"` → "expected iOS|Android").
 * The published JSON schema still lists only the canonical values (verified: zod-to-json-schema renders the inner enum).
 */
export function caseInsensitiveEnum<const T extends readonly [string, ...string[]]>(values: T) {
  const canon = (v: unknown) => {
    if (typeof v !== 'string') return v;
    const key = v.trim().toLowerCase();
    return values.find((c) => c.toLowerCase() === key) ?? v;
  };
  return z.preprocess(canon, z.enum(values));
}

/** OS as the applications / query-string endpoints spell it. */
export const osTypeLower = () => caseInsensitiveEnum(['ios', 'android']);
/** OS as device and transaction records spell it. */
export const osTypeTitle = () => caseInsensitiveEnum(['Android', 'iOS']);
