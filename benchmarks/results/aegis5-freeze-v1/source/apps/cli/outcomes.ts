import type { RunRecord } from "../../packages/protocol/engine.ts";

/** A retained capability cannot turn a failed workflow into a successful command. */
export function inventionExitCode(run: Pick<RunRecord, "status" | "capability" | "workflow">): number {
  if (run.status === "failed" || run.workflow?.ok === false) return 1;
  if (run.status === "refused") return 3;
  if (run.status !== "completed") return 4;
  return run.capability?.status === "verified-within-scope" || run.workflow?.ok ? 0 : 4;
}
