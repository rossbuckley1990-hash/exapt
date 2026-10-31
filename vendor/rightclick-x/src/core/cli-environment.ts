import type { BigIntStats } from "node:fs";
import { sha256, stableStringify } from "./ledger.ts";
import type { SandboxPolicy } from "./sandbox.ts";

export interface CliEnvironment {
  version: 1;
  coverage: "partial";
  digest: string;
  entries: Array<{ path: string; real?: string; sha256?: string; state: "observed" | "unavailable" | "bounded" }>;
  limitations: string[];
}

type Entry = CliEnvironment["entries"][number];
const MAX_DIRS = 16;
const MAX_ENTRIES = 64;
const MAX_FILE_BYTES = 32 * 1024 * 1024;
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;
const HEADER_BYTES = 4096;
// Match the sandbox's home denial conservatively on both supported platforms.
const HOME_DENY_ROOTS = ["/Users", "/home", "/root"];
const DEFAULT_PATH_DIRS = ["/bin", "/usr/bin"];
const absolute = (p: unknown): p is string => typeof p === "string" && p.startsWith("/") && !p.includes("\0") && !p.split("/").includes("..");
const within = (p: string, root: string) => p === root || p.startsWith(root === "/" ? "/" : `${root}/`);
const sameStat = (a: BigIntStats, b: BigIntStats) =>
  a.dev === b.dev && a.ino === b.ino && a.mode === b.mode && a.size === b.size &&
  a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;

/** Shape validation only: a digest is not authentication or evidence of complete coverage. */
export function validCliEnvironment(value: unknown): value is CliEnvironment {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  const hash = (h: unknown) => typeof h === "string" && /^[a-f0-9]{64}$/.test(h);
  if (v.version !== 1 || v.coverage !== "partial" || !hash(v.digest) ||
      !Array.isArray(v.entries) || v.entries.length > MAX_ENTRIES ||
      !Array.isArray(v.limitations) || !v.limitations.length) return false;
  for (const limitation of v.limitations) if (typeof limitation !== "string" || !limitation.length) return false;
  const seen = new Set<string>();
  for (const e of v.entries) {
    if (!e || typeof e !== "object" || Array.isArray(e) || !absolute(e.path) || seen.has(e.path) ||
        (e.real !== undefined && !absolute(e.real))) return false;
    seen.add(e.path);
    if (e.state === "observed" ? !absolute(e.real) || !hash(e.sha256) :
      (e.state !== "unavailable" && e.state !== "bounded") || e.sha256 !== undefined) return false;
  }
  return true;
}

/** Bounded, read-only candidate evidence, not dependency discovery or execution tracing.
 * Equal digests never prove an unchanged execution environment, especially for bounded
 * or unavailable entries. The primary executable's own hash remains a separate check.
 */
export async function observeCliEnvironment(bin: string, policy: SandboxPolicy): Promise<CliEnvironment> {
  const fs = await import("node:fs/promises");
  const { constants } = await import("node:fs");
  const { createHash } = await import("node:crypto");
  const { normalize, join } = await import("node:path");
  // Freeze the declaration for this observation, including PATH order, not host PATH.
  const confinement = {
    readRoots: [...policy.readRoots], readDenyRoots: [...policy.readDenyRoots],
    readDenyPending: [...(policy.readDenyPending ?? [])], writeRoots: [...policy.writeRoots],
    pathDirs: [...policy.pathDirs], network: policy.network, limits: { ...policy.limits },
    homeDenyRoots: HOME_DENY_ROOTS,
  };
  const limitations = new Set<string>([
    "Partial candidate snapshot only: explicit PATH directories, excluding /bin and /usr/bin; no recursive read-root scan.",
    "Libraries, imports, configuration, credentials, services and other dependencies are not discovered.",
    "Only direct literal shebang interpreters are considered; no interpreter options, interpreter chains or /usr/bin/env PATH guessing.",
    "Snapshots are not atomic execution tracing; concurrent path changes and changes between observations can escape detection.",
    "Equal digests do not establish unchanged omitted, unavailable or bounded contents; byte-identical replacements are not distinguished.",
    "Primary executable bytes are excluded and require separate hash/revalidation.",
  ]);
  const entries = new Map<string, Entry>();
  let remainingBytes = MAX_TOTAL_BYTES;
  let remainingNames = MAX_ENTRIES;
  const rootsValid = [...confinement.readRoots, ...confinement.readDenyRoots].every(absolute);
  const readRoots = confinement.readRoots.filter(absolute).map(normalize);
  const denyRoots = confinement.readDenyRoots.filter(absolute).map(normalize);
  const readable = (p: string) => rootsValid && absolute(p) && !denyRoots.some(r => within(p, r)) &&
    (!HOME_DENY_ROOTS.some(r => within(p, r)) || readRoots.some(r => within(p, r)));
  const primary = absolute(bin) ? normalize(bin) : undefined;
  let primaryReal: string | undefined;

  // Reserve the final slot for an explicit overflow marker; never silently truncate.
  const record = (entry: Entry) => {
    if (entry.path === primary || entry.path === primaryReal || entries.has(entry.path)) return;
    if (entries.size < MAX_ENTRIES - 1) entries.set(entry.path, entry);
    else {
      limitations.add("Entry budget bounded: at most 63 candidates/markers plus one overflow marker; additional candidates were not read.");
      if (entries.size < MAX_ENTRIES) entries.set(entry.path, { path: entry.path, state: "bounded" });
    }
  };
  const problem = (p: string, state: "unavailable" | "bounded", why: string, real?: string) => {
    limitations.add(why);
    record({ path: p, ...(real ? { real } : {}), state });
  };
  const resolveReadable = async (p: string): Promise<string | undefined> => {
    if (!readable(p)) {
      problem(p, "unavailable", "Read policy denied at least one logical path (PATH/write declarations do not grant reads).");
      return;
    }
    try {
      const real = await fs.realpath(p);
      if (!readable(real)) {
        problem(p, "unavailable", "Read policy denied at least one resolved target; its contents were not read.", real);
        return;
      }
      return real;
    } catch {
      problem(p, "unavailable", "At least one path was missing or could not be resolved.");
    }
  };

  type Contents = { hash?: string; header: Buffer; size: number };
  const readRegular = async (p: string, real: string, prefixOnly = false): Promise<Contents | undefined> => {
    let fd: Awaited<ReturnType<typeof fs.open>> | undefined;
    try {
      const before = await fs.lstat(real, { bigint: true });
      if (!before.isFile() || !(before.mode & 0o111n)) {
        if (prefixOnly) limitations.add("Primary shebang unavailable: primary is not an executable regular file.");
        return;
      }
      const size = Number(before.size);
      const bytes = prefixOnly ? Math.min(size, HEADER_BYTES) : size;
      if ((!prefixOnly && size > MAX_FILE_BYTES) || bytes > remainingBytes) {
        problem(p, "bounded", "Byte budget bounded: 32 MiB per candidate and 64 MiB total, including primary shebang reads.", real);
        return;
      }
      // Nonblocking prevents a raced FIFO open from hanging; NOFOLLOW refuses a
      // replaced final symlink. Check descriptor identity and both paths before bytes.
      fd = await fs.open(real, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const opened = await fd.stat({ bigint: true });
      if (!sameStat(before, opened) || !opened.isFile() || await fs.realpath(p) !== real ||
          !sameStat(opened, await fs.lstat(real, { bigint: true })) || !readable(p) || !readable(real)) throw new Error("unstable path");
      const hash = prefixOnly ? undefined : createHash("sha256");
      const buffer = Buffer.alloc(Math.min(64 * 1024, Math.max(1, bytes)));
      const header = Buffer.alloc(Math.min(HEADER_BYTES, bytes));
      let offset = 0;
      while (offset < bytes) {
        const { bytesRead } = await fd.read(buffer, 0, Math.min(buffer.length, bytes - offset), offset);
        if (!bytesRead) throw new Error("short read");
        remainingBytes -= bytesRead;
        hash?.update(buffer.subarray(0, bytesRead));
        if (offset < header.length) buffer.copy(header, offset, 0, Math.min(bytesRead, header.length - offset));
        offset += bytesRead;
      }
      if (!sameStat(opened, await fd.stat({ bigint: true })) || await fs.realpath(p) !== real ||
          !sameStat(opened, await fs.lstat(real, { bigint: true }))) throw new Error("unstable read");
      return { hash: hash?.digest("hex"), header, size };
    } catch {
      problem(p, "unavailable", "At least one executable could not be read stably; no content hash was retained.", real);
    } finally {
      await fd?.close();
    }
  };
  const interpreters = new Set<string>();
  const noteInterpreter = ({ header, size }: Contents) => {
    if (header[0] !== 35 || header[1] !== 33) return;
    const newline = header.indexOf(10);
    if (newline < 0 && size > header.length) {
      limitations.add("Shebang bounded: first line exceeded 4096 bytes; its interpreter was not resolved.");
      return;
    }
    const line = header.subarray(0, newline < 0 ? header.length : newline).toString("utf8");
    const literal = /^#![ \t]*(\/[^ \t\r\n\0]+)(?:[ \t\r]|$)/.exec(line)?.[1];
    if (literal && absolute(literal)) interpreters.add(normalize(literal));
    else limitations.add("A relative or malformed shebang interpreter was unavailable; no PATH lookup was attempted.");
  };

  if (primary) {
    primaryReal = await resolveReadable(primary);
    if (primaryReal) {
      const contents = await readRegular(primary, primaryReal, true);
      if (contents) noteInterpreter(contents);
    }
  } else limitations.add("Primary path unavailable: only absolute executable paths are supported.");

  const candidates = new Set<string>();
  const dirs = [...new Set(confinement.pathDirs.filter(p => !absolute(p) || !DEFAULT_PATH_DIRS.includes(normalize(p))))];
  for (const [index, raw] of dirs.entries()) {
    if (!absolute(raw)) {
      limitations.add("A non-absolute PATH directory was unavailable; host PATH and current-directory lookup were not used.");
      continue;
    }
    const p = normalize(raw);
    if (index >= MAX_DIRS) {
      problem(p, "bounded", "Directory budget bounded: only the first 16 explicit PATH directories were eligible for listing.");
      break;
    }
    const real = await resolveReadable(p);
    if (!real || DEFAULT_PATH_DIRS.includes(real)) continue;
    // Without a resolved primary, aliases cannot reliably be excluded.
    if (!primaryReal) {
      problem(p, "unavailable", "Primary target unavailable: PATH candidates were not inspected because primary aliases could not be excluded.", real);
      continue;
    }
    let dir: Awaited<ReturnType<typeof fs.opendir>> | undefined;
    try {
      const before = await fs.lstat(real, { bigint: true });
      if (!before.isDirectory()) throw new Error("not a directory");
      dir = await fs.opendir(real, { bufferSize: 1 });
      if (await fs.realpath(p) !== real || !sameStat(before, await fs.lstat(real, { bigint: true }))) throw new Error("unstable directory");
      const names: string[] = [];
      let bounded = false;
      // At most 64 retained names across all directories, plus one overflow probe
      // per directory. On overflow discard this listing, not an order-dependent subset.
      while (true) {
        const item = await dir.read();
        if (!item) break;
        if (remainingNames === 0) { bounded = true; break; }
        remainingNames--;
        names.push(item.name);
      }
      if (await fs.realpath(p) !== real || !sameStat(before, await fs.lstat(real, { bigint: true }))) throw new Error("unstable directory");
      if (bounded) problem(p, "bounded", "Directory-entry budget bounded: 64 names total plus overflow probes; incomplete listings are discarded.", real);
      else for (const name of names.sort()) candidates.add(join(p, name));
    } catch {
      problem(p, "unavailable", "At least one PATH directory was missing, unreadable or changed during listing.", real);
    } finally {
      await dir?.close();
    }
  }

  const observe = async (p: string, interpreter: boolean) => {
    if (p === primary || p === primaryReal || entries.has(p)) return;
    if (entries.size >= MAX_ENTRIES - 1) {
      record({ path: p, state: "bounded" });
      return;
    }
    const real = await resolveReadable(p);
    if (!real || real === primaryReal) return;
    const contents = await readRegular(p, real);
    if (contents) {
      record({ path: p, real, sha256: contents.hash!, state: "observed" });
      if (!interpreter) noteInterpreter(contents);
    } else if (interpreter && !entries.has(p)) {
      problem(p, "unavailable", "At least one literal interpreter was not an observable executable regular file.", real);
    }
  };
  for (const p of [...candidates].sort()) await observe(p, false);
  for (const p of [...interpreters].sort()) await observe(p, true);
  const evidence = {
    version: 1 as const, coverage: "partial" as const,
    entries: [...entries.values()].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0),
    limitations: [...limitations].sort(),
  };
  return { ...evidence, digest: await sha256(stableStringify({
    ...evidence, confinement,
    bounds: { directories: MAX_DIRS, entries: MAX_ENTRIES, fileBytes: MAX_FILE_BYTES, totalBytes: MAX_TOTAL_BYTES, headerBytes: HEADER_BYTES },
  })) };
}
