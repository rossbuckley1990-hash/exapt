#!/usr/bin/env node
// exapt: the command line. Complex inputs are JSON files, never shell strings. Exit codes:
// 0 done, 1 failed, 2 usage, 3 refused, 4 ran but not established.
import fs from "node:fs";
import path from "node:path";
import { configFromEnv, Exapt, type Objective } from "../../packages/protocol/engine.ts";
import { serveStdio } from "../../packages/protocol/mcp.ts";
import { pullImage } from "../../packages/execution/index.ts";
import { createHandler, serve } from "../server/index.ts";
import { Refused } from "../../packages/shared/index.ts";
import type { Goal } from "../../packages/capability-universe/index.ts";
import { runDemos } from "../../demos/run.ts";
import { prepareLabEnvironment } from "../../demos/lab-environment.ts";

const HELP = `exapt — Exaptive Capability Engine

  exapt setup                         fetch the pinned sandbox image
  exapt doctor [--no-attack]          check this host, and attack the sandbox to prove containment
  exapt discover [--refresh] [--json] investigate authorised programs; report what they really do
  exapt analyse --goal goal.json      is this outcome possible with what exists?
  exapt invent --goal goal.json       construct the missing capability
        [--seed N] [--strategy auto|model-first|model-only|deterministic-only] [--no-publish]
  exapt status [run-id]               a run's stage, attempts and evidence
  exapt inspect <capability-id> [--full]
  exapt use <capability-id> --input input.txt [--binary] [--out file]
  exapt evolve <capability-id> --objective smaller|simpler|faster|leaner|robust
  exapt revalidate <capability-id>    establish again whether its evidence holds here
  exapt repair <capability-id>        construct a new version against today's programs
  exapt memory [--kind capabilities|failures|workflows] [--query words]
  exapt export <capability-id> --out bundle.json
  exapt import bundle.json            accept a definition; it must pass here to do anything
  exapt publish <run-id>              operator approval of a verified candidate
  exapt pin <capability-id> <version> | exapt unpin <capability-id>
  exapt revoke <capability-id> --reason words
  exapt serve [--port 8799] [--lab]   HTTP API, MCP at /mcp, EXAPT LAB at /
  exapt mcp                           MCP over stdio
  exapt demo [1|2|3|all] [--seed N]   the three demonstrations

Configuration comes from exapt.config.json or the environment, never from an agent:
  EXAPT_PROGRAMS   colon-separated program paths or directories
  EXAPT_MODEL      none | ollama | openai-compatible | claude-cli | codex-cli
  EXAPT_HOME, EXAPT_MODEL_NAME, EXAPT_MODEL_BASE_URL, EXAPT_MODEL_API_KEY_ENV, EXAPT_PUBLISH,
  EXAPT_STRATEGY, EXAPT_MAX_MODEL_CALLS, EXAPT_MAX_TOKENS, EXAPT_MAX_COST_USD
`;

const argv = process.argv.slice(2);
const command = argv.shift();

function flag(name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  if (i < 0) return undefined;
  const v = argv[i + 1];
  argv.splice(i, v !== undefined && !v.startsWith("--") ? 2 : 1);
  return v !== undefined && !v.startsWith("--") ? v : "true";
}

const print = (v: unknown) => console.log(typeof v === "string" ? v : JSON.stringify(v, null, 2));

function readGoal(): { goal: Goal; base: string } {
  const file = flag("goal");
  if (!file) throw new Refused("usage", "--goal goal.json is required");
  const full = path.resolve(file);
  return { goal: JSON.parse(fs.readFileSync(full, "utf8")) as Goal, base: path.dirname(full) };
}

async function main(): Promise<number> {
  if (!command || command === "help" || command === "--help") {
    print(HELP);
    return command ? 0 : 2;
  }
  if (command === "setup") return pullImage() ? 0 : 1;
  if (command === "demo") return runDemos(argv[0] && !argv[0].startsWith("--") ? argv[0] : "all", { seed: flag("seed") ? Number(flag("seed")) : undefined });
  const lab = command === "serve" ? flag("lab") : undefined;
  const environment = lab ? prepareLabEnvironment() : undefined;
  const config = configFromEnv(process.env, environment ? { programs: [...(configFromEnv().programs), environment.programs] } : {});
  const exapt = await Exapt.open(config);
  switch (command) {
    case "doctor": {
      const report = await exapt.doctor({ attack: flag("no-attack") === undefined });
      for (const c of report.checks) console.log(`${{ ok: "ok  ", warn: "warn", fail: "FAIL" }[c.status]}  ${c.name}: ${c.detail}${c.next ? `\n      next: ${c.next}` : ""}`);
      for (const c of report.selfTest?.checks ?? []) console.log(`      ${c.passed ? "contained" : "ESCAPED  "}  ${c.name}`);
      console.log(report.ok ? "\nReady." : "\nNot ready: fix the failures above.");
      return report.ok ? 0 : 1;
    }
    case "discover": {
      const r = await exapt.discover({ refresh: flag("refresh") !== undefined });
      if (flag("json") !== undefined) print(exapt.summary({ limit: 200 }));
      else {
        const s = exapt.summary({ limit: 0 });
        console.log(`${r.programs} programs investigated, ${r.learned.length} interfaces established, ${r.unusable.length} without an accepted input.`);
        for (const p of s.programs) console.log(`  ${p.name}\n      accepts  ${p.accepts}\n      produces ${p.produces}`);
        if (r.unusable.length) console.log(`No accepted input observed for: ${r.unusable.join(", ")}`);
      }
      return 0;
    }
    case "analyse": {
      const { goal, base } = readGoal();
      const a = await exapt.analyseCompact(goal, base);
      print(a);
      return 0;
    }
    case "invent": {
      const { goal, base } = readGoal();
      const quiet = flag("quiet") !== undefined;
      if (!quiet) exapt.events.on("event", (e) => console.error(`[${e.type}] ${String(e.stage ?? e.summary ?? e.reason ?? e.producer ?? e.problem ?? e.note ?? e.outcome ?? "").slice(0, 160)}`));
      const r = await exapt.startInvention(goal, base, { seed: flag("seed") ? Number(flag("seed")) : undefined, strategy: flag("strategy") as never, publish: flag("no-publish") === undefined });
      print({ run: r.id, status: r.status, outcome: r.outcome, capability: r.capability, synthesis: r.synthesis, level: r.evidence?.level, tiers: r.evidence?.tiers, workflow: r.workflow ? { ok: r.workflow.ok, output: r.workflow.output } : undefined });
      if (r.status === "refused") return 3;
      return r.capability?.status === "verified-within-scope" || r.workflow?.ok ? 0 : 4;
    }
    case "status": {
      const id = argv[0];
      if (!id) {
        for (const r of exapt.runs(20)) console.log(`${r.id}  ${r.status.padEnd(10)} ${r.goal.id}  ${r.outcome.slice(0, 90)}`);
        return 0;
      }
      const r = exapt.run(id);
      if (!r) throw new Refused("unknown-run", `no run ${id}`);
      print({ ...r, goal: r.goal.id, contract: r.contract?.id });
      return 0;
    }
    case "inspect":
      print(exapt.explain(argv[0], flag("full") !== undefined ? "full" : "summary"));
      return 0;
    case "use": {
      const file = flag("input");
      if (!argv[0] || !file) throw new Refused("usage", "exapt use <capability-id> --input file");
      const binary = flag("binary") !== undefined;
      const r = await exapt.use(argv[0], binary ? fs.readFileSync(file).toString("base64") : fs.readFileSync(file, "utf8"), binary ? { encoding: "base64" } : {});
      const out = flag("out");
      if (out) fs.writeFileSync(out, r.output);
      else process.stdout.write(r.output);
      console.error(`${r.capability}@${r.version} ${r.level} in ${r.ms}ms${r.receipt ? `, receipt ${r.receipt.slice(0, 12)}` : ""}`);
      return 0;
    }
    case "evolve":
      print(await exapt.evolve(argv[0], (flag("objective") ?? "smaller") as Objective));
      return 0;
    case "revalidate": {
      const r = await exapt.revalidate(argv[0]);
      print(r);
      return r.outcome === "incompatible" || r.outcome === "unavailable" ? 3 : 0;
    }
    case "repair": {
      const r = await exapt.repair(argv[0]);
      print({ run: r.id, outcome: r.outcome, capability: r.capability });
      return r.capability?.status === "verified-within-scope" ? 0 : 4;
    }
    case "memory":
      print(exapt.memory({ kind: flag("kind") as never, query: flag("query") }));
      return 0;
    case "export": {
      const out = flag("out");
      if (!out) throw new Refused("usage", "--out bundle.json is required");
      fs.writeFileSync(out, JSON.stringify(exapt.exportCapability(argv[0]), null, 2));
      return 0;
    }
    case "import": {
      const r = await exapt.importCapability(JSON.parse(fs.readFileSync(argv[0], "utf8")));
      print(r.revalidation);
      return r.revalidation.outcome === "accepted-import" ? 0 : 3;
    }
    case "publish":
      print({ capability: (await exapt.publishRun(argv[0], "operator")).capability });
      return 0;
    case "pin":
      exapt.vault.pin(argv[0], Number(argv[1]));
      return 0;
    case "unpin":
      exapt.vault.pin(argv[0], null);
      return 0;
    case "revoke":
      exapt.vault.revoke(argv[0], flag("reason") ?? "revoked by the operator");
      exapt.host.retireOperation(argv[0]);
      return 0;
    case "mcp":
      await exapt.discover().catch((e) => console.error(`discovery: ${e.message}`));
      await serveStdio(exapt, process.env.EXAPT_MCP_LOG ? (entry) => fs.appendFileSync(process.env.EXAPT_MCP_LOG!, `${JSON.stringify(entry)}\n`) : undefined);
      return 0;
    case "serve": {
      const port = Number(flag("port") ?? 8799);
      await exapt.discover().catch((e) => console.error(`discovery: ${e.message}`));
      const server = await serve(createHandler(exapt, { goals: environment ? [environment.entry] : [] }), port, "127.0.0.1");
      console.log(`EXAPT service at ${server.url}\n  EXAPT LAB   ${server.url}/\n  MCP         ${server.url}/mcp\n  RightClick X ${server.url}/rcx/`);
      await new Promise(() => {});
      return 0;
    }
    default:
      console.error(`unknown command: ${command}\n\n${HELP}`);
      return 2;
  }
}

main().then((code) => process.exit(code), (e: Refused) => {
  console.error(`${e.code ? "refused" : "error"}: ${e.message}${e.next ? `\nnext: ${e.next}` : ""}`);
  process.exit(e.code === "usage" ? 2 : e.code ? 3 : 1);
});
