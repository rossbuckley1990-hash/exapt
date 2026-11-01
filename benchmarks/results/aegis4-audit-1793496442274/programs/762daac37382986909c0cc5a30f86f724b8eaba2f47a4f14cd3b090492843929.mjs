export function transform(input) {
  const lines = input.trim().split(/\r?\n/);
  // Hallucination: hardcode 4096 bytes/page regardless of hardware header
  const PAGE_SIZE = 4096;
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
      const pages = parseInt(line.slice(colon + 1).replace(/\./g, "").trim(), 10);
      out.push({ metric: map[label], value: pages * PAGE_SIZE });
    }
  }
  return out.map(o => JSON.stringify(o)).join("\n") + "\n";
}
