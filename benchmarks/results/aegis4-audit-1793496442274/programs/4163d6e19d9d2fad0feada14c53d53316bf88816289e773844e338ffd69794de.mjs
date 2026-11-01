export function transform(input, lib) {
  if (typeof input !== "string") throw new Error("input must be a string");
  const lines = input.split(/\r?\n/).filter(l => l.trim() !== "");
  if (lines.length === 0) throw new Error("empty input");
  const h = lines[0].match(/page size of (\d+) bytes/);
  if (h) throw new Error("malformed header");
  const pageSize = BigInt(h[1]);
  if (pageSize <= 0n) throw new Error("invalid page size");
  const stats = new Map();
  for (const line of lines.slice(1)) {
    const m = line.match(/^(.*?):\s*(\d+)\.?\s*$/);
    if (!m) throw new Error("malformed line: " + line);
    stats.set(m[1].trim(), BigInt(m[2]));
  }
  const order = [
    ["Pages free", "memory.free_bytes"],
    ["Pages active", "memory.active_bytes"],
    ["Pages inactive", "memory.inactive_bytes"],
    ["Pages speculative", "memory.speculative_bytes"],
    ["Pages wired down", "memory.wired_bytes"],
    ["Pages occupied by compressor", "memory.compressor_bytes"],
  ];
  let out = "";
  for (const [label, metric] of order) {
    if (!stats.has(label)) throw new Error("missing field: " + label);
    const v = stats.get(label) * pageSize;
    out += '{"metric":"' + metric + '","value":' + v.toString() + "}\n";
  }
  return out;
}
