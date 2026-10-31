// Demonstration 3. A capability outlives the process and the agent that made it. A different agent
// finds it through MCP and uses it on other data without recreating it. When its dependency changes
// compatibly, reuse continues after revalidation. When a dependency changes in meaning, reuse stops.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { compareRecords, parseRecords, sniffSyntax } from "../../packages/capability-universe/index.ts";
import { rawDump, referenceAdapter, writeEnvironment } from "../missing-transformation/environment.ts";
import { bad, good, heading, saveReport, say, workspace } from "../support.ts";
import { McpSession, runRealAgent, type AgentRun } from "./agents.ts";

const CLI = path.join(import.meta.dirname, "../../apps/cli/exapt.ts");

export async function demo3(opts: { seed?: number; dir?: string; agents?: Array<"claude" | "codex">; agentModel?: string } = {}): Promise<{ ok: boolean; dir: string; report: string }> {
  const seed = opts.seed ?? 16;
  const dir = opts.dir ?? workspace("demo3");
  const env = writeEnvironment(seed, dir);
  const home = path.join(dir, ".exapt");
  const environment = { EXAPT_HOME: home, EXAPT_PROGRAMS: env.programs };
  const goalFile = path.join(dir, "goal.json");
  fs.writeFileSync(goalFile, JSON.stringify(env.goal));
  const p = env.params;
  const record: Record<string, unknown> = { seed };
  heading("Demonstration 3: inherited superpower");

  heading("1. One process creates the capability, then exits");
  const t0 = performance.now();
  const created = spawnSync(process.execPath, [CLI, "invent", "--goal", goalFile, "--seed", String(seed), "--quiet"], { env: { ...process.env, ...environment }, encoding: "utf8", timeout: 400_000 });
  const coldMs = Math.round(performance.now() - t0);
  const outcome = JSON.parse(created.stdout || "{}");
  say(`creator process exited ${created.status} after ${coldMs}ms: ${outcome.outcome}`);
  say(outcome.synthesis ? `synthesis: ${outcome.synthesis.mode} (${outcome.synthesis.producer})` : "no synthesis");
  const capability: string = outcome.capability?.id;
  record.creation = { ms: coldMs, outcome: outcome.outcome, capability, synthesis: outcome.synthesis };
  if (!capability) {
    bad("nothing was created");
    return { ok: false, dir, report: saveReport(dir, "demo3-report", record) };
  }

  heading("2. A fresh process and a client with no conversation find it through MCP");
  const session = new McpSession(environment);
  const init = await session.initialize();
  say(`new process ${session.pid}: ${init.tools} tools, no tool per capability`);
  const found = await session.call("exapt_memory", { query: "" });
  const entry = (found.result as { capabilities: Array<{ id: string; purpose: string; level: string }> }).capabilities[0];
  say(`found ${entry.id}: ${entry.purpose} [${entry.level}]`);
  const explained = await session.call("exapt_explain", { id: entry.id });
  const facts = explained.result as { domain: string[]; limitations: string[]; how: string; dependencies: unknown[] };
  say(`domain: ${facts.domain.join("; ")}`);
  const raw = rawDump(p, 777_000 + seed, 25);
  const exported = spawnSync(path.join(env.programs, p.programs.exporter), { input: raw, encoding: "utf8" }).stdout;
  const usedAt = performance.now();
  const used = await session.call("exapt_use", { id: entry.id, input: exported });
  const warmMs = Math.round(performance.now() - usedAt);
  const output = (used.result as { output: string }).output;
  const expected = referenceAdapter(p, exported);
  const syntax = sniffSyntax(expected);
  const correct = used.ok && compareRecords(parseRecords(expected, syntax), parseRecords(output ?? "", syntax)).equal;
  if (correct) good(`correct on 25 new records in ${warmMs}ms, matching a reference the capability never saw`);
  else bad(`wrong or refused: ${JSON.stringify(used.result).slice(0, 200)}`);
  const inventions = (await session.call("exapt_status", {})).result as { runs: unknown[] };
  if (inventions.runs.length === 1) good("no new synthesis ran: the only run on record is the creator's");
  else bad(`${inventions.runs.length} runs on record`);
  record.reuse = { process: session.pid, toolCalls: session.calls.map((c) => ({ tool: c.tool, ms: c.ms, ok: c.ok })), warmMs, correct, coldMs };
  await session.close();

  const agents: AgentRun[] = [];
  for (const agent of opts.agents ?? []) {
    heading(`2b. A real agent, ${agent}, with no history`);
    const fresh = rawDump(p, 888_000 + seed, 12);
    const input = spawnSync(path.join(env.programs, p.programs.exporter), { input: fresh, encoding: "utf8" }).stdout;
    const task = `You have an MCP server named exapt. I need this table converted so that ${p.programs.ingester} can read it. Do not write any code. Print only the converted data in your final answer, with nothing else.\n\n${input}`;
    const r = runRealAgent(agent, task, environment, dir, opts.agentModel);
    agents.push(r);
    const truth = referenceAdapter(p, input);
    const stripped = r.text.replace(/```\w*\n?/g, "").trim();
    let right = false;
    try {
      right = compareRecords(parseRecords(truth, sniffSyntax(truth)), parseRecords(stripped, sniffSyntax(truth))).equal;
    } catch {
      right = false;
    }
    say(`${agent}: tool calls ${r.toolCalls.map((c) => c.tool).join(" -> ") || "(none recorded)"}; ${r.ms}ms${r.costUsd !== undefined ? `, $${r.costUsd.toFixed(4)}` : ""}`);
    if (r.toolCalls.some((c) => c.tool === "exapt_use") && !r.toolCalls.some((c) => c.tool === "exapt_invent")) good(`${agent} reused the capability without recreating it`);
    else bad(`${agent} did not reuse the capability through exapt_use`);
    if (right) good(`${agent}'s answer matches the reference`);
    else bad(`${agent}'s answer does not match the reference: ${r.text.slice(0, 160)}`);
    (r as AgentRun & { correct?: boolean }).correct = right;
  }
  if (agents.length) record.agents = agents;

  heading("3. A compatible change to a dependency");
  const consumerFile = path.join(env.programs, p.programs.ingester);
  const originalConsumer = fs.readFileSync(consumerFile, "utf8");
  fs.writeFileSync(consumerFile, `${originalConsumer}\n// 2.3.2: documentation fixes only\n`);
  const s2 = new McpSession(environment);
  await s2.initialize();
  const after = await s2.call("exapt_use", { id: entry.id, input: exported });
  const reval = (after.result as { revalidation?: { outcome: string; checks: { passed: number; total: number }; changed: unknown[]; ms: number } }).revalidation;
  if (after.ok && reval?.outcome === "compatible") good(`${p.programs.ingester} changed; revalidated as compatible (${reval.checks.passed}/${reval.checks.total} checks) in ${reval.ms}ms, and reuse continued`);
  else bad(`expected a compatible revalidation: ${JSON.stringify(after.result).slice(0, 240)}`);
  record.compatibleChange = { revalidation: reval, ok: after.ok };
  await s2.close();

  heading("4. An incompatible behavioural change");
  say(`${p.programs.ingester} is replaced by a build that reads the same fields and now computes something different. Its interface is unchanged.`);
  const current = fs.readFileSync(consumerFile, "utf8");
  fs.writeFileSync(consumerFile, current.replace("e.n++; e.sum += ", "e.n++; e.sum += 7 + "));
  const s3 = new McpSession(environment);
  await s3.initialize();
  const refused = await s3.call("exapt_use", { id: entry.id, input: exported });
  const safe = !refused.ok;
  if (safe) good(`refused: ${(refused.result as { message: string }).message?.slice(0, 150)}`);
  else bad("the capability ran silently against a changed dependency");
  const state = (await s3.call("exapt_explain", { id: entry.id })).result as { status: string };
  say(`status is now ${state.status}`);
  const again = await s3.call("exapt_use", { id: entry.id, input: exported });
  record.incompatibleChange = { refused: safe, status: state.status, refusal: refused.result, secondCallRefused: !again.ok };
  await s3.close();
  fs.writeFileSync(consumerFile, originalConsumer);

  heading("5. Adaptation to a changed interface, where the evidence supports it");
  say(`A new release of ${p.programs.ingester} and ${p.programs.archiver} renames ${p.target.value} to reading_v2.`);
  const archiverFile = path.join(env.programs, p.programs.archiver);
  const rename = (t: string) => t.replaceAll(p.target.value, "reading_v2");
  fs.writeFileSync(consumerFile, rename(originalConsumer));
  fs.writeFileSync(archiverFile, rename(fs.readFileSync(archiverFile, "utf8")));
  const repair = spawnSync(process.execPath, [CLI, "repair", entry.id], { env: { ...process.env, ...environment }, encoding: "utf8", timeout: 400_000 });
  const repaired = JSON.parse(repair.stdout || "{}");
  const adapted = repaired.capability?.status === "verified-within-scope";
  if (adapted) good(`constructed ${repaired.capability.id}@${repaired.capability.version} against the new release`);
  else bad(`repair did not establish a new version: ${repaired.outcome ?? repair.stderr.slice(0, 200)}`);
  record.adaptation = repaired;

  const ok = !!correct && inventions.runs.length === 1 && reval?.outcome === "compatible" && safe && !!adapted;
  const report = saveReport(dir, "demo3-report", record);
  console.log(`\n${ok ? "\x1b[32mDemonstration 3 passed.\x1b[0m" : "\x1b[31mDemonstration 3 did not pass.\x1b[0m"} Report: ${report}`);
  return { ok, dir, report };
}
