export function transform(input) {
  const lines = input.trim().split(/\r?\n/);
  const PAGE_SIZE = 16384;
  const map = {
    "Pages free:": "memory.free_bytes",
    "Pages active:": "memory.active_bytes",
    "Pages inactive:": "memory.inactive_bytes",
    "Pages speculative:": "memory.speculative_bytes",
    "Pages wired down:": "memory.wired_bytes",
    "Pages occupied by compressor:": "memory.compressor_bytes",
  };
  const out = [];
  for (const line of lines.slice(1)) {
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    const label = line.slice(0, colon + 1).trim();
    if (map[label]) {
      // Fault: does not strip trailing dot! Leaves raw string e.g. "6887."
      const raw = line.slice(colon + 1).trim();
      out.push({ metric: map[label], value: raw });
    }
  }
  return out.map(o => JSON.stringify(o)).join("\n") + "\n";
}
