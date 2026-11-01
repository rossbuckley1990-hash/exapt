// Read-only dashboard facts. Graph topology, local policy and outcome evidence
// establish different things; none may silently stand in for another.
import type { RightClick } from "../runtime.ts";
import { observedContract } from "../core/activity.ts";

export interface DashboardMetric {
  value: number | null;
  status: "measured" | "unknown" | "not-assessed";
  label: string;
  source: string;
  limitation: string;
}

export interface CapabilityDimension { state: string; source: string; limitation: string; evidence: string[] }

/** Six independent questions. A past successful call is not present-day authority. */
export function capabilityState(rc: RightClick, id: string) {
  const cap = rc.graph.get(id), local = rc.capabilityExecution(id), last = rc.activity.latest(id);
  const completed = rc.activity.latestCompleted(id);
  const evidence = last ? [last.id] : [];
  const dimension = (state: string, source: string, limitation: string, refs = evidence): CapabilityDimension => ({ state, source, limitation, evidence: refs });
  const changed = completed?.contracts?.filter(r => { const c = rc.graph.get(r.capability); return !c || observedContract(c) !== r.contract; }) ?? [];
  const hasObservation = !!completed?.contracts?.length && !completed.truncated;
  const approval = local?.destructiveApproval;
  const blocked = !!local && (!local.allowed || (approval?.mode === "operator" && !approval.operatorApproved));
  const goal = cap?.invoke.kind === "goal" ? rc.published.get(cap.invoke.slug) : undefined;
  const states = {
    discovery: dimension(cap ? "known-descriptor" : "absent", "Current runtime graph", "A descriptor is not proof that its provider is reachable or truthful.", []),
    executability: dimension(!cap ? "unavailable" : blocked ? "locally-blocked" : local?.requiresPlan ? "requires-plan" : "not-assessed", "Current local execution policy and destructive-approval configuration", "Passing local policy does not establish credentials, program authority, sandbox availability, valid inputs or service reachability. No operation is executed by this view.", []),
    authority: dimension("unknown", "No independent exact-action boundary decision attached to this observation", "Discovery, composition and publication grant no authority. A principal, exact action, parameters and protected boundary must be authorised separately. Other shells, tools and credentials are outside this view.", []),
    assurance: dimension(!last ? "not-assessed" : last.status !== "completed" ? `last-${last.status}` : last.verification === "verified" && (last.witnessesPassed ?? 0) > 0 && (last.witnessRuns?.length ?? 0) === last.witnessesPassed ? "witness-passed-on-run" : last.verification === "checked" && (last.predicates ?? 0) > 0 && last.predicatesPassed === last.predicates ? "predicates-passed-on-run" : last.verification === "refuted" ? "refuted-on-run" : "unchecked-on-run", "Latest retained execution/composition observation, not a publication trust label", "Applies only to that historical run. Predicates are local checks. A separate read-only witness provider is not necessarily an independent organisation or a complete business-outcome oracle; receipt hashes are not external attestations."),
    reusability: dimension(!cap ? "unavailable" : goal ? "retained-contract" : cap.invoke.kind === "composite" ? "retained-pipeline" : "descriptor-only", "Matching current graph descriptor and retained goal/pipeline", "Retention does not establish usefulness, current validity, authority or actual fresh-agent reuse.", []),
    validity: dimension(!cap ? "unavailable" : rc.meaningChanges.has(id) ? "changed-operation" : changed.length ? "dependencies-changed" : !hasObservation ? "not-assessed" : "descriptor-matches-observation", "Current contract change detectors compared with the latest completed observation's dependency references", "A later failure cannot erase previously observed dependencies. This historical, non-cryptographic comparison proves neither unchanged behaviour nor current success. Missing/truncated history stays unassessed; remote behaviour may change without a descriptor change.", completed ? [completed.id] : []),
  };
  return { id, title: cap?.title ?? id, provider: cap?.provider ?? null, source: cap?.source ?? null, invocation: cap?.invoke.kind ?? null,
    inputs: cap?.inputs.map(p => ({ name: p.name, type: p.type, required: p.required })) ?? [], outputs: cap?.outputs.map(p => ({ name: p.name, type: p.type })) ?? [],
    states, lastObservation: last ?? null, changedDependencies: changed.map(c => c.capability),
    localPolicy: local ? { allowed: local.allowed, requiresPlan: local.requiresPlan, declaredRisk: local.declaredRisk, consequentialRisks: local.consequentialRisks, destructiveApproval: local.destructiveApproval, reasonCount: local.reasons.length } : null };
}

/** Bound response size and per-capability analysis; search scans descriptors only. */
export function capabilityPage(rc: RightClick, opts: { search?: string; provider?: string; offset?: number; limit?: number } = {}) {
  const limit = Number.isFinite(opts.limit) ? Math.max(1, Math.min(50, Math.floor(opts.limit!))) : 25;
  const offset = Number.isFinite(opts.offset) ? Math.max(0, Math.floor(opts.offset!)) : 0;
  const search = (opts.search ?? "").slice(0, 256).toLocaleLowerCase();
  const page: string[] = [];
  let total = 0;
  for (const c of rc.graph.capabilities.values()) {
    if (opts.provider && c.provider !== opts.provider) continue;
    if (search && !`${c.id} ${c.title} ${c.provider} ${c.source}`.toLocaleLowerCase().includes(search)) continue;
    if (total >= offset && page.length < limit) page.push(c.id);
    total++;
  }
  return { total, offset, limit, hasMore: offset + page.length < total, items: page.map(id => capabilityState(rc, id)), epoch: rc.activity.epoch, cursor: rc.activity.read({ limit: 1 }).cursor };
}

export function dashboardMetrics(rc: RightClick) {
  const powers = rc.graph.powers();
  const retained = [...rc.published.values()].filter((goal) => {
    const cap = rc.graph.get(`goal:${goal.slug}`);
    return cap?.invoke.kind === "goal" && cap.invoke.slug === goal.slug;
  });
  const metric = (label: string, value: number | null, source: string, limitation: string, status: DashboardMetric["status"] = "measured"): DashboardMetric => ({ label, value, status, source, limitation });
  return {
    providers: metric("Providers", rc.graph.providers.size, "graph.providers.size", "Includes local built-ins and retained-capability providers; not a connectivity test."),
    discovered: metric("Discovered operations", rc.graph.capabilities.size, "graph.capabilities.size", "Known operation descriptors, including generated ones. Discovery establishes neither executability nor authority."),
    potentialPaths: metric("Potential typed paths", powers.chains2 + powers.chains3, "graph.powers().chains2 + graph.powers().chains3", "Directed walks through two or three operation nodes. Type compatibility is not semantic validity, a complete plan, authority or a verified workflow."),
    independentlyVerified: metric("Independently verified capabilities", null, "No current capability-wide independent outcome assessment is available", "Stored predicates, publication trust labels and receipt hashes are insufficient. Inspect per-run witness evidence; a separate provider is not an external attestation.", "not-assessed"),
    authorised: metric("Authorised capabilities", null, "No exact action, parameter set, principal and protected-boundary decision is established by this graph view", "Local execution-policy permission is only one prerequisite. Credentials, program authority, destructive approval and the actual execution boundary still apply. Other tools and shells are outside this view.", "unknown"),
    reusable: metric("Retained reusable contracts", retained.length, "published goals with a matching current graph goal descriptor", "Retained callable contracts; not a claim of current validity, independent verification or permission. Each call replans and checks its requirements."),
  };
}
