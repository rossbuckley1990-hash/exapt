// Semantic typing: the part that turns isolated tools into a graph.
//
// Reflectors only see wire types ("string", "String!", "integer"). Two APIs
// that both say "string" can't be safely chained. Two APIs where one emits a
// `language` and the other accepts a `targetLanguage` can. This module infers
// semantic types from names, formats and descriptions, and defines the
// lattice that says which values can flow into which ports.

import { JsonRepresentationError, parseJsonValue } from "./json.ts";
import type { SemType } from "./types.ts";
import { inferMoneyType, isQuantityType, isResolvedQuantity } from "./quantities.ts";

/** child -> parent. Everything string-like is ultimately "text"; everything is "json". */
const PARENT: Record<string, SemType> = {
  url: "text",
  "image.url": "url",
  email: "text",
  html: "text",
  markdown: "text",
  language: "text",
  domain: "text",
  ip: "text",
  place: "text",
  country: "text",
  currency: "text",
  datetime: "text",
  id: "text",
  hash: "text",
  path: "text",
  account: "text",
  repo: "text",
  "repo.full": "text",
  color: "text",
  text: "json",
  number: "json",
  "geo.lat": "number",
  "geo.lon": "number",
  boolean: "json",
  json: "",
};

export const SEMANTIC_TYPES = Object.keys(PARENT);

export function parentOf(t: SemType): SemType | undefined {
  if (t.startsWith("list:")) return "json";
  if (isQuantityType(t)) return "number";
  if (t.startsWith("id.")) return "id";
  const p = PARENT[t];
  return p === undefined ? "json" : p || undefined;
}

/**
 * How far a produced value of type `produced` must be widened to fit a port of
 * type `wanted`. 0 = exact, n = n steps up the lattice, -1 = incompatible.
 */
export function distance(wanted: SemType, produced: SemType): number {
  if (wanted === produced) return 0;
  if (wanted.startsWith("list:") && produced.startsWith("list:")) {
    const d = distance(wanted.slice(5), produced.slice(5));
    return d < 0 ? -1 : d;
  }
  let d = 0;
  let t: SemType | undefined = produced;
  while (t !== undefined) {
    if (t === wanted) return d;
    t = parentOf(t);
    d++;
  }
  return -1;
}

/** A "strong" link carries meaning: exact type or one specific step up, never into bare json. */
export function strongly(wanted: SemType, produced: SemType): boolean {
  if (wanted === "json") return false;
  // Quantity widening is useful for a broad numeric goal, but must not erase
  // currency/units when binding an input. Ambiguous quantities never bind.
  if (wanted.startsWith("list:") && produced.startsWith("list:") &&
      [wanted, produced].some((t) => isQuantityType(t.replace(/^(?:list:)+/, "")))) return strongly(wanted.slice(5), produced.slice(5));
  if (isQuantityType(wanted) || isQuantityType(produced)) return wanted === produced && isResolvedQuantity(wanted);
  const d = distance(wanted, produced);
  if (d < 0) return false;
  if (wanted === "text") return d === 0;
  return d <= 1;
}

/** Ports that take the *name* of something: they accept specific string types (a place, a country). */
const NOMINAL = /^(title|q|query|search|term|keyword|topic|subject)$/i;
const NOT_NOMINAL = new Set(["html", "markdown", "text"]);

/** Can a value of type `value` flow into port (`name`, `type`)? */
export function accepts(portName: string, portType: SemType, value: SemType, anyText = false): boolean {
  if (strongly(portType, value)) return true;
  // A port shown to take any text (a program reading files) takes markup and other text kinds.
  // ...documents only: a language tag or a country code is text-shaped but not content.
  if (anyText && ["text", "html", "markdown"].includes(value) && distance("text", portType) >= 0) return true;
  return portType === "text" && NOMINAL.test(portName) && !NOT_NOMINAL.has(value) && distance("text", value) === 1;
}

export function isNominal(portName: string, portType: SemType): boolean {
  return portType === "text" && NOMINAL.test(portName);
}

const NAME_RULES: Array<[RegExp, SemType]> = [
  [/^(image|img|photo|avatar|thumbnail|picture|icon)(url|uri|link|src)?$/, "image.url"],
  [/(^|_)(url|uri|href|link|website|homepage|endpoint|webpage)$/, "url"],
  [/^(url|uri|href|link)s?$/, "url"],
  [/e?mail(address)?$/, "email"],
  [/^html|html$/, "html"],
  [/^(markdown|md)$/, "markdown"],
  [/(^|_)(lat|latitude)$/, "geo.lat"],
  [/(^|_)(lon|lng|long|longitude)$/, "geo.lon"],
  [/(lang|language|locale)(code)?$/, "language"],
  [/^(target|source|to|from)(lang|language)$/, "language"],
  [/(^|_)(country|countrycode|countryiso|iso2|iso3)$/, "country"],
  [/(^|_)(currency|currencycode)$/, "currency"],
  [/(^|_)(city|place|location|address|town|placename|region|capital)$/, "place"],
  [/(^|_)(domain|hostname|host)$/, "domain"],
  [/^(username|login|owner|user|org|organization|account|handle|screen_name|user_login|owner_login)$/, "account"],
  [/^(full_name|name_with_owner|full_repo_name|repo_full_name|repository_full_name)$/, "repo.full"],
  [/^(repo|repository|repo_name|repository_name)$/, "repo"],
  [/(^|_)(ip|ipaddress|ipv4|ipv6)$/, "ip"],
  [/(^|_)(date|time|datetime|timestamp|createdat|updatedat)$/, "datetime"],
  [/(^|_)(color|colour|hex)$/, "color"],
  [/(^|_)(sha\d*|hash|digest|checksum)$/, "hash"],
  [/(^|_)(path|file|filename|filepath|dir|directory)$/, "path"],
  [/(^|_)(id|uuid|guid|key|slug)$/, "id"],
];

function normalize(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "");
}

export interface SchemaLike {
  type?: string | string[];
  format?: string;
  items?: SchemaLike;
  enum?: unknown[];
  description?: string;
  example?: unknown;
  examples?: unknown;
  default?: unknown;
}

/** Bare directions name a role, not a kind of value: "to" may be a language, a currency or a date. */
const DIRECTIONAL = /^(to|from|source|target)$/;

/**
 * Types that published example values establish (OpenAPI example/examples/default/enum,
 * JSON Schema examples). Only specific types with high value confidence count, and all
 * examples must agree; otherwise the examples say nothing.
 */
function typeFromExamples(schema: SchemaLike): SemType | undefined {
  const ex = schema.examples;
  const values = [schema.example, ...(Array.isArray(ex) ? ex : ex && typeof ex === "object" ? Object.values(ex).map((e: any) => e?.value ?? e) : []), schema.default, ...(Array.isArray(schema.enum) ? schema.enum : [])]
    .filter((v) => typeof v === "string" && v.trim() !== "");
  if (!values.length) return undefined;
  const found = values.map((v) => inspectValue(v));
  const t = found[0].type;
  if (["text", "number", "json", "markdown"].includes(t) || found.some((f) => f.type !== t || f.confidence < 0.8)) return undefined;
  return t;
}

/** Infer a semantic type for a named value with an (optional) JSON-schema-ish shape. */
export function inferType(name: string, schema: SchemaLike = {}, description = ""): SemType {
  const rawType = Array.isArray(schema.type) ? schema.type.find((t) => t !== "null") : schema.type;
  if (rawType === "array") {
    const inner = inferType(singular(name), schema.items ?? {}, description);
    return `list:${inner}`;
  }
  if (rawType === "boolean") return "boolean";
  const n = normalize(name);
  const compact = n.replace(/_/g, "");
  // Qualified identifiers: release_id, ghsaId, check_run_id -> id.release, id.ghsa, id.checkrun.
  // Ids of different things must never flow into each other.
  const idm = /^(.+?)_(id|uuid|guid|number|num)$/.exec(n);
  if (idm && rawType !== "array" && rawType !== "object") return `id.${idm[1].replace(/_/g, "")}`;
  if (/^(id|uuid|guid)$/.test(n) && rawType !== "array" && rawType !== "object") return "id";
  if (rawType === "integer" || rawType === "number") {
    if (/(^|_)(lat|latitude)$/.test(n)) return "geo.lat";
    if (/(^|_)(lon|lng|long|longitude)$/.test(n)) return "geo.lon";
    const quantity = inferMoneyType(name, [schema.description, description].filter(Boolean).join(" "));
    if (quantity) return quantity;
    return "number";
  }
  if (rawType === "object") return "json";
  switch (schema.format) {
    case "uri":
    case "url":
    case "iri":
      return /image|img|photo|avatar|thumb|icon/.test(compact) ? "image.url" : "url";
    case "email":
      return "email";
    case "date":
    case "date-time":
      return "datetime";
    case "uuid":
      return "id";
    case "ipv4":
    case "ipv6":
      return "ip";
    case "hostname":
      return "domain";
  }
  // "owner/repo" is a different thing from a bare repository name.
  if (rawType !== "array" && /\bowner\/repo(sitory)?\b/i.test(description) && /repo/i.test(n)) return "repo.full";
  // Resource identifiers described in prose: "name of the Namespace" -> id.namespace.
  const of = /\bname of the ([A-Za-z]+)\b/i.exec(description);
  if (of && (n === "name" || n.endsWith("_name"))) return `id.${of[1].toLowerCase()}`;
  const d = description.toLowerCase();
  // An ambiguous direction is settled by what the contract says, then by its examples.
  if (DIRECTIONAL.test(n)) {
    if (/\biso ?4217\b|\bcurrenc(y|ies)\b/.test(d)) return "currency";
    if (/\biso ?3166\b|\bcountry\b/.test(d)) return "country";
    const fromExamples = typeFromExamples(schema);
    if (fromExamples) return fromExamples;
    if (/\biso ?639\b|\blanguage\b|\blocale\b|\bbcp ?47\b/.test(d)) return "language";
    return "language";
  }
  // DOI is a shared identifier scheme, including qualified schema field names.
  // Do not match incidental substrings (e.g. medoid) or override numeric/URI wire types.
  if (/(^|_)doi$/.test(n)) return "id.doi";
  for (const [re, t] of NAME_RULES) {
    if (re.test(n) || re.test(compact)) return t;
  }
  if (/\b(iso ?639|language code|bcp ?47)\b/.test(d)) return "language";
  if (/\biso ?3166\b|country code/.test(d)) return "country";
  if (/\biso ?4217\b|currency code/.test(d)) return "currency";
  if (/\burl\b|\buri\b/.test(d) && rawType === "string") return "url";
  // Cryptic names with meaningful descriptions ("acctno": "Account reference",
  // "hldr": "Customer reference of the account holder") identify an entity.
  const ident = /\b([a-z]+)\s+(?:reference|identifier|id)\b/.exec(d);
  if (ident && !ID_FILLER.has(ident[1]) && rawType !== "array" && rawType !== "object") return `id.${ident[1]}`;
  if (rawType === undefined && !schema.format && compact === "") return "json";
  // Names and descriptions said nothing specific: published example values may.
  return typeFromExamples(schema) ?? "text";
}

/** Words that precede "identifier"/"id" without naming an entity. */
const ID_FILLER = new Set(["the", "a", "an", "unique", "internal", "external", "its", "their", "this", "global", "opaque", "public", "system", "primary"]);

const GENERIC = new Set(["text", "id", "json", "number"]);

/**
 * Infer with context: a GraphQL arg `code` on field `country`, or an output
 * `code` on type `Language`, means more than the bare name says. If the bare
 * name yields a generic type, try "<context><Name>" (countryCode, languageCode).
 */
export function inferInContext(name: string, schema: SchemaLike, description: string, context: string): SemType {
  const bare = inferType(name, schema, description);
  if (!GENERIC.has(bare) || !context) return bare;
  const s = schema.format === "uuid" ? { ...schema, format: undefined } : schema;
  const ctx = inferType(context + name.charAt(0).toUpperCase() + name.slice(1), s, description);
  return GENERIC.has(ctx) ? bare : ctx;
}

function singular(name: string): string {
  return name.endsWith("ies") ? name.slice(0, -3) + "y" : name.endsWith("s") ? name.slice(0, -1) : name;
}

/** Map GraphQL scalar names to schema-ish shapes for inference. */
export function graphqlScalar(typeName: string): SchemaLike {
  switch (typeName) {
    case "Int":
    case "Float":
      return { type: "number" };
    case "Boolean":
      return { type: "boolean" };
    case "ID":
      return { type: "string", format: "uuid" };
    case "URL":
    case "URI":
      return { type: "string", format: "uri" };
    case "DateTime":
    case "Date":
      return { type: "string", format: "date-time" };
    default:
      return { type: "string" };
  }
}

// ---------------------------------------------------------------- inspection

export interface Inspection {
  type: SemType;
  confidence: number;
  value: unknown;
  meta: Record<string, unknown>;
}

const LANGS = new Set([
  "en", "es", "fr", "de", "it", "pt", "nl", "sv", "no", "da", "fi", "pl", "cs", "ru", "uk", "tr",
  "ar", "he", "hi", "bn", "zh", "ja", "ko", "vi", "th", "id", "ms", "el", "ro", "hu",
]);
const CURRENCIES = new Set(["USD", "EUR", "GBP", "JPY", "CNY", "CHF", "CAD", "AUD", "NZD", "INR", "BRL", "MXN", "SEK", "NOK", "DKK", "PLN", "ZAR", "KRW", "SGD", "HKD"]);

/** Classify an arbitrary value into the semantic lattice. */
export function inspectValue(value: unknown): Inspection {
  if (typeof value === "number") return { type: "number", confidence: 1, value, meta: {} };
  if (typeof value === "boolean") return { type: "boolean", confidence: 1, value, meta: {} };
  if (Array.isArray(value)) {
    const inner = value.length ? inspectValue(value[0]).type : "json";
    return { type: `list:${inner}`, confidence: 0.9, value, meta: { length: value.length } };
  }
  if (value === null || typeof value === "object") return { type: "json", confidence: 1, value, meta: {} };
  const s = String(value).trim();
  const meta: Record<string, unknown> = { length: s.length };
  if (/^https?:\/\/\S+$/i.test(s)) {
    const u = new URL(s);
    meta.host = u.host;
    const image = /\.(png|jpe?g|gif|webp|svg|avif)(\?|$)/i.test(u.pathname);
    return { type: image ? "image.url" : "url", confidence: 0.99, value: s, meta };
  }
  if (/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(s)) return { type: "email", confidence: 0.98, value: s, meta };
  if (/^-?\d+(\.\d+)?$/.test(s)) {
    try { return { type: "number", confidence: 0.9, value: parseJsonValue(s), meta }; }
    catch (error) {
      if (error instanceof JsonRepresentationError) return { type: "text", confidence: 1, value, meta: { ...meta, representation: "number-text", reason: error.message } };
      // Numeric-looking identifiers with leading zeroes are text, not JSON numbers.
    }
  }
  if (/^(\d{1,3}\.){3}\d{1,3}$/.test(s)) return { type: "ip", confidence: 0.97, value: s, meta };
  if (/^\d{4}-\d{2}-\d{2}(T[\d:.]+(Z|[+-]\d{2}:?\d{2})?)?$/.test(s)) return { type: "datetime", confidence: 0.97, value: s, meta };
  if (/^#[0-9a-f]{6}$/i.test(s)) return { type: "color", confidence: 0.95, value: s, meta };
  if (/^[0-9a-f]{64}$/i.test(s)) return { type: "hash", confidence: 0.9, value: s, meta };
  if (/^[{[]/.test(s)) {
    try {
      return { type: "json", confidence: 0.99, value: parseJsonValue(s), meta };
    } catch (error) {
      if (error instanceof JsonRepresentationError) return { type: "text", confidence: 1, value, meta: { ...meta, representation: "json-text", reason: error.message } };
      /* not json */
    }
  }
  if (/^\s*<(!doctype html|html|body|div|p|h1|head)\b/i.test(s)) return { type: "html", confidence: 0.95, value: s, meta };
  if (LANGS.has(s.toLowerCase()) && s.length === 2 && s === s.toLowerCase()) return { type: "language", confidence: 0.6, value: s, meta };
  if (CURRENCIES.has(s)) return { type: "currency", confidence: 0.8, value: s, meta };
  if (/^[A-Z]{2}$/.test(s)) return { type: "country", confidence: 0.6, value: s, meta };
  if (/^([a-z0-9-]+\.)+[a-z]{2,}$/i.test(s)) return { type: "domain", confidence: 0.85, value: s, meta };
  if (/(^|\n)#{1,6} |\*\*[^*]+\*\*|\[[^\]]+\]\([^)]+\)/.test(s)) return { type: "markdown", confidence: 0.75, value: s, meta };
  meta.words = s.split(/\s+/).filter(Boolean).length;
  return { type: "text", confidence: 0.5, value: s, meta };
}
