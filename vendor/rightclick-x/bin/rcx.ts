#!/usr/bin/env node
// rcx — the RightClick X command line. Runs on Node >= 22.18 (native
// TypeScript), Bun, or as a single compiled binary (`npm run build:bin`).

import { authorityFromEnv } from "../src/core/authority.ts";
import { createHandler } from "../src/interface/http.ts";
import { dispatch } from "../src/interface/tools.ts";
import { FileStore, serve, serveStdio } from "../src/entry/node-host.ts";
import { Authority } from "../src/reflectors/net.ts";
import { environmentOptions } from "../src/reflectors/environment.ts";
import { RightClick, VERSION } from "../src/runtime.ts";
import { decodeState, isLegacyState, STATE_FORMAT } from "../src/core/state-format.ts";
import { commandInput } from "./command-input.ts";

const proc = (globalThis as any).process;
const argv: string[] = proc.argv.slice(2);
const env: Record<string, string | undefined> = proc.env;

function flag(name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  if (i < 0) return undefined;
  const v = argv[i + 1];
  argv.splice(i, v && !v.startsWith("--") ? 2 : 1);
  return v && !v.startsWith("--") ? v : "true";
}

const HELP = `RightClick X ${VERSION} — a live capability graph that composes itself

  rcx demo [--online]               seven-act demo across OpenAPI, GraphQL, MCP, web, federation
  rcx serve [--port 8787] [--host 127.0.0.1] [--demo]
                                    HTTP API + MCP (/mcp) + live dashboard (/)
  rcx mcp                           MCP over stdio (for Claude Code, Cursor, Codex, ...)
  rcx connect [client] [--authorise <paths>]
                                    print the exact MCP config for: claude-code, claude-desktop,
                                    cursor, vscode, codex, windsurf, remote (any HTTP MCP client);
                                    --authorise lets that client's agents investigate and run the
                                    listed local programs (comma-separated; directories end in "/")
  rcx doctor                        check this host: Node, sandbox, state, authority
  rcx audit                         report execution risks and operator restrictions as JSON
  rcx investigate <program-path...> investigate local programs you authorise (this command is your
                                    authority for this run) and explain what was found
  rcx capabilities [--json]         what this installation can do now, with each capability's status
  rcx knowledge export [--out f]    portable capability knowledge (needs RCX_SHARE_EVIDENCE=1)
  rcx knowledge import <file>       import knowledge; every capability is revalidated here first
  rcx uninstall                     how to remove RightClick X and everything it stored

  rcx research [topic] [--learn N]  refresh approved environment catalogs and survey public directories
                                    RCX_ENVIRONMENT: JSON {"catalogs":["https://host/.well-known/api-catalog"],
                                    "origins":["https://api-host"]}; discovery never grants execution authority
  rcx learn <url...> [--deep]       reflect any spec / endpoint / MCP server / page / peer
  rcx forget <provider>
  rcx inspect <value>               semantic type of a value
  rcx actions <value>               what can be done with it, directly and through pipelines
  rcx explain <capability-id> [--full]
  rcx run <capability-id> [k=v ...] [--verify '<json predicates>']
  rcx compose k=v ... --want <type> [--intent "..."] [--run]
                                    run/compose: use --args '<JSON object>' or --args-file <path>
                                    for arrays/objects; --args-file - reads stdin (UTF-8, max 16 MiB).
                                    Choose one input form. k=v values stay strings; failures exit nonzero.
  rcx graph [stats|types|search|neighbors|paths|edges] [--query q] [--id id] [--from t] [--to t]
  rcx providers | runtime | status [runId] | watch

Recovery: RCX_WORKFLOW_RECOVERY=1 opts this host into retaining bounded workflow inputs and outputs
in its local state file. Resume pending compositions with rcx run resume:<run-id>; no new inputs.
Restrictions and checks are retained, and current execution authority is required. Default: off.

State: ${env.RCX_STATE_FILE ?? "~/.rightclick-x/state.json"} (RCX_STATE_FILE). Authority: RCX_DESTRUCTIVE=operator|agent-confirm|allow, RCX_APPROVE=<ids>, RCX_RETRY=<ids or origins>, RCX_INVESTIGATE / RCX_EXECUTE=<program paths>, RCX_CLI_CONFORMANCE='{"cli:<program>:<command>":{"samples":[…]}}', RCX_SHARE_EVIDENCE=1. Credentials: RCX_AUTH='{"https://api.x.com":"Bearer …"}'.`;

async function main() {
  const cmd = argv.shift() ?? "help";
  if (cmd === "help" || cmd === "--help" || cmd === "-h") return console.log(HELP);
  if (cmd === "version" || cmd === "--version") return console.log(VERSION);

  if (cmd === "connect") {
    const authorise = flag("authorise") ?? flag("authorize");
    return console.log(await connectInstructions(argv[0], authorise && authorise !== "true" ? authorise : undefined));
  }
  if (cmd === "uninstall") return console.log(uninstallSteps());

  if (cmd === "demo") {
    const { runDemo } = await import("../demo/run.ts");
    return runDemo({ online: !!flag("online") });
  }

  // Decode before state load/migration: malformed input must not initiate any runtime work.
  const input = cmd === "run" || cmd === "compose" ? await commandInput(cmd, argv) : undefined;
  if (env.RCX_WORKFLOW_RECOVERY !== undefined && !["0", "1"].includes(env.RCX_WORKFLOW_RECOVERY)) {
    throw new Error("RCX_WORKFLOW_RECOVERY must be 0 or 1");
  }

  const auth = new Authority();
  auth.loadEnv(env.RCX_AUTH);
  const home = env.HOME ?? env.USERPROFILE ?? ".";
  const stateFile = env.RCX_STATE_FILE ?? `${home}/.rightclick-x/state.json`;
  // Before any runtime exists: a diagnostic must not load, migrate or create the operator's state.
  if (cmd === "doctor") return doctor(stateFile);
  const demoMode = cmd === "serve" && !!flag("demo");
  // `rcx investigate <paths>` is typed by the operator: the paths it names are authorised for this run.
  const investigateNow = cmd === "investigate" ? argv.filter((a) => !a.startsWith("--")).map((a) => (a.startsWith("/") ? a : `${proc.cwd()}/${a}`)) : [];
  const authority = authorityFromEnv(env);
  if (investigateNow.length) authority.investigate = [...(authority.investigate ?? []), ...investigateNow];
  const rc = await RightClick.create({
    name: env.RCX_NAME ?? "rightclick-x",
    region: env.RCX_REGION,
    auth,
    workspace: env.RCX_WORKSPACE ?? proc.cwd(),
    store: demoMode ? undefined : new FileStore(stateFile, { onBackup: (p) => console.error(`RightClick X: upgraded ${stateFile} to the current state format; the original is kept at ${p}`) }),
    workflowRecovery: env.RCX_WORKFLOW_RECOVERY === "1",
    authority,
    environment: environmentOptions(env.RCX_ENVIRONMENT),
  });

  if (env.RCX_MCP_LOG) {
    const { appendFileSync } = await import("node:fs");
    const file = env.RCX_MCP_LOG;
    rc.toolCallSink = (e) => appendFileSync(file, JSON.stringify(e) + "\n");
  }
  if (cmd === "mcp") return serveStdio(rc);

  if (cmd === "serve") {
    const port = Number(flag("port") ?? env.PORT ?? 8787);
    const host = flag("host") ?? "127.0.0.1";
    const loopback = ["127.0.0.1", "localhost", "::1"].includes(host);
    let token = flag("token") ?? env.RCX_TOKEN;
    if (!token && !loopback) {
      token = [...crypto.getRandomValues(new Uint8Array(24))].map((b) => b.toString(16).padStart(2, "0")).join("");
      console.log(`Generated access token (set RCX_TOKEN to choose your own): ${token}`);
    }
    // Exposed beyond loopback: "learn any URL" must never reach private networks or cloud metadata.
    if (!loopback) rc.net.policy = { blockPrivate: true, ...(rc.net.policy ?? {}) };
    const s = await serve(createHandler(rc, { token, open: loopback }), port, host);
    if (!loopback) console.log("Network policy: private, loopback and cloud-metadata addresses are blocked for outbound requests.");
    console.log(`RightClick X ${VERSION} on ${s.url}\n  dashboard  ${s.url}/\n  MCP        ${s.url}/mcp\n  API        ${s.url}/api/<tool>`);
    if (demoMode) {
      const { startStage } = await import("../demo/stage.ts");
      const stage = await startStage();
      console.log("Demo services up. Learning them one by one; watch the dashboard grow.");
      const steps: Array<[string, () => Promise<unknown>]> = [
        ["Polyglot (OpenAPI)", () => rc.learn({ source: stage.polyglot })],
        ["Atlas (GraphQL)", () => rc.learn({ source: stage.atlas })],
        ["Skycast (MCP)", () => rc.learn({ source: stage.skycast })],
        ["Newsroom (web)", () => rc.learn({ source: stage.newsroom })],
        ["compose: Lisbon weather in Spanish", () => rc.compose({ have: { place: "Lisbon", language: "es" }, want: "text", intent: "weather translated", run: true })],
      ];
      for (const [label, step] of steps) {
        await new Promise((r) => setTimeout(r, 2500));
        await step();
        console.log(`  ✓ ${label}`);
      }
    }
    return new Promise(() => {});
  }

  if (cmd === "investigate") return investigateCommand(rc, investigateNow);
  if (cmd === "capabilities") return capabilitiesCommand(rc, !!flag("json"));
  if (cmd === "knowledge") return knowledgeCommand(rc, argv);

  const rest = argv;
  let out: unknown;
  switch (cmd) {
    case "audit":
      out = rc.auditExecution();
      break;
    case "research":
      out = await dispatch(rc, "context_research", { topic: rest[0], learn: Number(flag("learn") ?? 0) || undefined });
      break;
    case "learn":
      out = await dispatch(rc, "context_learn", { deep: !!flag("deep"), sources: rest });
      break;
    case "forget":
      out = await dispatch(rc, "context_forget", { provider: rest[0] });
      break;
    case "inspect":
      out = await dispatch(rc, "context_inspect", { value: rest.join(" ") });
      break;
    case "actions":
      out = await dispatch(rc, "context_actions", { value: rest.join(" ") });
      break;
    case "explain": {
      const full = !!flag("full");
      out = await dispatch(rc, "context_explain", { id: rest[0], detail: full ? "full" : "run" });
      break;
    }
    case "run": {
      out = await dispatch(rc, "context_run", { id: input!.id, args: input!.inputs, verify: input!.verify });
      if ((out as { status: string }).status !== "completed") proc.exitCode = 1;
      break;
    }
    case "compose": {
      out = await dispatch(rc, "context_compose", { have: input!.inputs, want: input!.want, intent: input!.intent, run: input!.run });
      if (input!.run && (out as { executed?: { status: string } }).executed?.status !== "completed") proc.exitCode = 1;
      break;
    }
    case "graph": {
      const q = { op: rest[0] ?? "stats", query: flag("query"), id: flag("id"), from: flag("from"), to: flag("to") };
      out = await dispatch(rc, "context_graph", q);
      break;
    }
    case "providers":
      out = await dispatch(rc, "context_providers", {});
      break;
    case "runtime":
      out = await dispatch(rc, "context_runtime", {});
      break;
    case "status":
      out = await dispatch(rc, "context_run_status", { runId: rest[0] });
      break;
    case "watch": {
      let since = rc.graph.cursor;
      for (;;) {
        const w = await rc.watch({ since, waitMs: 30_000 });
        for (const e of w.events) console.log(JSON.stringify(e));
        since = w.cursor;
      }
    }
    default:
      console.error(`unknown command: ${cmd}\n\n${HELP}`);
      proc.exitCode = 2;
      return;
  }
  console.log(JSON.stringify(out, null, 2));
  await rc.flush();
}

async function connectInstructions(client?: string, authorise?: string): Promise<string> {
  const { existsSync } = await import("node:fs");
  const { resolve, delimiter, join } = await import("node:path");
  const script: string = resolve(proc.argv[1]);
  // Prefer the stable PATH entry (e.g. /opt/homebrew/bin/node) over a versioned install path.
  const onPath = String(env.PATH ?? "").split(delimiter).map((d) => join(d, "node")).find((p) => existsSync(p));
  const node: string = onPath ?? proc.execPath;
  const json = (o: unknown) => JSON.stringify(o, null, 2);
  const envBlock = authorise ? { env: { RCX_INVESTIGATE: authorise } } : {};
  const std = { command: node, args: [script, "mcp"], ...envBlock };
  const blocks: Record<string, string> = {
    "claude-code": `# Claude Code\nclaude mcp add rightclick-x --scope user ${authorise ? `-e RCX_INVESTIGATE=${JSON.stringify(authorise)} ` : ""}-- ${node} ${script} mcp`,
    "claude-desktop": `# Claude Desktop: add to claude_desktop_config.json\n${json({ mcpServers: { "rightclick-x": std } })}`,
    cursor: `# Cursor: add to ~/.cursor/mcp.json\n${json({ mcpServers: { "rightclick-x": std } })}`,
    vscode: `# VS Code: add to .vscode/mcp.json\n${json({ servers: { "rightclick-x": { type: "stdio", ...std } } })}`,
    codex: `# Codex: add to ~/.codex/config.toml\n[mcp_servers.rightclick-x]\ncommand = ${JSON.stringify(node)}\nargs = ${JSON.stringify([script, "mcp"])}${authorise ? `\nenv = { RCX_INVESTIGATE = ${JSON.stringify(authorise)} }` : ""}`,
    windsurf: `# Windsurf: add to ~/.codeium/windsurf/mcp_config.json\n${json({ mcpServers: { "rightclick-x": std } })}`,
    remote: `# Any Streamable-HTTP MCP client (deployed instance or \`rcx serve\`)\nURL:    https://<your-deployment>/mcp   (local: http://127.0.0.1:8787/mcp)\nHeader: Authorization: Bearer <RCX_TOKEN>\n${json({ mcpServers: { "rightclick-x": { type: "http", url: "https://<your-deployment>/mcp", headers: { Authorization: "Bearer <RCX_TOKEN>" } } } })}`,
  };
  if (client && blocks[client]) return blocks[client];
  return Object.values(blocks).join("\n\n");
}

// ---------------------------------------------------------------- operator commands

async function doctor(stateFile: string) {
  const { hostSandbox } = await import("../src/core/sandbox.ts");
  const fs = await import("node:fs");
  const path = await import("node:path");
  const line = (ok: boolean | null, what: string, detail = "") => console.log(`${ok === null ? "–" : ok ? "✓" : "✗"} ${what}${detail ? `: ${detail}` : ""}`);
  const [major, minor] = String(proc.versions.node).split(".").map(Number);
  line(major > 22 || (major === 22 && minor >= 18), "Node.js", `${proc.versions.node} (needs ≥ 22.18)`);
  const sb = await hostSandbox();
  if (!sb) line(false, "sandbox", "none on this host: local programs are never investigated or run (everything else works)");
  else {
    const r = await sb.run("/bin/echo", ["sandbox ok"]);
    line(r.stdout.trim() === "sandbox ok", "sandbox", `${sb.kind}; ${sb.enforces.join("; ")}`);
  }
  // Read-only: the state is decoded in memory, never loaded into a runtime that could save it.
  if (!fs.existsSync(stateFile)) {
    let dir = path.dirname(stateFile);
    while (!fs.existsSync(dir) && path.dirname(dir) !== dir) dir = path.dirname(dir);
    let writable = true;
    try { fs.accessSync(dir, fs.constants.W_OK); } catch { writable = false; }
    line(writable, "state", `${stateFile} (created on first use${writable ? "" : `; ${dir} is not writable`})`);
  } else {
    try {
      const value = JSON.parse(fs.readFileSync(stateFile, "utf8"));
      const state = decodeState(value);
      const caps = state.reflections.reduce((n, r) => n + r.capabilities.length, 0);
      const retained = `${state.reflections.length} providers, ${caps} capabilities, ${state.published?.length ?? 0} saved goals retained`;
      const deferred = state.deferredInference?.length ? `; ${state.deferredInference.length} deferred reflections awaiting re-derivation (a source unreachable or not authorised here, or a pipeline waiting on one; not executable until then)` : "";
      if (isLegacyState(value)) {
        line(true, "state", `${stateFile}: legacy format (version 1), ${retained}. The next command that saves state upgrades it to ${STATE_FORMAT} and first keeps the original as ${path.basename(stateFile)}.v1-backup-<time>; doctor changes nothing`);
      } else {
        line(true, "state", `${stateFile}: ${STATE_FORMAT}, ${retained}${deferred}`);
      }
    } catch (e) {
      line(false, "state", `${stateFile} is unreadable: ${(e as Error).message}. RightClick X refuses to start on it and never overwrites it`);
    }
  }
  const auth = authorityFromEnv(env);
  line(null, "programs agents may investigate", auth.investigate?.length ? auth.investigate.join(", ") : "none (set RCX_INVESTIGATE, or rcx connect <client> --authorise <paths>)");
  line(null, "destructive operations", auth.destructive === "operator" ? "only with operator approval (RCX_APPROVE) plus the caller's confirm" : auth.destructive ?? "operator");
  line(null, "evidence export", auth.shareEvidence ? "allowed (RCX_SHARE_EVIDENCE=1)" : "not allowed (default)");
  line(null, "startup network", "none: restoring state never contacts a provider; deferred ones re-derive on first use or context_learn (docs/STARTUP-NETWORK.md)");
  console.log(`\nNext: rcx connect claude-code --authorise /path/to/program   then ask your agent to use it.`);
}

async function investigateCommand(rc: RightClick, paths: string[]) {
  if (!paths.length) return console.log("usage: rcx investigate <program-path...>");
  for (const p of paths) {
    const r = await rc.learn({ source: `cli:${p}` });
    const res = r.results[0];
    console.log(`\n${p}`);
    if (res.error) {
      console.log(`  ✗ not investigated: ${res.error}`);
      continue;
    }
    const detail = res.probes?.[0]?.detail ?? "";
    const caps = rc.graph.list().filter((c) => c.invoke.kind === "cli" && (c.invoke as any).bin === p);
    if (!caps.length) {
      console.log(`  ✗ nothing usable found: ${detail}`);
      continue;
    }
    console.log(`  What was discovered   ${detail}`);
    for (const c of caps) {
      const card: any = rc.card(c);
      const runnable = c.tags.includes("unsupported") ? "observed only, not composed automatically" : c.tags.includes("direct-only") ? "callable directly with arguments you choose" : "executable and composable";
      console.log(`    • ${c.id}  ${c.title}\n        status: ${card.contract.status}; ${runnable}`);
    }
    const inv = rc.investigations.get(p);
    const uncertain = (inv?.claims ?? []).filter((cl) => cl.status === "unknown" || cl.status === "contradicted");
    console.log(`  What was verified     nothing yet: investigation records evidence, it does not verify outcomes. Add checks or an independent witness when you compose.`);
    console.log(`  What is uncertain     ${uncertain.length ? uncertain.slice(0, 6).map((cl) => `${cl.claim} [${cl.status}]`).join("; ") : "nothing recorded"}`);
    console.log(`  Permissions needed    agents need ${p} in RCX_INVESTIGATE (or RCX_EXECUTE) to run these; runs are sandboxed.`);
    console.log(`  Now available         ${caps.map((c) => c.id).join(", ")}  (rcx explain <id> for the full card)`);
  }
}

async function capabilitiesCommand(rc: RightClick, json: boolean) {
  const rows = rc.graph.list().filter((c) => c.source !== "builtin" && c.source !== "platform").map((c) => ({ id: c.id, title: c.title, status: (rc.card(c) as any).contract.status as string, provider: c.provider }));
  if (json) return console.log(JSON.stringify(rows, null, 2));
  if (!rows.length) return console.log("Nothing learned yet. Try: rcx investigate /path/to/program   or   rcx learn <url>");
  for (const r of rows) console.log(`${r.status.padEnd(10)} ${r.id}  ${r.title}`);
}

async function knowledgeCommand(rc: RightClick, args: string[]) {
  const fs = await import("node:fs");
  const sub = args[0];
  if (sub === "export") {
    const out = flag("out");
    const bundle = rc.exportKnowledge();
    const text = JSON.stringify(bundle, null, 2);
    if (out && out !== "true") {
      fs.writeFileSync(out, text);
      console.log(`wrote ${out}: ${bundle.programs.length} programs, ${bundle.programs.reduce((n, p) => n + p.capabilities.length, 0)} capabilities`);
    } else console.log(text);
    return;
  }
  if (sub === "import" && args[1]) {
    const report = await rc.importKnowledge(JSON.parse(fs.readFileSync(args[1], "utf8")));
    for (const p of report.programs) console.log(`${p.status.padEnd(15)} ${p.name}${p.localPath ? ` (${p.localPath})` : ""}: ${p.capabilities.filter((c) => c.status === "accepted").length} accepted, ${p.capabilities.filter((c) => c.status === "refused").length} refused, ${p.revalidationRuns} revalidation runs${p.reason ? ` — ${p.reason}` : ""}`);
    return;
  }
  console.log("usage: rcx knowledge export [--out file] | rcx knowledge import <file>");
}

function uninstallSteps(): string {
  const home = env.HOME ?? env.USERPROFILE ?? "~";
  return [
    "Remove RightClick X:",
    `  1. Disconnect it from your AI clients, e.g.:  claude mcp remove rightclick-x --scope user`,
    `     (other clients: delete the "rightclick-x" entry from their MCP config; see rcx connect)`,
    `  2. Delete what it stored:  ${env.RCX_STATE_FILE ?? `${home}/.rightclick-x/`}  (learned capabilities, saved goals, receipts)`,
    `  3. Remove the package:  npm uninstall -g rightclick-x   (or delete your clone)`,
    "Nothing else is written outside that directory; sandboxed runs use temporary directories that are deleted after each run.",
  ].join("\n");
}

main().catch((e) => {
  console.error(String(e?.stack ?? e));
  proc.exitCode = 1;
});
