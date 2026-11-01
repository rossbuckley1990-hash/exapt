import { sha256, stableStringify } from "./ledger.ts";
import type { Capability } from "./types.ts";

export interface CliConformance {
  samples: Array<{ args: Record<string, unknown>; output: unknown; format?: "json" }>;
}

export interface CliConformancePin {
  capability: string;
  contract: string;
  samples: string;
  policy: string;
  sha256: string;
  environment: string;
  checks: number;
}

const object = (v: unknown): v is Record<string, any> => !!v && typeof v === "object" && !Array.isArray(v);
const digest = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);

export function parseCliConformance(value: unknown): Record<string, CliConformance> {
  if (value === undefined) return {};
  if (!object(value) || Object.keys(value).length > 32) throw new Error("CLI conformance needs at most 32 exact capability contracts");
  const result: Record<string, CliConformance> = Object.create(null);
  for (const [id, contract] of Object.entries(value)) {
    if (!/^cli:[^*]+$/.test(id) || id.length > 512 || !object(contract) ||
        !Array.isArray(contract.samples) || contract.samples.length < 2 || contract.samples.length > 8)
      throw new Error("CLI conformance requires exact ids and 2–8 operator-authorized samples");
    const text = JSON.stringify(contract.samples);
    if (text.length > 65_536) throw new Error("CLI conformance samples exceed 64 KiB");
    const samples = JSON.parse(text) as CliConformance["samples"];
    if (samples.some(s => !object(s) || !object(s.args) || s.output === undefined || s.format !== undefined && s.format !== "json") ||
        new Set(samples.map(s => stableStringify(s.args))).size !== samples.length ||
        new Set(samples.map(s => stableStringify(s.output))).size < 2)
      throw new Error("CLI conformance requires distinct inputs and informative independent expected outputs");
    result[id] = { samples };
  }
  return result;
}

export function validCliConformancePin(value: unknown): value is CliConformancePin {
  return object(value) && typeof value.capability === "string" && /^cli:[^*]+$/.test(value.capability) &&
    value.capability.length <= 512 && [value.contract, value.samples, value.policy, value.sha256, value.environment].every(digest) &&
    Number.isInteger(value.checks) && value.checks >= 4 && value.checks <= 16;
}

export function cliConformanceContract(cap: Capability): Promise<string> {
  return sha256(stableStringify({ id: cap.id, provider: cap.provider, source: cap.source, risk: cap.risk,
    inputs: cap.inputs, outputs: cap.outputs.filter(p => !p.observed), invoke: cap.invoke, links: cap.links }));
}
