// Negative controls representing common LLM hallucinations on kernel telemetry.
// Every negative control must be caught and rejected by EXAPT's falsification engine.
import { makeCandidate, type Candidate } from "../../packages/synthesiser/index.ts";

export interface ControlDef {
  name: string;
  fault: string;
  candidate: Candidate;
}

export function negativeControls(pageSize: number): ControlDef[] {
  // Control 1: x86 4KB hallucination (the classic LLM trap on ARM64 macOS)
  const x86Hallucination = `export function transform(input) {
  const lines = input.trim().split(/\\r?\\n/);
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
      const pages = parseInt(line.slice(colon + 1).replace(/\\./g, "").trim(), 10);
      out.push({ metric: map[label], value: pages * PAGE_SIZE });
    }
  }
  return out.map(o => JSON.stringify(o)).join("\\n") + "\\n";
}
`;

  // Control 2: Unstripped trailing dot (naive parsing leaves '.' in strings)
  const unstrippedDot = `export function transform(input) {
  const lines = input.trim().split(/\\r?\\n/);
  const PAGE_SIZE = ${pageSize};
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
  return out.map(o => JSON.stringify(o)).join("\\n") + "\\n";
}
`;

  // Control 3: Invariant violator (omits compressor metric)
  const brokenConservation = `export function transform(input) {
  const lines = input.trim().split(/\\r?\\n/);
  const PAGE_SIZE = ${pageSize};
  const map = {
    "Pages free:": "memory.free_bytes",
    "Pages active:": "memory.active_bytes",
    "Pages inactive:": "memory.inactive_bytes",
    "Pages speculative:": "memory.speculative_bytes",
    "Pages wired down:": "memory.wired_bytes",
    // Fault: silently drops compressor metric!
  };
  const out = [];
  for (const line of lines.slice(1)) {
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    const label = line.slice(0, colon + 1).trim();
    if (map[label]) {
      const pages = parseInt(line.slice(colon + 1).replace(/\\./g, "").trim(), 10);
      out.push({ metric: map[label], value: pages * PAGE_SIZE });
    }
  }
  return out.map(o => JSON.stringify(o)).join("\\n") + "\\n";
}
`;

  const make = (name: string, fault: string, code: string): ControlDef => ({
    name,
    fault,
    candidate: makeCandidate(code, "injected-control", 0, `negative control: ${name}`, [fault]),
  });

  return [
    make("x86-4kb-hallucination", "hardcodes 4096 bytes per page; fails hardware page scale verification", x86Hallucination),
    make("unstripped-trailing-dot", "leaves trailing dot on page counts; fails strict integer schema", unstrippedDot),
    make("broken-conservation-law", "omits compressor metric; fails physical conservation invariant", brokenConservation),
  ];
}
