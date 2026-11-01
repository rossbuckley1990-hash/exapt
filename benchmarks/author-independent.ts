// Tasks written by a separate model session that has never seen EXAPT. The brief does not mention
// it, and the session works in an empty directory with no project context. These are frozen before
// any arm runs on them and are not edited afterwards. See preregistration.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { FIXTURES, HOLDOUTS, ROOT, type TaskSpec } from "./families.ts";
import { writeJson } from "../packages/shared/index.ts";

const DOMAINS: Array<[string, string]> = [["I1", "seismology station bulletins"], ["I2", "theatre box office settlements"], ["I3", "beekeeping hive inspection records"]];
const brief = fs.readFileSync(path.join(ROOT, "preregistration/authoring-brief.md"), "utf8");

export async function author(id: string, domain: string, model: string): Promise<number> {
  const work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `exapt-author-${id}-`)));
  const profile = path.join(work, ".confine.sb");
  const home = process.env.HOME!;
  fs.writeFileSync(profile, `(version 1)\n(allow default)\n(deny file-write*)\n(allow file-write* (subpath "${work}") (subpath "${home}/.claude") (literal "${home}/.claude.json") (subpath "/private/tmp") (subpath "/private/var/folders") (subpath "${home}/Library/Caches") (literal "/dev/null") (regex #"^/dev/tty") (regex #"^/dev/fd/"))\n(deny file-read* (subpath "${home}/.ssh") (subpath "${home}/.aws") (subpath "${home}/.gnupg"))\n`);
  const r = spawnSync("sandbox-exec", ["-f", profile, "claude", "-p", "--output-format", "json", "--model", model, "--tools", "Bash,Read,Write,Edit", "--allowedTools", "Bash,Read,Write,Edit", "--strict-mcp-config", "--setting-sources", "", "--no-session-persistence", "--max-budget-usd", "1.5"], { input: brief.replace("{{DOMAIN}}", domain), cwd: work, encoding: "utf8", timeout: 900_000, maxBuffer: 64 * 1024 * 1024 });
  const body = JSON.parse(r.stdout || "{}") as { total_cost_usd?: number; is_error?: boolean; result?: string };
  console.log(id, domain, "author cost", body.total_cost_usd, "error", body.is_error, String(body.result).slice(0, 160));
  await finalise(id, domain, work, `a fresh ${model} session`, body.total_cost_usd ?? 0);
  return body.total_cost_usd ?? 0;
}

/** Turn an authored directory into a task. Nothing the author wrote is altered. */
export async function finalise(id: string, domain: string, work: string, who: string, cost: number): Promise<void> {
  const dir = path.join(FIXTURES, `${id}-independent`);
  const hold = path.join(HOLDOUTS, `${id}-independent`);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.join(dir, "sample"), { recursive: true });
  fs.cpSync(path.join(work, "programs"), path.join(dir, "programs"), { recursive: true });
  fs.mkdirSync(hold, { recursive: true });
  for (const f of ["reference.mjs", "hidden.mjs"]) fs.copyFileSync(path.join(work, f), path.join(hold, f));
  const t = JSON.parse(fs.readFileSync(path.join(work, "task.json"), "utf8")) as { outcome: string; target: string; sample: string };
  fs.copyFileSync(path.join(work, t.sample), path.join(dir, "sample", "input.txt"));
  const { inputs } = await import(path.join(hold, "hidden.mjs")) as { inputs: () => string[] };
  const { adapter } = await import(path.join(hold, "reference.mjs")) as { adapter: (p: string) => string };
  const programs = fs.readdirSync(path.join(dir, "programs"));
  const help = (p: string) => spawnSync(path.join(dir, "programs", p), ["--help"], { encoding: "utf8", cwd: work }).stdout ?? "";
  const target = t.target;
  const producer = programs.find((p) => {
    if (p === target) return false;
    const out = spawnSync(path.join(dir, "programs", p), { input: fs.readFileSync(path.join(work, t.sample), "utf8"), encoding: "utf8", cwd: work });
    if (out.status !== 0 || !out.stdout.trim()) return false;
    try {
      return spawnSync(path.join(dir, "programs", target), { input: adapter(out.stdout), encoding: "utf8", cwd: work }).status === 0;
    } catch {
      return false;
    }
  });
  if (!producer) throw new Error(`${id}: no producer chain works; help: ${programs.map(help).join("\n").slice(0, 300)}`);
  const cases = inputs().map((input) => {
    const p = spawnSync(path.join(dir, "programs", producer), { input, encoding: "utf8", cwd: work }).stdout;
    return { input, expected: spawnSync(path.join(dir, "programs", target), { input: adapter(p), encoding: "utf8", cwd: work }).stdout };
  });
  writeJson(path.join(hold, "cases.json"), cases);
  fs.writeFileSync(path.join(dir, "sample", "new.txt"), cases[0].input);
  const spec: TaskSpec = {
    id: `${id}-independent`, family: "independent", origin: "independent", answer: "done", compare: "text", newInput: "new.txt",
    outcome: `${t.outcome} The input looks like sample/input.txt. The programs in programs/ document themselves with --help.`,
    goal: { id: `${id}-independent`, intent: t.outcome, have: { samples: [{ path: "sample/input.txt" }] }, want: { program: target } },
  };
  writeJson(path.join(dir, "task.json"), spec);
  fs.writeFileSync(path.join(dir, "AUTHOR.txt"), `Written by ${who} from preregistration/authoring-brief.md. Domain: ${domain}. Producer: ${producer}. Consumer: ${target}. Cost: ${cost}.\n`);
}

if (process.argv[1] === import.meta.filename && process.argv[2] === "--finalise") {
  const [id, work] = process.argv.slice(3);
  await finalise(id, DOMAINS.find(([x]) => x === id)![1], work, "a fresh sonnet session", Number(process.argv[5] ?? 0));
} else if (process.argv[1] === import.meta.filename) {
  const model = process.argv[2] ?? "sonnet";
  const results = await Promise.allSettled(DOMAINS.map(([id, domain]) => author(id, domain, model)));
  for (const r of results) if (r.status === "rejected") console.error(String(r.reason).slice(0, 400));
}
