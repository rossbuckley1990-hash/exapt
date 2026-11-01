// Model access for synthesis. A model only ever proposes text: EXAPT does not give it tools, a
// shell or a filesystem, and it never judges its own output. Credentials stay in the environment
// variable the operator names and are never written to logs, prompts or generated code.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Refused } from "../shared/index.ts";

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  /** Reported by the provider; undefined where it reports none (local models). */
  costUsd?: number;
}

export interface Completion {
  text: string;
  usage: Usage;
  model: string;
  provider: string;
  ms: number;
}

export interface CompletionRequest {
  system: string;
  prompt: string;
  maxTokens: number;
  temperature?: number;
}

export interface ModelAdapter {
  readonly provider: string;
  readonly model: string;
  /** Real means a provider produced the text. A scripted double is never reported as a model. */
  readonly real: boolean;
  complete(req: CompletionRequest): Promise<Completion>;
}

export interface BudgetLimits {
  maxCalls: number;
  maxTokens: number;
  maxCostUsd: number;
}

export const DEFAULT_BUDGET: BudgetLimits = { maxCalls: 12, maxTokens: 120_000, maxCostUsd: 2 };

/** Spending is bounded in EXAPT, not by the model's restraint. */
export class Budget {
  readonly limits: BudgetLimits;
  calls = 0;
  inputTokens = 0;
  outputTokens = 0;
  costUsd = 0;
  /** True once a provider reported a figure, so an unmeasured cost is not shown as zero. */
  costMeasured = false;
  constructor(limits: Partial<BudgetLimits> = {}) {
    this.limits = { ...DEFAULT_BUDGET, ...limits };
  }
  get exhausted(): string | undefined {
    if (this.calls >= this.limits.maxCalls) return `model call budget of ${this.limits.maxCalls} reached`;
    if (this.inputTokens + this.outputTokens >= this.limits.maxTokens) return `token budget of ${this.limits.maxTokens} reached`;
    if (this.costUsd >= this.limits.maxCostUsd) return `cost budget of $${this.limits.maxCostUsd} reached`;
    return undefined;
  }
  record(u: Usage): void {
    this.calls++;
    this.inputTokens += u.inputTokens;
    this.outputTokens += u.outputTokens;
    if (u.costUsd !== undefined) {
      this.costUsd += u.costUsd;
      this.costMeasured = true;
    }
  }
  snapshot() {
    return { calls: this.calls, inputTokens: this.inputTokens, outputTokens: this.outputTokens, costUsd: this.costMeasured ? Number(this.costUsd.toFixed(6)) : null, limits: this.limits };
  }
}

/** Any OpenAI-compatible endpoint: Ollama, LM Studio, vLLM, or a hosted API. */
export class OpenAICompatible implements ModelAdapter {
  readonly provider: string;
  readonly model: string;
  readonly real = true;
  private readonly baseUrl: string;
  private readonly keyEnv?: string;
  private readonly timeoutMs: number;
  constructor(o: { baseUrl: string; model: string; keyEnv?: string; timeoutMs?: number }) {
    this.baseUrl = o.baseUrl.replace(/\/+$/, "");
    this.model = o.model;
    this.keyEnv = o.keyEnv;
    this.provider = `openai-compatible:${new URL(this.baseUrl).host}`;
    this.timeoutMs = o.timeoutMs ?? 300_000;
  }
  async complete(req: CompletionRequest): Promise<Completion> {
    const t0 = performance.now();
    const key = this.keyEnv ? process.env[this.keyEnv] : undefined;
    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      signal: AbortSignal.timeout(this.timeoutMs),
      headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) },
      body: JSON.stringify({ model: this.model, max_tokens: req.maxTokens, temperature: req.temperature ?? 0.2, messages: [{ role: "system", content: req.system }, { role: "user", content: req.prompt }] }),
    });
    if (!res.ok) throw new Error(`model endpoint answered ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const body = (await res.json()) as { choices?: Array<{ message?: { content?: string } }>; usage?: { prompt_tokens?: number; completion_tokens?: number } };
    return {
      text: body.choices?.[0]?.message?.content ?? "",
      usage: { inputTokens: body.usage?.prompt_tokens ?? 0, outputTokens: body.usage?.completion_tokens ?? 0 },
      model: this.model, provider: this.provider, ms: performance.now() - t0,
    };
  }
}

function runCli(cmd: string, args: string[], stdin: string, cwd: string, timeoutMs: number): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((done, fail) => {
    const p = spawn(cmd, args, { cwd, stdio: ["pipe", "pipe", "pipe"], env: process.env });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => p.kill("SIGKILL"), timeoutMs);
    p.stdout.on("data", (d) => (stdout += d));
    p.stderr.on("data", (d) => (stderr += d));
    p.stdin.on("error", () => {});
    p.stdin.end(stdin);
    p.on("error", (e) => {
      clearTimeout(timer);
      fail(e);
    });
    p.on("close", (code) => {
      clearTimeout(timer);
      done({ code, stdout, stderr });
    });
  });
}

/** The Claude Code CLI as a completion endpoint: no tools, no project context, no MCP servers. */
export class ClaudeCli implements ModelAdapter {
  readonly provider = "claude-cli";
  readonly model: string;
  readonly real = true;
  private readonly timeoutMs: number;
  private readonly maxBudgetUsd?: number;
  constructor(o: { model: string; timeoutMs?: number; maxBudgetUsd?: number }) {
    this.model = o.model;
    this.timeoutMs = o.timeoutMs ?? 300_000;
    if (o.maxBudgetUsd !== undefined && (!Number.isFinite(o.maxBudgetUsd) || o.maxBudgetUsd <= 0)) throw new Error("maxBudgetUsd must be positive");
    this.maxBudgetUsd = o.maxBudgetUsd;
  }
  async complete(req: CompletionRequest): Promise<Completion> {
    const t0 = performance.now();
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "exapt-model-"));
    try {
      const r = await runCli("claude", ["-p", "--output-format", "json", "--model", this.model, "--max-turns", "1", "--tools", "", "--strict-mcp-config", "--setting-sources", "", "--no-session-persistence", ...(this.maxBudgetUsd !== undefined ? ["--max-budget-usd", String(this.maxBudgetUsd)] : []), "--system-prompt", req.system], req.prompt, cwd, this.timeoutMs);
      if (r.code !== 0) throw new Error(`claude exited ${r.code}: ${(r.stderr || r.stdout).slice(0, 300)}`);
      const body = JSON.parse(r.stdout) as { result?: string; is_error?: boolean; total_cost_usd?: number; usage?: { input_tokens?: number; output_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number } };
      if (body.is_error) throw new Error(`claude reported an error: ${String(body.result).slice(0, 300)}`);
      const u = body.usage ?? {};
      return {
        text: body.result ?? "",
        usage: { inputTokens: (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0), outputTokens: u.output_tokens ?? 0, costUsd: body.total_cost_usd },
        model: this.model, provider: this.provider, ms: performance.now() - t0,
      };
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  }
}

/** The Codex CLI as a completion endpoint, in a read-only sandbox with an empty working directory. */
export class CodexCli implements ModelAdapter {
  readonly provider = "codex-cli";
  readonly model: string;
  readonly real = true;
  private readonly timeoutMs: number;
  constructor(o: { model?: string; timeoutMs?: number }) {
    this.model = o.model ?? "default";
    this.timeoutMs = o.timeoutMs ?? 300_000;
  }
  async complete(req: CompletionRequest): Promise<Completion> {
    const t0 = performance.now();
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "exapt-model-"));
    const out = path.join(cwd, "answer.txt");
    try {
      const args = ["exec", "--skip-git-repo-check", "--sandbox", "read-only", "--json", "--output-last-message", out, ...(this.model === "default" ? [] : ["--model", this.model]), "-"];
      const r = await runCli("codex", args, `${req.system}\n\n${req.prompt}`, cwd, this.timeoutMs);
      if (r.code !== 0) throw new Error(`codex exited ${r.code}: ${(r.stderr || r.stdout).slice(-300)}`);
      let inputTokens = 0;
      let outputTokens = 0;
      for (const line of r.stdout.split("\n")) {
        try {
          const e = JSON.parse(line);
          const usage = e.usage ?? e.msg?.info?.total_token_usage;
          if (usage) {
            inputTokens = usage.input_tokens ?? inputTokens;
            outputTokens = usage.output_tokens ?? outputTokens;
          }
        } catch {
          /* progress line */
        }
      }
      return { text: fs.existsSync(out) ? fs.readFileSync(out, "utf8") : "", usage: { inputTokens, outputTokens }, model: this.model, provider: this.provider, ms: performance.now() - t0 };
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  }
}

/** Test double replaying fixed completions. Marked not real everywhere it appears. */
export class Scripted implements ModelAdapter {
  readonly provider = "scripted-test-double";
  readonly model = "none";
  readonly real = false;
  private readonly replies: string[];
  readonly prompts: string[] = [];
  constructor(replies: string[]) {
    this.replies = [...replies];
  }
  async complete(req: CompletionRequest): Promise<Completion> {
    this.prompts.push(`${req.system}\n${req.prompt}`);
    return { text: this.replies.shift() ?? "", usage: { inputTokens: 0, outputTokens: 0 }, model: this.model, provider: this.provider, ms: 0 };
  }
}

/** Operator configuration from the environment. No model is a valid, reported state. */
export function modelFromEnv(env: NodeJS.ProcessEnv = process.env): ModelAdapter | null {
  const kind = env.EXAPT_MODEL ?? "none";
  switch (kind) {
    case "none":
      return null;
    case "openai-compatible":
      if (!env.EXAPT_MODEL_BASE_URL || !env.EXAPT_MODEL_NAME) throw new Refused("model-config", "EXAPT_MODEL=openai-compatible needs EXAPT_MODEL_BASE_URL and EXAPT_MODEL_NAME");
      return new OpenAICompatible({ baseUrl: env.EXAPT_MODEL_BASE_URL, model: env.EXAPT_MODEL_NAME, keyEnv: env.EXAPT_MODEL_API_KEY_ENV });
    case "ollama":
      return new OpenAICompatible({ baseUrl: env.EXAPT_MODEL_BASE_URL ?? "http://127.0.0.1:11434/v1", model: env.EXAPT_MODEL_NAME ?? "qwen2.5-coder:14b" });
    case "claude-cli":
      return new ClaudeCli({ model: env.EXAPT_MODEL_NAME ?? "sonnet" });
    case "codex-cli":
      return new CodexCli({ model: env.EXAPT_MODEL_NAME });
    default:
      throw new Refused("model-config", `unknown EXAPT_MODEL=${kind}`, "Use none, ollama, openai-compatible, claude-cli or codex-cli.");
  }
}
