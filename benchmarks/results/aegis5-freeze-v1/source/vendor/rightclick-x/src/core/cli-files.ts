/** Keep supplied names exact. Reject ambiguous or non-flat staging instead of renaming data. */
export function validateFileNames(names: string[]): void {
  const seen = new Set<string>();
  for (const name of names) {
    if (!name || name === "." || name === ".." || /^[-]|^\.rcx\./i.test(name) || /[\\/\x00-\x1f\x7f]/.test(name) || new TextEncoder().encode(name).length > 255) {
      throw new Error(`invalid input file name ${JSON.stringify(name)}: use a flat name without a leading dash, control characters or reserved .rcx. prefix (HTTP 400 equivalent: nothing was run)`);
    }
    // Conservative across case-insensitive and Unicode-normalizing host filesystems.
    const key = name.normalize("NFC").toLowerCase();
    if (seen.has(key)) throw new Error(`input file names collide: ${JSON.stringify(name)} (HTTP 400 equivalent: nothing was run)`);
    seen.add(key);
  }
}
