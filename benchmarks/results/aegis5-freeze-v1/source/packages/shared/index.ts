// Small utilities shared by every EXAPT subsystem. Nothing here knows about capabilities.
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const sha256 = (data: string | Uint8Array): string => createHash("sha256").update(data).digest("hex");

/** JSON with sorted object keys: equal values give equal text whatever their key order. */
export function stable(v: unknown): string {
  if (v === undefined) return "null";
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).sort().filter((k) => o[k] !== undefined).map((k) => `${JSON.stringify(k)}:${stable(o[k])}`).join(",")}}`;
}

export const digest = (v: unknown): string => sha256(stable(v));

export const newId = (prefix: string): string => `${prefix}_${Date.now().toString(36)}_${randomBytes(4).toString("hex")}`;

export const clip = (s: string, n = 300): string => (s.length > n ? `${s.slice(0, n)}…[${s.length - n} more chars]` : s);

/** Write through a sibling temporary file and rename, so a crash never leaves half a file. */
export function writeAtomic(file: string, data: string | Uint8Array): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomBytes(3).toString("hex")}.tmp`;
  const fd = fs.openSync(tmp, "w", 0o600);
  try {
    if (typeof data === "string") fs.writeSync(fd, data);
    else fs.writeSync(fd, data);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
}

export const writeJson = (file: string, value: unknown): void => writeAtomic(file, `${JSON.stringify(value, null, 2)}\n`);

export function readJson<T>(file: string): T | undefined {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw e;
  }
}

/** Seeded PRNG (mulberry32): every generated test can be reproduced from its seed. */
export class Rng {
  private s: number;
  constructor(seed: number) {
    this.s = seed >>> 0;
  }
  next(): number {
    this.s = (this.s + 0x6d2b79f5) >>> 0;
    let t = this.s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }
  pick<T>(xs: readonly T[]): T {
    return xs[Math.floor(this.next() * xs.length)];
  }
  bool(p = 0.5): boolean {
    return this.next() < p;
  }
  shuffle<T>(xs: readonly T[]): T[] {
    const out = [...xs];
    for (let i = out.length - 1; i > 0; i--) {
      const j = this.int(0, i);
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
  }
}

/** Map with bounded concurrency, preserving input order. */
export async function pool<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/** An expected refusal: reported to the caller as a structured outcome, not a crash. */
export class Refused extends Error {
  readonly code: string;
  readonly next?: string;
  constructor(code: string, message: string, next?: string) {
    super(message);
    this.code = code;
    this.next = next;
  }
}
