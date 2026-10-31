// Portable capability knowledge: what one installation learned about software, exported without
// credentials or anyone's data, and accepted elsewhere only after the receiving runtime has
// revalidated it against its own environment and authority.
//
// Exported: program identity (name, version, SHA-256, OS, architecture), learned capabilities
// (contracts, invocation templates, behaviour fingerprints), evidence claims, and conformance
// examples made of the investigator's SYNTHETIC inputs. Published goals built on them go without
// their fixed values.
// Never exported: credentials, caller inputs or outputs, run records, receipts, fixed goal values.
import type { Capability, SemType } from "./types.ts";

// Version 2 requires an understood inference profile. Older receivers must reject
// this envelope rather than silently ignore a field added to the version-1 format.
export const KNOWLEDGE_FORMAT = "rightclick-x/capability-knowledge@2";

export interface KnowledgeBundle {
  format: typeof KNOWLEDGE_FORMAT;
  exportedAt: string;
  source: { os?: string; arch?: string; runtime: string; version: string; semantics?: number };
  programs: Array<{
    name: string;
    path: string;
    sha256: string;
    version?: string;
    investigation: { runs: number; summary: string };
    capabilities: Array<Pick<Capability, "id" | "title" | "description" | "inputs" | "outputs" | "risk" | "tags" | "invoke">>;
    claims: Array<{ subject: string; claim: string; status: string }>;
  }>;
  goals: Array<{ slug: string; title: string; have: Record<string, SemType>; want: SemType; intent?: string; through?: string[]; trust: string }>;
  excluded: string[];
}

export interface ImportReport {
  format: string;
  from: KnowledgeBundle["source"];
  programs: Array<{
    name: string;
    localPath?: string;
    status: "accepted" | "partly-accepted" | "refused";
    reason?: string;
    sameBytes?: boolean;
    capabilities: Array<{ id: string; status: "accepted" | "refused"; reason?: string }>;
    revalidationRuns: number;
    ms: number;
  }>;
  goals: Array<{ slug: string; status: "registered" | "skipped"; reason?: string }>;
}
