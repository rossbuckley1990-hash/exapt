// Executable authorisation: may this path be investigated or run under the operator's authority?
//
// The operator lists programs exactly, or directories (ending "/"). Decisions are made on canonical
// paths, never on string prefixes of what a caller wrote:
//   - the requested path must already be canonical (absolute, no "." or ".." segments, no "//"),
//     so "/allowed/../usr/bin/x" is refused rather than normalised into something else;
//   - a program authorised through a directory must really live there: its real path (all links
//     followed) must stay under an authorised directory;
//   - a link listed exactly is an explicitly authorised alias and may point anywhere;
//   - a program another user could replace between the check and its use (group- or
//     world-writable) is refused.
// The identity of what was checked (real path, device, inode, size, mtime) is returned so callers
// can confirm, after a run, that the same file was the one executed.

export interface ProgramIdentity {
  real: string;
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
}

export type ProgramCheck = { ok: true; identity: ProgramIdentity; alias: boolean } | { ok: false; reason: string; missing?: boolean };

export async function checkProgram(bin: string, entries: string[]): Promise<ProgramCheck> {
  const fs = await import("node:fs");
  const path = await import("node:path");
  if (!path.isAbsolute(bin)) return { ok: false, reason: `not authorised: ${bin} is not an absolute path` };
  if (path.resolve(bin) !== bin || bin.includes("//") || bin.endsWith("/")) return { ok: false, reason: `not authorised: ${bin} is not a canonical path (it contains "." or ".." segments or repeated separators)` };
  const exact = entries.filter((e) => !e.endsWith("/")).map((e) => path.resolve(e));
  const dirs = entries.filter((e) => e.endsWith("/")).map((e) => path.resolve(e) + "/");
  const realDir = (d: string) => {
    try {
      return fs.realpathSync(d) + "/";
    } catch {
      return d;
    }
  };
  const realDirs = [...new Set([...dirs, ...dirs.map(realDir)])];
  const named = exact.includes(bin);
  if (!named && !dirs.some((d) => bin.startsWith(d))) return { ok: false, reason: `not authorised: the operator has not registered ${bin} (authority.investigate / RCX_INVESTIGATE)` };
  if (!fs.existsSync(bin)) return { ok: false, missing: true, reason: `program not installed: ${bin}` };
  let real: string;
  try {
    real = fs.realpathSync(bin);
  } catch (e) {
    return { ok: false, missing: true, reason: `program not installed: ${bin} (${(e as Error).message})` };
  }
  const realExact = exact.flatMap((e) => {
    try {
      return [fs.realpathSync(e)];
    } catch {
      return [];
    }
  });
  if (!named && !realDirs.some((d) => real.startsWith(d)) && !realExact.includes(real)) {
    return { ok: false, reason: `not authorised: ${bin} resolves to ${real}, outside every authorised directory (authorise the program or the link itself to allow it)` };
  }
  const st = fs.statSync(real);
  if (!st.isFile()) return { ok: false, reason: `not authorised: ${real} is not a regular file` };
  if (st.mode & 0o022) return { ok: false, reason: `refused: ${real} is writable by other users (mode ${(st.mode & 0o777).toString(8)}), so it could be replaced between the check and its use` };
  return { ok: true, alias: named && real !== bin, identity: { real, dev: st.dev, ino: st.ino, size: st.size, mtimeMs: st.mtimeMs } };
}

/** The file that was checked is still the file on disk (same real path, inode and contents stamp). */
export async function sameProgram(bin: string, before: ProgramIdentity): Promise<boolean> {
  const fs = await import("node:fs");
  try {
    const real = fs.realpathSync(bin);
    const st = fs.statSync(real);
    return real === before.real && st.dev === before.dev && st.ino === before.ino && st.size === before.size && st.mtimeMs === before.mtimeMs;
  } catch {
    return false;
  }
}
