import type { PublishedGoal } from "../runtime.ts";
import { sha256, stableStringify } from "./ledger.ts";

/** Stable immutable definition identity, excluding only observation counters. */
export function goalDefinitionDigest(g: PublishedGoal): Promise<string> {
  const { calls, lastPipeline, providers, publishedAt, trust, lastResult, ...definition } = g;
  return sha256(stableStringify(definition));
}
