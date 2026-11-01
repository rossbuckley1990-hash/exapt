// Monetary quantities retain currency and scale. A number is not enough to
// establish that two monetary values can safely flow into one another.
import type { SemType } from "./types.ts";

export type MoneyUnit = "minor" | "major" | "unknown";

/** Conversion support is a registry of currency conventions, never providers. */
export const MONEY_CURRENCIES = [
  { code: "USD", decimals: 2, label: "US dollars", currency: /\busd\b|\bu\.?s\.?\s+(?:dollars?|cents?)\b|\bunited states dollars?\b/i },
  { code: "EUR", decimals: 2, label: "euros", currency: /\beur\b|\beuros?\b|€/i },
  { code: "GBP", decimals: 2, label: "pounds sterling", currency: /\bgbp\b|\bbritish (?:pounds?|pence|penn(?:y|ies))\b|\bpounds? sterling\b|\bsterling\b/i },
] as const;

export function moneyType(currency: string, unit: MoneyUnit): SemType {
  return `quantity:money:${currency}:${unit}`;
}

export function isQuantityType(type: SemType): boolean {
  return type.startsWith("quantity:");
}

/** Unresolved quantities are evidence of ambiguity, not permission to bind. */
export function isResolvedQuantity(type: SemType): boolean {
  return /^quantity:money:[A-Z]{3}:(minor|major)$/.test(type);
}

export function inferMoneyType(name: string, description = ""): SemType | undefined {
  const words = `${name.replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2").replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/_/g, " ")} ${description}`;
  // A contrast such as "US dollars, not cents" declares only dollars. Do not
  // interpret words explicitly excluded by the contract as positive evidence.
  const positive = words.replace(/\b(?:not|never|excluding|except)\b[^,.;]*?(?=\bbut\b|[,.;]|$)/gi, " ");
  const currencies = MONEY_CURRENCIES.filter((c) => c.currency.test(positive));
  const money = /\b(money|monetary|currency|amount|price|cost|balance|payment)\b/i.test(positive) || currencies.length > 0;
  const minor = /\b(cents?|pence|penn(?:y|ies))\b/i.test(positive) || (money && /\bminor\s+units?\b/i.test(positive));
  const unitWords = positive.replace(/\b(?:dollars?|euros?|pounds?)\s+(?=cents?\b|pence\b|penn(?:y|ies)\b)/gi, "");
  const major = /\b(dollars?|euros?|pounds?)\b|€/i.test(unitWords) || (money && /\bmajor\s+units?\b/i.test(positive));
  // A bare "$" does not identify USD. A bare "cent" does not identify a currency.
  if (!currencies.length && !minor && !major) return undefined;
  const currency = currencies.length === 1 ? currencies[0].code : "unknown";
  const unit: MoneyUnit = minor === major ? "unknown" : minor ? "minor" : "major";
  return moneyType(currency, unit);
}

/**
 * Quantize decimal text before converting, avoiding binary-float errors such as
 * 1.005 * 100. Major -> minor rounds half away from zero; minor -> major requires
 * an integer count. Results must remain within the safe integer minor-unit range.
 */
export function convertMoney(value: unknown, currency: string, from: "minor" | "major", to: "minor" | "major"): number {
  const convention = MONEY_CURRENCIES.find((c) => c.code === currency);
  if (!convention) throw new Error(`unsupported currency: ${currency}`);
  if (from === to) throw new Error("monetary conversion must change units");
  if (typeof value !== "number" && typeof value !== "string") throw new Error("monetary amount must be a finite decimal number");
  if (typeof value === "number" && !Number.isFinite(value)) throw new Error("monetary amount must be finite");
  const text = String(value).trim();
  const match = /^([+-]?)(\d+)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/.exec(text);
  if (!match || text.length > 200) throw new Error("monetary amount must be a finite decimal number");
  const exponent = Number(match[4] ?? 0);
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 100) throw new Error("monetary amount exponent is out of range");
  const fraction = match[3] ?? "";
  const digits = BigInt(match[2] + fraction);
  const scale = exponent - fraction.length + (from === "major" ? convention.decimals : 0);
  let minor: bigint;
  if (scale >= 0) minor = digits * 10n ** BigInt(scale);
  else {
    const divisor = 10n ** BigInt(-scale);
    const remainder = digits % divisor;
    if (from === "minor" && remainder !== 0n) throw new Error("minor-unit amount must be an integer");
    minor = digits / divisor + (from === "major" && remainder * 2n >= divisor ? 1n : 0n);
  }
  if (match[1] === "-") minor = -minor;
  if (minor > BigInt(Number.MAX_SAFE_INTEGER) || minor < BigInt(Number.MIN_SAFE_INTEGER)) throw new Error("monetary amount exceeds the safe minor-unit range");
  const result = to === "minor" ? Number(minor) : Number(minor) / 10 ** convention.decimals;
  // Large major-unit numbers may not preserve every cent as a JS number.
  if (to === "major" && convertMoney(result, currency, "major", "minor") !== Number(minor)) throw new Error("monetary conversion would lose minor-unit precision");
  return result;
}
