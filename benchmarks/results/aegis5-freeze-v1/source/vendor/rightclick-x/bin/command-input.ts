// Command input decoding stays outside the runtime and never supplies operator policy.
import { createReadStream } from "node:fs";
import { JsonRepresentationError, parseJsonValue } from "../src/core/json.ts";

const MAX_INPUT_BYTES = 16 * 1024 * 1024;
const fail = (message: string): never => { throw new Error(`invalid command input: ${message}`); };

function json(text: string, flag: string): unknown {
  if (Buffer.byteLength(text) > MAX_INPUT_BYTES) fail(`${flag} exceeds 16 MiB`);
  try { return parseJsonValue(text); }
  catch (error) { return fail(error instanceof JsonRepresentationError ? error.message : `${flag} must contain valid JSON`); }
}

async function readInput(path: string): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  const stream = path === "-" ? process.stdin : createReadStream(path);
  for await (const chunk of stream) {
    const bytes = Buffer.from(chunk);
    size += bytes.length;
    if (size > MAX_INPUT_BYTES) fail("--args-file exceeds 16 MiB");
    chunks.push(bytes);
  }
  try { return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)); }
  catch { return fail("--args-file must contain valid UTF-8"); }
}

export async function commandInput(command: "run" | "compose", args: string[]) {
  const flags = new Map<string, string>();
  const positional: string[] = [];
  const allowed = new Set(["args", "args-file", ...(command === "run" ? ["verify"] : ["want", "intent", "run"])]);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith("--")) { positional.push(arg); continue; }
    const equal = arg.indexOf("=");
    const name = arg.slice(2, equal < 0 ? undefined : equal);
    if (!allowed.has(name)) fail(`unknown option --${name}`);
    if (flags.has(name)) fail(`duplicate option --${name}`);
    if (name === "run") {
      if (equal >= 0) fail("--run does not take a value");
      flags.set(name, "true");
    } else {
      const value = equal < 0 ? args[++i] : arg.slice(equal + 1);
      if (value === undefined || value.startsWith("--")) fail(`--${name} needs a value`);
      flags.set(name, value);
    }
  }
  const id = command === "run" ? positional.shift() : undefined;
  if (command === "run" && !id) fail("run requires a capability id");
  if (flags.has("args") && flags.has("args-file")) fail("choose --args or --args-file");
  const structured = flags.has("args") || flags.has("args-file");
  if (structured && positional.length) fail("structured arguments cannot be mixed with k=v");
  let inputs: Record<string, unknown>;
  if (structured) {
    const value = json(flags.has("args") ? flags.get("args")! : await readInput(flags.get("args-file")!), "arguments");
    if (!value || typeof value !== "object" || Array.isArray(value)) fail("arguments must be a JSON object");
    inputs = value as Record<string, unknown>;
  } else {
    const entries = new Map<string, string>();
    for (const arg of positional) {
      const equal = arg.indexOf("=");
      if (equal <= 0) fail("expected k=v or --args / --args-file");
      const name = arg.slice(0, equal);
      if (entries.has(name)) fail(`duplicate input ${JSON.stringify(name)}`);
      entries.set(name, arg.slice(equal + 1));
    }
    inputs = Object.fromEntries(entries);
  }
  const verify = flags.has("verify") ? json(flags.get("verify")!, "--verify") : undefined;
  if (verify !== undefined && !Array.isArray(verify)) fail("--verify requires a JSON array of predicates");
  return { id, inputs, verify, want: flags.get("want") ?? "text", intent: flags.get("intent"), run: flags.has("run") };
}
