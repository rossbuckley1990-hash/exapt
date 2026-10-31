// The capability universe's vocabulary. A node is a structured, versioned object; a plain type
// match between two nodes is never treated as proof that they are semantically compatible.
import type { ProgramRef } from "../rcx-adapter/index.ts";
import type { Repr } from "./repr.ts";

export type CapabilityStatus =
  | "existing"
  | "candidate-missing"
  | "synthesised-unverified"
  | "verified-within-scope"
  | "invalidated"
  | "refused"
  | "unavailable";

/** The evidence ladder. Each rung implies the ones below it; none means universally correct. */
export const EVIDENCE_LEVELS = [
  "not-established",
  "syntax-valid",
  "executed",
  "passed-visible",
  "passed-independent",
  "passed-holdout",
  "verified-in-domain",
] as const;
export type EvidenceLevel = (typeof EVIDENCE_LEVELS)[number];
export const levelRank = (l: EvidenceLevel): number => EVIDENCE_LEVELS.indexOf(l);

export interface Claim {
  claim: string;
  status: "declared" | "observed" | "experimentally-supported" | "contradicted" | "unknown";
  detail: string;
}

/** What experiments established about one operation's byte-level interface. */
export interface ToolContract {
  tool: string;
  name: string;
  docs: string;
  input: {
    repr: Repr;
    /** Fields whose removal made the program refuse its input. */
    requiredFields: string[];
    optionalFields: string[];
    /** Fields whose value changes the program's output: it reads them. */
    influentialFields: string[];
    positive: string[];
    /** Refused variants, with the program's own words. */
    rejected: Array<{ variant: string; error: string }>;
  } | null;
  output: { repr: Repr; example: string } | null;
  /** Documented options that changed what the program accepts or does. */
  options: Array<{ flags: string[]; values: string[]; description: string }>;
  /** Digest of the outputs on the fixed positive samples. Same digest, same observed behaviour. */
  behaviour: string;
  claims: Claim[];
  probes: number;
}

/** An executable operation the reasoner may route through. */
export interface Tool {
  id: string;
  name: string;
  kind: "program" | "generated";
  ref?: ProgramRef;
  contract: ToolContract;
  version?: number;
  run(input: string | Buffer, opts?: { args?: string[] }): Promise<{ ok: boolean; stdout: string; stderr: string; ms: number; code: number | null }>;
}

export interface CapabilityNode {
  id: string;
  version: number;
  status: CapabilityStatus;
  title: string;
  description: string;
  source: string;
  provider: string;
  inputs: Array<{ name: string; semantic: string; required: boolean; repr?: string }>;
  outputs: Array<{ name: string; semantic: string; repr?: string }>;
  preconditions: string[];
  effects: { risk: string; network: boolean; writes: string };
  dependencies: Array<{ id: string; pin?: string }>;
  behaviour?: string;
  verification: { available: boolean; level?: EvidenceLevel; oracles?: string[] };
  restrictions: string[];
  history: { runs: number; ok: number; failed: number };
}

export type SampleRef = { path?: string; text?: string; base64?: string };

/** An explicit desired outcome. The contract for any new capability comes from here and from the
 *  environment's evidence, never from the model that will propose an implementation. */
export interface Goal {
  id: string;
  intent: string;
  have?: { samples: SampleRef[]; description?: string };
  want: {
    /** The program (name or capability id) whose workflow must run to completion. */
    program?: string;
    /** A target representation: a sniffable positive sample of the desired output. */
    sample?: SampleRef;
    /** Input/output pairs. The strongest statement of the outcome. */
    examples?: Array<{ input: SampleRef; output: SampleRef }>;
    description?: string;
  };
  /** Files with an independent source of truth. Split into tiers by EXAPT, never shown whole to a model. */
  corpus?: Array<{ input: SampleRef; truth: SampleRef; name?: string }>;
  /** Operator-supplied independent checker: a program that reads {"input","output"} as JSON. */
  checker?: string;
  budget?: { rounds?: number; candidatesPerRound?: number; modelCalls?: number; maxTokens?: number; maxCostUsd?: number };
}

export const emptyContract = (tool: string, name: string, docs: string): ToolContract => ({ tool, name, docs, input: null, output: null, options: [], behaviour: "", claims: [], probes: 0 });
