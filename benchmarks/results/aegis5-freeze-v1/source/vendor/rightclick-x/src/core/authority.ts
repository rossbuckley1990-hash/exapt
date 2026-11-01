// Operator authority from the environment: set by whoever runs RightClick X, never by an agent.
//   RCX_DESTRUCTIVE = operator (default) | agent-confirm | allow
//   RCX_APPROVE     = comma-separated capability ids or prefixes ending in "*" (destructive use)
//   RCX_RETRY       = comma-separated capability ids, prefixes or origins declared side-effect-free
//   RCX_INVESTIGATE = comma-separated program paths (or directories ending "/") that may be
//                     investigated, always in the host sandbox
//   RCX_EXECUTE     = the programs whose learned capabilities may run (same form); when unset,
//                     the programs that may be investigated
//   RCX_SHARE_EVIDENCE = "1" lets capability knowledge be exported from this installation
//   RCX_CLI_CONFORMANCE = JSON {"cli:<program>:<command>": {"samples": [{"args": {...}, "output": ...}, ...]}}:
//                     2-8 exact synthetic samples per read-only CLI capability, with independently
//                     expected outputs, that may revalidate it after its program changes
import type { OperatorAuthority } from "../runtime.ts";
import { parseCliConformance } from "./cli-conformance.ts";
import { parseExecutionPolicy } from "./execution-policy.ts";

const list = (v: unknown) => String(v ?? "").split(",").map((x) => x.trim()).filter(Boolean);

export function authorityFromEnv(env: Record<string, unknown>): OperatorAuthority {
  const d = String(env.RCX_DESTRUCTIVE ?? "operator");
  if (!["operator", "agent-confirm", "allow"].includes(d)) throw new Error(`RCX_DESTRUCTIVE must be operator, agent-confirm or allow (got ${d})`);
  return {
    ...(env.RCX_EXECUTION_POLICY !== undefined ? { execution: parseExecutionPolicy(JSON.parse(String(env.RCX_EXECUTION_POLICY))) } : {}),
    destructive: d as OperatorAuthority["destructive"],
    approve: list(env.RCX_APPROVE),
    retry: list(env.RCX_RETRY),
    investigate: list(env.RCX_INVESTIGATE),
    ...(env.RCX_EXECUTE !== undefined ? { execute: list(env.RCX_EXECUTE) } : {}),
    ...(env.RCX_CLI_CONFORMANCE !== undefined ? { cliConformance: parseCliConformance(JSON.parse(String(env.RCX_CLI_CONFORMANCE))) } : {}),
    shareEvidence: env.RCX_SHARE_EVIDENCE === "1",
  };
}
