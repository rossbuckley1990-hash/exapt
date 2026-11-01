// The benchmark harness. Each trial is written to disk as soon as it ends, and a trial already on
// disk is not run again, so an interruption loses nothing and a rerun cannot quietly replace a bad
// result. An incomplete trial stays incomplete unless the operator deletes it.
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { FIXTURES, type TaskSpec } from "./families.ts";
import { compareOutputs, HOME_FOR, loadCases, type Trial } from "./scoring.ts";
import { pool } from "../packages/shared/index.ts";

const args = process.argv.slice(2);
const opt = (name: string, fallback: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const MODEL = opt("model", "sonnet");
const CAP = Number(opt("cap", "14"));
const LABEL = opt("label", `primary-${MODEL}`);
const PHASES = opt("phases", "cold,drift,warm").split(",");
const ONLY = opt("only", "");
const RESULTS = path.join(import.meta.dirname, "results", LABEL);
const SCRATCH = path.join(fs.realpathSync(os.tmpdir()), "exapt-benchmark", LABEL);
const REPO = path.resolve(import.meta.dirname, "..");
const CLI = path.join(REPO, "apps/cli/exapt.ts");
const CLAUDE = spawnSync("which", ["claude"], { encoding: "utf8" }).stdout.trim();
const SESSION_BUDGET = 0.9;
const TIMEOUT = 720_000;
fs.mkdirSync(RESULTS, { recursive: true });

const tasks = fs.readdirSync(FIXTURES).filter((d) => fs.existsSync(path.join(FIXTURES, d, "task.json"))).sort().filter((d) => !ONLY || d.startsWith(ONLY)).map((d) => JSON.parse(fs.readFileSync(path.join(FIXTURES, d, "task.json"), "utf8")) as TaskSpec);

const resultFile = (t: Trial["task"], arm: string, stage: string) => path.join(RESULTS, `${t}__${arm}__${stage}.json`);
const done = (t: string, arm: string, stage: string) => fs.existsSync(resultFile(t, arm, stage));
const read = (t: string, arm: string, stage: string): Trial | undefined => (done(t, arm, stage) ? JSON.parse(fs.readFileSync(resultFile(t, arm, stage), "utf8")) : undefined);
const spent = (): number => fs.readdirSync(RESULTS).filter((f) => f.endsWith(".json")).reduce((n, f) => n + (JSON.parse(fs.readFileSync(path.join(RESULTS, f), "utf8")).costUsd ?? 0), 0);

function hashDir(dir: string): string {
  const h = createHash("sha256");
  if (fs.existsSync(dir)) for (const f of fs.readdirSync(dir).sort()) h.update(f).update(fs.readFileSync(path.join(dir, f)));
  return h.digest("hex");
}

/** A workspace holds what a person would be given, and nothing about how the task will be scored. */
function workspace(task: TaskSpec, name: string): string {
  const dir = path.join(SCRATCH, task.id, name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.join(dir, "out"), { recursive: true });
  const from = path.join(FIXTURES, task.id);
  fs.mkdirSync(path.join(dir, "programs"), { recursive: true });
  if (fs.existsSync(path.join(from, "programs"))) fs.cpSync(path.join(from, "programs"), path.join(dir, "programs"), { recursive: true });
  fs.cpSync(path.join(from, "sample"), path.join(dir, "sample"), { recursive: true });
  fs.rmSync(path.join(dir, "sample", task.newInput), { force: true });
  return dir;
}

function confinement(dir: string): string {
  const home = process.env.HOME!;
  const file = path.join(dir, ".confine.sb");
  fs.writeFileSync(file, `(version 1)
(allow default)
(deny file-write*)
(allow file-write* (subpath "${dir}") (subpath "${home}/.claude") (literal "${home}/.claude.json") (subpath "/private/tmp") (subpath "/private/var/folders") (subpath "${home}/Library/Caches") (literal "/dev/null") (regex #"^/dev/tty") (regex #"^/dev/fd/"))
(deny file-read* (subpath "${REPO}") (subpath "${home}/.ssh") (subpath "${home}/.aws") (subpath "${home}/.gnupg"))
(deny file-write* (subpath "${dir}/programs"))
`);
  return file;
}

const contract = (task: TaskSpec) => `# Task
${task.outcome}

# What to deliver
- out/run.sh: reads one input on standard input and writes the final result to standard output. It must work on new inputs of the same kind, not only on the samples. It may use node and anything in programs/.
- out/RESULT.json: {"status": "done" | "not-possible", "notes": "..."}. Say "done" only if you believe run.sh gives the right result on new inputs. If the outcome cannot be achieved with what is available, say "not-possible" and do not invent data.

programs/ is on your PATH and is read-only. Work only in this directory.`;

const reusePrompt = (task: TaskSpec, withPrevious: boolean) => `# Task
${task.outcome}

Produce the result for input/${task.newInput} and write it to out/result.txt, exactly as the final program prints it.
Also write out/RESULT.json: {"status": "done" | "not-possible", "notes": "..."}. Say "done" only if you believe the result is right. If you cannot establish the right result, say "not-possible" and do not invent data.
${withPrevious ? "\nprevious/ holds what you saved the last time you did this job." : ""}
programs/ is on your PATH and is read-only. Work only in this directory.`;

const mcpPrompt = (task: TaskSpec, dir: string) => `# Task
${task.outcome}

The file ${dir}/input/${task.newInput} needs this done. Write the result to ${dir}/out/result.txt, exactly as the final program prints it.
Then write nothing else. You have an MCP server named exapt that keeps capabilities built earlier. Use its tools, with file paths for input and output. End your reply with one line, DONE if you believe the result is right, or NOT-POSSIBLE if you could not establish it. Do not invent data.`;

interface Session {
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  turns: number;
  ms: number;
  text: string;
  error?: string;
}

function claude(dir: string, prompt: string, extra: string[], confined: boolean, env: NodeJS.ProcessEnv): Promise<Session> {
  const argv = ["-p", "--output-format", "json", "--model", MODEL, "--strict-mcp-config", "--setting-sources", "", "--no-session-persistence", "--max-budget-usd", String(SESSION_BUDGET), ...extra];
  const [cmd, full] = confined ? ["sandbox-exec", ["-f", confinement(dir), CLAUDE, ...argv]] as const : [CLAUDE, argv] as const;
  const t0 = performance.now();
  return new Promise((resolve) => {
    const p = spawn(cmd, full, { cwd: dir, env, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    const timer = setTimeout(() => p.kill("SIGKILL"), TIMEOUT);
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.stdin.end(prompt);
    p.on("close", (code) => {
      clearTimeout(timer);
      const ms = Math.round(performance.now() - t0);
      try {
        const b = JSON.parse(out) as { result?: string; is_error?: boolean; total_cost_usd?: number; num_turns?: number; usage?: { input_tokens?: number; output_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number } };
        const u = b.usage ?? {};
        resolve({ costUsd: b.total_cost_usd ?? 0, inputTokens: (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0), outputTokens: u.output_tokens ?? 0, turns: b.num_turns ?? 0, ms, text: b.result ?? "", ...(b.is_error ? { error: String(b.result).slice(0, 300) } : {}) });
      } catch {
        resolve({ costUsd: 0, inputTokens: 0, outputTokens: 0, turns: 0, ms, text: "", error: `exit ${code}: ${(err || out).slice(0, 300)}` });
      }
    });
  });
}

const agentEnv = (dir: string): NodeJS.ProcessEnv => ({ ...process.env, PATH: `${path.join(dir, "programs")}:${path.dirname(process.execPath)}:/usr/bin:/bin` });
const AGENT_TOOLS = ["--tools", "Bash,Read,Write,Edit", "--allowedTools", "Bash,Read,Write,Edit"];

const claimOf = (dir: string): Trial["claimed"] => {
  try {
    const s = (JSON.parse(fs.readFileSync(path.join(dir, "out", "RESULT.json"), "utf8")) as { status?: string }).status;
    return s === "done" || s === "not-possible" ? s : "none";
  } catch {
    return "none";
  }
};

const codeBytes = (dir: string): number => {
  const walk = (d: string): number => fs.readdirSync(d, { withFileTypes: true }).reduce((n, e) => {
    const p = path.join(d, e.name);
    if (e.isDirectory()) return n + walk(p);
    return e.name.endsWith(".json") || e.name === "result.txt" ? n : n + fs.statSync(p).size;
  }, 0);
  return fs.existsSync(dir) ? walk(dir) : 0;
};

/** Run out/run.sh against held-out inputs, confined, with the task's own programs on PATH. */
function runScript(dir: string, input: string, binary: boolean | undefined, programsDir = path.join(dir, "programs")): string {
  const r = spawnSync("sandbox-exec", ["-f", confinement(dir), "/bin/sh", path.join(dir, "out", "run.sh")], { cwd: dir, input: binary ? Buffer.from(input, "base64") : input, env: { PATH: `${programsDir}:${path.dirname(process.execPath)}:/usr/bin:/bin`, HOME: dir }, timeout: 20_000, maxBuffer: 16 * 1024 * 1024 });
  return r.status === 0 ? r.stdout.toString("utf8") : "";
}

const finish = (t: Trial) => {
  fs.writeFileSync(resultFile(t.task, t.arm, t.stage), JSON.stringify(t, null, 2));
  console.log(`[${new Date().toISOString().slice(11, 19)}] ${t.task} ${t.arm}/${t.stage}: claimed ${t.claimed}, hidden ${t.hidden.passed}/${t.hidden.total}, $${t.costUsd.toFixed(3)}, ${Math.round(t.ms / 1000)}s${t.incomplete ? `, INCOMPLETE: ${t.incomplete.slice(0, 120)}` : ""}${t.unauthorised?.length ? `, UNAUTHORISED: ${t.unauthorised}` : ""}`);
  return t;
};

async function coldAgent(task: TaskSpec): Promise<void> {
  if (done(task.id, "A", "cold")) return;
  const dir = workspace(task, "agent-cold");
  const before = hashDir(path.join(dir, "programs"));
  const s = await claude(dir, contract(task), AGENT_TOOLS, true, agentEnv(dir));
  const cases = loadCases(task.id, "cases");
  const claimed = claimOf(dir);
  const results = fs.existsSync(path.join(dir, "out", "run.sh")) ? cases.map((c) => compareOutputs(c.expected, runScript(dir, c.input, c.binary), task.compare)) : [];
  const unauthorised = hashDir(path.join(dir, "programs")) === before ? [] : ["programs/ changed"];
  const t: Trial = { arm: "A", stage: "cold", task: task.id, claimed, hidden: { passed: results.filter(Boolean).length, total: claimed === "done" ? cases.length : 0 }, costUsd: s.costUsd, inputTokens: s.inputTokens, outputTokens: s.outputTokens, turns: s.turns, ms: s.ms, codeBytes: codeBytes(path.join(dir, "out")), notes: [s.text.slice(-400)], unauthorised, ...(s.error ? { incomplete: s.error } : {}) };
  finish(t);
  // Arms A and B are the same agent until a later session; B's cold result is A's, by design.
  fs.writeFileSync(resultFile(task.id, "B", "cold"), JSON.stringify({ ...t, arm: "B", notes: ["identical to A/cold by design", ...t.notes] }, null, 2));
}

function engineTrial(arm: "C" | "D", task: TaskSpec): Promise<void> {
  if (done(task.id, arm, "cold")) return Promise.resolve();
  const dir = workspace(task, `${arm}-engine`);
  fs.writeFileSync(path.join(dir, "task.json"), JSON.stringify(task));
  const file = path.join(dir, "trial.json");
  return new Promise((resolve) => {
    const env = { ...process.env, EXAPT_MODEL: arm === "D" ? "claude-cli" : "none", EXAPT_MODEL_NAME: MODEL };
    const p = spawn(process.execPath, [path.join(import.meta.dirname, "arm-engine.ts"), arm, task.id, dir, file], { env, stdio: ["ignore", "pipe", "pipe"] });
    let err = "";
    p.stderr.on("data", (d) => (err += d));
    const timer = setTimeout(() => p.kill("SIGKILL"), 1_200_000);
    p.on("close", () => {
      clearTimeout(timer);
      const t: Trial = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : { arm, stage: "cold", task: task.id, claimed: "none", hidden: { passed: 0, total: 0 }, costUsd: 0, inputTokens: 0, outputTokens: 0, turns: 0, ms: 0, codeBytes: 0, notes: [], incomplete: err.slice(-400) };
      finish(t);
      resolve();
    });
  });
}

/** One later session: new input, a fresh agent, and whatever this arm retains. */
async function later(task: TaskSpec, arm: "A" | "B" | "D", stage: "warm" | "drift"): Promise<void> {
  if (done(task.id, arm, stage)) return;
  const cases = loadCases(task.id, stage === "drift" ? "drift" : "cases");
  const target = cases[0];
  const dir = workspace(task, `${arm}-${stage}`);
  const fixture = path.join(FIXTURES, task.id);
  if (stage === "drift") fs.cpSync(path.join(fixture, "drift", "programs"), path.join(dir, "programs"), { recursive: true, force: true });
  fs.mkdirSync(path.join(dir, "input"), { recursive: true });
  fs.writeFileSync(path.join(dir, "input", task.newInput), target.binary ? Buffer.from(target.input, "base64") : target.input);
  const before = hashDir(path.join(dir, "programs"));
  let s: Session;
  let toolCalls: string[] | undefined;
  if (arm === "D") {
    const coldDir = path.join(SCRATCH, task.id, "D-engine");
    const home = path.join(dir, ".exapt-home");
    fs.cpSync(HOME_FOR(coldDir), home, { recursive: true });
    // Programs live where the cold run authorised them, so a change is seen as a change.
    if (stage === "drift") fs.cpSync(path.join(fixture, "drift", "programs"), path.join(coldDir, "programs"), { recursive: true, force: true });
    const log = path.join(dir, "mcp.jsonl");
    const config = path.join(dir, ".mcp.json");
    fs.writeFileSync(config, JSON.stringify({ mcpServers: { exapt: { command: process.execPath, args: [CLI, "mcp"], env: { EXAPT_HOME: home, EXAPT_PROGRAMS: [path.join(coldDir, "programs"), ...(task.hostPrograms ?? [])].join(":"), EXAPT_DATA_ROOTS: dir, EXAPT_MODEL: "claude-cli", EXAPT_MODEL_NAME: MODEL, EXAPT_MAX_COST_USD: "0.8", EXAPT_MCP_LOG: log } } } }));
    s = await claude(dir, mcpPrompt(task, dir), ["--tools", "", "--mcp-config", config, "--allowedTools", "mcp__exapt__*"], false, process.env);
    toolCalls = fs.existsSync(log) ? fs.readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => (JSON.parse(l) as { tool: string }).tool) : [];
    const said = s.text.trim().split("\n").pop() ?? "";
    fs.writeFileSync(path.join(dir, "out", "RESULT.json"), JSON.stringify({ status: /NOT-POSSIBLE/.test(said) ? "not-possible" : /DONE/.test(said) ? "done" : "none" }));
    if (stage === "drift") fs.cpSync(path.join(fixture, "programs"), path.join(coldDir, "programs"), { recursive: true, force: true });
  } else {
    if (arm === "B") fs.cpSync(path.join(SCRATCH, task.id, "agent-cold", "out"), path.join(dir, "previous"), { recursive: true });
    s = await claude(dir, reusePrompt(task, arm === "B"), AGENT_TOOLS, true, agentEnv(dir));
  }
  const claimed = claimOf(dir);
  const file = path.join(dir, "out", "result.txt");
  const right = fs.existsSync(file) && compareOutputs(target.expected, fs.readFileSync(file, "utf8"), task.compare);
  finish({ arm, stage, task: task.id, claimed, hidden: { passed: right ? 1 : 0, total: claimed === "done" ? 1 : 0 }, costUsd: s.costUsd, inputTokens: s.inputTokens, outputTokens: s.outputTokens, turns: s.turns, ms: s.ms, codeBytes: arm === "D" ? 0 : codeBytes(path.join(dir, "out")), notes: [s.text.slice(-300)], unauthorised: hashDir(path.join(dir, "programs")) === before ? [] : ["programs/ changed"], ...(toolCalls ? { toolCalls } : {}), ...(s.error ? { incomplete: s.error } : {}) });
}

const overCap = () => spent() >= CAP;

async function main() {
  console.log(`benchmark ${LABEL}: model ${MODEL}, cap $${CAP}, ${tasks.length} tasks, spent so far $${spent().toFixed(2)}`);
  if (PHASES.includes("cold")) {
    await pool(tasks, 3, (t) => (overCap() ? Promise.resolve() : coldAgent(t)));
    for (const t of tasks) await engineTrial("C", t);
    await pool(tasks, 2, (t) => (overCap() ? Promise.resolve() : engineTrial("D", t)));
  }
  const reusable = tasks.filter((t) => t.answer === "done");
  if (PHASES.includes("drift")) {
    const jobs = reusable.filter((t) => t.hasDrift).flatMap((t) => (["A", "B", "D"] as const).map((arm) => ({ t, arm })));
    await pool(jobs, 3, ({ t, arm }) => (overCap() ? Promise.resolve() : later(t, arm, "drift")));
  }
  if (PHASES.includes("warm")) {
    const jobs = reusable.flatMap((t) => (["A", "B", "D"] as const).map((arm) => ({ t, arm })));
    await pool(jobs, 3, ({ t, arm }) => (overCap() ? Promise.resolve() : later(t, arm, "warm")));
  }
  console.log(`finished; spent $${spent().toFixed(2)} of $${CAP}${overCap() ? " (cap reached: remaining trials were not run)" : ""}`);
  void read;
}

await main();
