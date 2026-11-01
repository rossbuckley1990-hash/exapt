// How a demonstration reaches a different agent. The default is a scripted MCP client, which proves
// the protocol path and is reported as scripted. A real coding agent can be used instead: it gets the
// EXAPT MCP server and a task, and no conversation, capability id or implementation.
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const CLI = path.join(import.meta.dirname, "../../apps/cli/exapt.ts");

export interface ToolCall {
  tool: string;
  args: Record<string, unknown>;
  ms: number;
  ok: boolean;
  result: unknown;
}

/** A fresh `exapt mcp` process and a minimal MCP client speaking to it over stdio. */
export class McpSession {
  private readonly proc: ChildProcessWithoutNullStreams;
  private buffer = "";
  private id = 0;
  private readonly waiting = new Map<number, (m: any) => void>();
  readonly calls: ToolCall[] = [];
  readonly pid: number;

  constructor(env: Record<string, string>) {
    this.proc = spawn(process.execPath, [CLI, "mcp"], { env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "pipe"] });
    this.pid = this.proc.pid!;
    this.proc.stdout.setEncoding("utf8");
    this.proc.stdout.on("data", (d: string) => {
      this.buffer += d;
      let i: number;
      while ((i = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, i);
        this.buffer = this.buffer.slice(i + 1);
        if (!line.trim()) continue;
        const m = JSON.parse(line);
        this.waiting.get(m.id)?.(m);
        this.waiting.delete(m.id);
      }
    });
  }

  private rpc(method: string, params: unknown): Promise<any> {
    const id = ++this.id;
    return new Promise((done) => {
      this.waiting.set(id, done);
      this.proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  async initialize(): Promise<{ tools: number; instructions: string }> {
    const init = await this.rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "demo-client", version: "1" } });
    const list = await this.rpc("tools/list", {});
    return { tools: list.result.tools.length, instructions: init.result.instructions };
  }

  async call(tool: string, args: Record<string, unknown>): Promise<ToolCall> {
    const t0 = performance.now();
    const m = await this.rpc("tools/call", { name: tool, arguments: args });
    const text = m.result?.content?.[0]?.text ?? JSON.stringify(m.error);
    let result: unknown = text;
    try {
      result = JSON.parse(text);
    } catch {
      /* plain text */
    }
    const call: ToolCall = { tool, args, ms: Math.round(performance.now() - t0), ok: !m.result?.isError && !m.error, result };
    this.calls.push(call);
    return call;
  }

  async close(): Promise<void> {
    this.proc.stdin.end();
    await new Promise((r) => this.proc.on("close", r));
  }
}

export interface AgentRun {
  agent: string;
  ok: boolean;
  text: string;
  costUsd?: number;
  toolCalls: Array<{ tool: string; ok: boolean; ms: number }>;
  ms: number;
}

/** Give a real agent the server and a task, in an empty directory, with no history. */
export function runRealAgent(agent: "claude" | "codex", task: string, env: Record<string, string>, dir: string, model?: string): AgentRun {
  const log = path.join(dir, `mcp-${agent}.jsonl`);
  const server = { command: process.execPath, args: [CLI, "mcp"], env: { ...env, EXAPT_MCP_LOG: log } };
  const cwd = fs.mkdtempSync(path.join(dir, `${agent}-session-`));
  const t0 = performance.now();
  let text = "";
  let ok = false;
  let costUsd: number | undefined;
  if (agent === "claude") {
    const config = path.join(cwd, "mcp.json");
    fs.writeFileSync(config, JSON.stringify({ mcpServers: { exapt: server } }));
    const r = spawnSync("claude", ["-p", "--output-format", "json", "--mcp-config", config, "--strict-mcp-config", "--allowedTools", "mcp__exapt__*", "--no-session-persistence", ...(model ? ["--model", model] : [])], { input: task, cwd, encoding: "utf8", timeout: 400_000, maxBuffer: 32 * 1024 * 1024 });
    try {
      const body = JSON.parse(r.stdout);
      text = body.result ?? "";
      ok = !body.is_error;
      costUsd = body.total_cost_usd;
    } catch {
      text = (r.stdout || r.stderr || "").slice(0, 500);
    }
  } else {
    const q = (v: unknown) => JSON.stringify(v);
    const overrides = ["-c", `mcp_servers.exapt.command=${q(server.command)}`, "-c", `mcp_servers.exapt.args=${q(server.args)}`, "-c", `mcp_servers.exapt.env=${`{${Object.entries(server.env).map(([k, v]) => `${k}=${q(v)}`).join(",")}}`}`, "-c", "mcp_servers.exapt.startup_timeout_sec=120", "-c", "mcp_servers.exapt.tool_timeout_sec=300"];
    const out = path.join(cwd, "answer.txt");
    const r = spawnSync("codex", ["exec", "--skip-git-repo-check", "--sandbox", "read-only", ...overrides, "--output-last-message", out, "-"], { input: task, cwd, encoding: "utf8", timeout: 400_000, maxBuffer: 32 * 1024 * 1024 });
    ok = r.status === 0;
    text = fs.existsSync(out) ? fs.readFileSync(out, "utf8") : (r.stderr ?? "").slice(-500);
  }
  const toolCalls = fs.existsSync(log) ? fs.readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).map((e) => ({ tool: e.tool, ok: e.ok, ms: e.ms })) : [];
  return { agent, ok, text, ...(costUsd !== undefined ? { costUsd } : {}), toolCalls, ms: Math.round(performance.now() - t0) };
}
