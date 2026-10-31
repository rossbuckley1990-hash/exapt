import { stableStringify } from "./ledger.ts";
import type { Capability, CliInvoke, Port } from "./types.ts";

/** Preserve an old operation identity only with fresh, matching observations and an
 * unchanged invocation contract. Inference migration also requires identical program
 * bytes; ordinary compatible repair requires the current behavior fingerprint to match.
 * This function grants no authority and never changes a saved anchor or fingerprint. */
export function carryCliContinuity(before: Capability | undefined, after: Capability, migration = false): Capability {
  if (!before || before.id !== after.id || before.source !== "cli" || after.source !== "cli" || before.risk !== after.risk) return after;
  const old = before.invoke, now = after.invoke;
  if (old.kind !== "cli" || now.kind !== "cli" || !old.behaviour || !now.behaviour) return after;
  if (migration ? old.sha256 !== now.sha256 : old.behaviour !== now.behaviour) return after;
  const shape = ({ sha256, behaviour, examples, continuity, environment, ...invocation }: CliInvoke) => invocation;
  const ports = (list: Port[]) => list.map(({ description, ...port }) => port);
  if (stableStringify(shape(old)) !== stableStringify(shape(now)) ||
      stableStringify(ports(before.inputs)) !== stableStringify(ports(after.inputs)) ||
      stableStringify(ports(before.outputs)) !== stableStringify(ports(after.outputs))) return after;
  const observation = ({ outputPreview, ...example }: NonNullable<CliInvoke["examples"]>[number]) => stableStringify(example);
  const fresh = new Set((now.examples ?? []).map(observation));
  const candidates = [...(old.continuity ?? []), { behaviour: old.behaviour, examples: old.examples ?? [] }];
  const continuity = candidates.filter((entry, i) => entry.behaviour !== now.behaviour &&
    candidates.findIndex(e => e.behaviour === entry.behaviour) === i && entry.examples.length > 0 &&
    entry.examples.every(e => /^[a-f0-9]{64}$/.test(e.outputSha256) && fresh.has(observation(e))));
  return continuity.length ? { ...after, invoke: { ...now, continuity } } : after;
}

/** Local continuity is not portable evidence. A receiver revalidates the current
 * contract; it must not inherit aliases supplied by another runtime or caller. */
export function withoutCliContinuity<T extends Capability["invoke"]>(inv: T): T {
  if (inv.kind !== "cli") return inv;
  const { continuity, environment, ...portable } = inv;
  return portable as T;
}
