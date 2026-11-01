// Capability investigation for command-line programs that publish no machine-readable contract.
//
// Given only a program the operator authorised (discovery authority), this learns what the
// program can do from what it declares (usage text, manual page) and from bounded, sandboxed
// experiments with synthetic inputs, and turns behaviour it can support with evidence into
// typed capabilities. Nothing here knows any particular program.
//
// Evidence statuses: declared (the program's own documentation says so), observed (seen in a
// run), inferred (derived from declarations or observations, not tested), experimentally
// supported (consistent across distinct inputs and repeat runs), contradicted (declared but not
// what was observed), unknown. "verified" is never set here: only independent checks set it.

import type { Capability, CliInvoke, Port, Reflection, SemType } from "../core/types.ts";
import { inferType } from "../core/semantics.ts";
export type { CliInvoke };
import type { Sandbox, SandboxRun } from "../core/sandbox.ts";
import { reportsApplicationError } from "../core/cli-outcome.ts";

export type EvidenceStatus = "declared" | "observed" | "inferred" | "experimentally-supported" | "verified" | "contradicted" | "unknown";

export interface Claim {
  subject: string;
  claim: string;
  status: EvidenceStatus;
  evidence: string;
}


export interface Investigation {
  program: { bin: string; name: string; sha256: string; size: number; version?: string; description?: string };
  sandbox: string;
  runs: Array<{ id: number; purpose: string; args: string[]; stdinBytes: number; files: string[]; code: number | null; timedOut: boolean; stdoutBytes: number; stderrPreview: string; stdoutPreview: string; created: string[]; ms: number }>;
  options: Array<{ flags: string[]; arg?: string; optionalArg?: string; description: string }>;
  operands: { required: string[]; optional: string[]; variadic: boolean };
  claims: Claim[];
  limits: { maxRuns: number; timeoutMs: number; maxOutputBytes: number };
  summary: string;
}

const MAX_RUNS = 160;
// Large multi-verb tools (Miller: 74 documented verbs) must not be truncated mid-alphabet:
// their most useful verbs (sort, tail, uniq) can come after dozens of others.
const MAX_VERBS = 96;

// ---------------------------------------------------------------- declared documentation

export function parseUsage(text: string): { options: Investigation["options"]; synopsis: string[] } {
  // Manual pages rendered without full mdoc support leave spacing macros behind ("-t -Sm tab1 Sm").
  const clean = text.replace(/.\x08/g, "").replace(/(^|\s)-?Sm(?=\s|$)/gm, "$1");
  const options: Investigation["options"] = [];
  const seen = new Set<string>();
  const lines = clean.split("\n");
  const indent = (l: string) => /^\s*/.exec(l)![0].length;
  // A flag, optionally with an argument: "=MACRO[:FORMAT]", " <file>", " NAME", "[=WHEN]" (optional).
  const OPTION_LINE = /^(\s{0,12})((?:-{1,2}[A-Za-z0-9?][\w-]*(?:\[=[^\]]+\]|[ =](?:<[^>]+>|\{[^}]+\}|[A-Z][A-Z_]+|\[[^\]]+\])(?:\[[^\]]*\])*)?(?:,\s*|\s+or\s+|\s+|$))+)(.*)$/;
  for (let i = 0; i < lines.length; i++) {
    const m = OPTION_LINE.exec(lines[i]);
    if (!m) continue;
    const flags = [...m[2].matchAll(/-{1,2}[A-Za-z0-9?][\w-]*/g)].map((x) => x[0]);
    if (!flags.length || seen.has(flags[0])) continue;
    const optionalArg = /\[=([^\]]+)\]/.exec(m[2])?.[1];
    let arg = optionalArg ? undefined : /(?:[ =])(<[^>]+>|\{[^}]+\}|[A-Z][A-Z_]+|\[[^\]]+\])/.exec(m[2])?.[1];
    arg = arg?.replace(/^\{(.*)\}$/, "$1");
    let rest = m[3];
    // Description lines that follow, indented further than the option itself (manual pages put
    // the description beside or below the flag and wrap it over several lines).
    const more: string[] = [];
    for (let j = i + 1; j < lines.length && more.length < 6; j++) {
      const l = lines[j];
      if (!l.trim()) {
        if (more.length) break;
        continue;
      }
      if (indent(l) <= indent(lines[i]) || (OPTION_LINE.test(l) && indent(l) <= indent(lines[i]) + 2)) break;
      more.push(l.trim());
    }
    // An argument written in plain lower case (manual pages lose their italics): one word right
    // after the flag, then a wide gap or the end of the line, with the description elsewhere.
    if (!arg) {
      const a = /^([a-z][\w.-]*(?:,\s*[a-z.][\w.-]*)*(?:\s*\.\.\.)?)(\s{2,}|\s*$)(.*)$/.exec(rest);
      if (a && (a[3].trim() || more.length)) {
        arg = a[1];
        rest = a[3];
      }
    }
    seen.add(flags[0]);
    const description = [rest.trim(), ...more].filter(Boolean).join(" ").replace(/\s+/g, " ");
    options.push({ flags, ...(arg ? { arg } : {}), ...(optionalArg ? { optionalArg } : {}), description: description.slice(0, 300) });
  }
  const synopsis = clean.split("\n").filter((l) => /^\s*(usage:|\s*[a-z][\w-]*\s+\[-)/i.test(l)).map((l) => l.trim()).slice(0, 6);
  // Options a synopsis or usage line declares only in brackets ("[-typemap typemap]",
  // "[-strip|s pattern]", "[-v]"): declared too, without descriptions, unless described elsewhere.
  const manSynopsis = /SYNOPSIS\s*\n([\s\S]*?)\n\s*\n/.exec(clean)?.[1] ?? "";
  // An argument may be followed by nested repetition groups: "[-json_opt opt1[,opt2[,...]]]".
  for (const g of `${synopsis.join(" ")} ${manSynopsis}`.matchAll(/\[\s*(-{1,2}[A-Za-z0-9][\w-]*(?:\|-{0,2}[A-Za-z0-9][\w-]*)*)(?:[ =]+([A-Za-z][\w.-]*)(?:\[(?:[^[\]]|\[(?:[^[\]]|\[[^[\]]*\])*\])*\])*)?\s*\]/g)) {
    const flags = g[1].split("|").map((f) => (f.startsWith("-") ? f : `-${f}`));
    // A description that lists the flag alone ("-json_opt" on its own line) does not say it takes
    // no argument; the synopsis does say it takes one.
    const described = options.find((o) => o.flags.some((f) => flags.includes(f)));
    if (described && g[2] && !described.arg && !described.optionalArg) described.arg = g[2];
    if (flags.some((f) => seen.has(f)) || options.length >= 120) continue;
    // A single-dash word can be one option or a compact bundle. Only the whole spelling is
    // declared here. Individual letters need their own declarations; do not invent flags.
    for (const f of flags) seen.add(f);
    options.push({ flags, ...(g[2] ? { arg: g[2] } : {}), description: "(declared in the synopsis)" });
  }
  return { options: options.slice(0, 120), synopsis };
}

/** Operands named in a synopsis line: required ones outside brackets, optional ones inside. */
export function parseOperands(synopsis: string[], name: string): Investigation["operands"] {
  const required: string[] = [];
  const optional: string[] = [];
  let variadic = false;
  // Join continuation lines, then drop flags and their metavariables ("--xpath XPath_expression"),
  // so alternatives like [--version | --debug | ...] are never read as operands.
  const joined = synopsis.join(" ").replace(/\s+/g, " ");
  const firstUse = joined.search(new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`));
  let own = joined.slice(Math.max(0, firstUse)).split(/\busage:/i)[0];
  // A synopsis can list a sibling command ("expand [...] [file ...] unexpand [-a | -t ...]"):
  // only this program's own entry describes its operands.
  const sibling = /\s([a-z][\w.-]*)\s+\[\s*-/.exec(own.slice(name.length));
  if (sibling && sibling[1] !== name) own = own.slice(0, name.length + sibling.index);
  for (const raw of [own]) {
    const line = raw.replace(/^usage:\s*/i, "").replace(/(^|[\s\[|])-{1,2}[A-Za-z0-9?][\w-]*(=\S+|\s+(?=[A-Z][A-Za-z_]*\b)[A-Z][A-Za-z_]*)?/g, "$1");
    const after = line.slice(line.indexOf(name) >= 0 ? line.indexOf(name) + name.length : 0);
    // Nested optional groups ("[[+]offset[.][Bb]]") are optional as a whole: mark the outermost
    // group's words optional, innermost first, so none of them is read as a required operand.
    let flat = after;
    for (let i = 0; i < 6 && /\[[^\[\]]*\]/.test(flat); i++) flat = flat.replace(/\[([^\[\]]*)\]/g, (_m, inner) => `\u0001${inner.replace(/[\u0001\u0002]/g, " ")}\u0002`);
    const groups = flat.replace(/\u0001/g, "[").replace(/\u0002/g, "]");
    // Drop option groups, then read what is left.
    const noOpts = groups.replace(/\[\s*-[^\]]*\]/g, " ");
    for (const m of noOpts.matchAll(/\[([^\]]+)\]|([A-Za-z][\w.-]*)/g)) {
      if (m[1]) {
        const word = /[A-Za-z][\w-]*/.exec(m[1])?.[0];
        if (word && !/^-/.test(m[1].trim()) && word !== name) optional.push(word);
        if (/\.\.\./.test(m[1])) variadic = true;
      } else if (m[2] && !/^(options?|flags?)$/i.test(m[2]) && m[2] !== name) required.push(m[2].replace(/\.+$/, ""));
    }
    if (/\.\.\./.test(noOpts)) variadic = true;
    if (required.length || optional.length) break;
  }
  // "file1 file2 file3 ..." is an example of a variadic list, not three operands.
  const uniq = [...new Set(required)];
  const stems = uniq.map((r) => r.replace(/\d+$/, ""));
  const collapsed = variadic && uniq.length >= 3 && stems.every((st) => st === stems[0]) ? [stems[0]] : uniq;
  return { required: collapsed.slice(0, 4), optional: [...new Set(optional)].slice(0, 4), variadic };
}

// ---------------------------------------------------------------- subcommands

export interface Subcommand { name: string; description: string }

/**
 * Commands a dispatcher program declares in its help: a "Commands:", "Subcommands:" or
 * "Verbs:" section followed by indented entries. Entry names are one token; a description,
 * when present, is separated by a wide gap (Click) or is empty (Miller's verb list).
 */
export function parseSubcommands(text: string): Subcommand[] {
  const out: Subcommand[] = [];
  const seen = new Set<string>();
  let inSection = false;
  for (const line of text.split("\n")) {
    if (/^\s*(commands?|subcommands?|available commands?|verbs?)\s*:\s*$/i.test(line)) {
      inSection = true;
      continue;
    }
    if (!inSection) continue;
    if (!line.trim()) {
      if (out.length) break;
      continue;
    }
    // An unindented line (or another heading) ends the section.
    if (!/^\s/.test(line)) break;
    // The gap between the name and a description is wide; "mlr help list-verbs" is one phrase,
    // not a command named "mlr" with a description.
    const m = /^\s{2,}([a-z][a-z0-9._-]{0,40})(?:(?:\t+| {2,})(.*))?\s*$/.exec(line);
    if (!m) {
      if (out.length) break;
      continue;
    }
    const name = m[1];
    if (/^(options?|flags?|usage|commands?|verbs?|help)$/i.test(name) || seen.has(name)) continue;
    seen.add(name);
    out.push({ name, description: (m[2] ?? "").trim().replace(/\.{3}$/, "").slice(0, 200) });
    if (out.length >= 96) break;
  }
  return out;
}

/** A bare command list ("mlr -l"): every non-empty line is one command name, nothing else. */
export function parseCommandList(text: string, program: string): Subcommand[] {
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  if (lines.length < 2 || lines.length > 96) return [];
  if (!lines.every((l) => /^[a-z][a-z0-9._-]{0,39}$/.test(l))) return [];
  const seen = new Set<string>();
  const out: Subcommand[] = [];
  for (const name of lines) {
    if (name === program || seen.has(name)) continue;
    seen.add(name);
    out.push({ name, description: "" });
  }
  return out;
}

/** Topic names a help command lists ("* help flags", "* help topics"). */
export function parseHelpTopics(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split("\n")) {
    const m = /^\s*\S+\s+help\s+([a-z][\w/-]*)\s*$/i.exec(line);
    if (m && !out.includes(m[1])) out.push(m[1]);
    if (out.length >= 96) break;
  }
  return out;
}

/** Program-level options documented separately from a subcommand (e.g. a help topic). */
function mergeOptions(base: Investigation["options"], extra: Investigation["options"]): { options: Investigation["options"]; added: number } {
  const seen = new Set(base.flatMap((o) => o.flags));
  const options = [...base];
  let added = 0;
  for (const o of extra) {
    if (o.flags.some((f) => seen.has(f))) continue;
    for (const f of o.flags) seen.add(f);
    options.push(o);
    if (++added >= 160) break;
  }
  return { options: options.slice(0, 160), added };
}

const DESTRUCTIVE_COMMAND = /\b(delete|remove|destroy|drop|purge|erase|truncate|revoke|uninstall|kill|terminate|reset|overwrite|deploy|publish)\b/i;
const WRITE_COMMAND = /\b(create|update|patch|put|post|write|save|rename|move|install|grant|chmod|chown|import|upload|commit|push|merge)\b/i;
const EXTERNAL_COMMAND = /\b(api|http|https|url|network|remote|fetch|download|upload|send|sync|pull|push)\b/i;

/** The least authority a subcommand's own name and description support. */
function commandRisk(name: string, description: string): "read" | "write" | "external" | "destructive" {
  const text = `${name} ${description}`;
  if (DESTRUCTIVE_COMMAND.test(text)) return "destructive";
  if (WRITE_COMMAND.test(text)) return "write";
  if (EXTERNAL_COMMAND.test(text)) return "external";
  return "read";
}

// ---------------------------------------------------------------- volatile output

/** Date-times such as file timestamps ("2026:10:17 14:47:38+01:00", "2026-10-17T14:47:38Z"). */
const DATE_TIME = /\b\d{4}[:\-/]\d{2}[:\-/]\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:[+-]\d{2}:?\d{2}|Z)?/g;
/** Output with date-times replaced: used only where two identical runs were shown to differ by them alone. */
export const withoutTimes = (s: string) => s.replace(DATE_TIME, "<time>");

// ---------------------------------------------------------------- operands: files or literal values

/**
 * Operands a synopsis names as values rather than files (tr's string1/string2, grep's pattern,
 * colrm's start/stop): passed as argv text, not materialised as file content. Unknown names stay
 * files, the common case for data programs.
 */
export function isLiteralOperand(name: string): boolean {
  const n = name.toLowerCase().replace(/[^a-z]/g, "").replace(/\d+$/, "");
  return /^(string|set|pattern|regexp?|regex|expr|expression|search|word|chars?|character|number|num|count|n|width|columns?|col|lines?|size|length|start|stop|end|first|last|incr|increment|format|fmt|key|delim|delimiter|separator|sep|list|fields?|range|value|arg|args|argument|offset|skip|base|radix|position|pos|string)$/.test(n);
}

/** A sample value for a literal operand or option argument, chosen by its name (generic). */
export function literalSample(name: string, variant: number, sampleText: string): string {
  const n = name.toLowerCase();
  if (/set|string|chars?|character/.test(n)) return variant % 2 ? "xyz" : "abc";
  if (/pattern|regex|expr|search|word/.test(n)) return (sampleText.match(/[a-z]{4,}/g) ?? ["line"])[variant % 2 === 0 ? 0 : 1] ?? "line";
  if (/delim|separator|sep/.test(n)) return variant % 2 ? ":" : ",";
  if (/format|fmt/.test(n)) return "%s";
  if (/field|list|range|col/.test(n)) return variant % 2 ? "1" : "2";
  return variant % 2 ? "3" : "2";
}

/**
 * The caller's options, checked against the documented list before anything runs: each item must
 * be a documented flag (with its argument if it takes one), "--flag=value", "-wVALUE", or bundled
 * documented short flags ("-ab"). Anything else is refused, so no undocumented option reaches the
 * program. Compact short forms are expanded before dispatch, so a target cannot interpret
 * them as a different single-dash long option. Known exclusions take precedence over expansion.
 * Values are argv items; nothing is ever parsed by a shell.
 */
export function validateOptions(value: unknown, allowed: Array<{ flags: string[]; arg: boolean; optionalArg?: boolean }>, excluded: string[] = []): string[] {
  if (value === undefined || value === null || value === "") return [];
  const toks = Array.isArray(value) ? value.map(String) : String(value).trim().split(/\s+/);
  const byFlag = new Map(allowed.flatMap((o) => o.flags.map((f) => [f, o] as const)));
  const denied = new Set(excluded);
  const out: string[] = [];
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (denied.has(t) || denied.has(t.split("=", 1)[0])) throw new Error(`option ${JSON.stringify(t)} is excluded from this capability (HTTP 400 equivalent: nothing was run)`);
    const exact = byFlag.get(t);
    if (exact) {
      out.push(t);
      if (exact.arg) {
        if (i + 1 >= toks.length) throw new Error(`option ${t} needs a value`);
        out.push(toks[++i]);
      }
      continue;
    }
    const eq = /^(--[\w-]+)=(.*)$/.exec(t);
    if (eq && (byFlag.get(eq[1])?.arg || byFlag.get(eq[1])?.optionalArg)) {
      out.push(t);
      continue;
    }
    const attached = /^(-[A-Za-z0-9])(.+)$/.exec(t);
    if (attached) {
      if (byFlag.get(attached[1])?.arg) {
        if (denied.has(attached[1])) throw new Error(`option ${attached[1]} is excluded from this capability (HTTP 400 equivalent: nothing was run)`);
        out.push(attached[1], attached[2]);
        continue;
      }
      if (t.slice(1).split("").every((l) => byFlag.has(`-${l}`) && !byFlag.get(`-${l}`)!.arg && !byFlag.get(`-${l}`)!.optionalArg && !denied.has(`-${l}`))) {
        out.push(...t.slice(1).split("").map(l => `-${l}`));
        continue;
      }
    }
    throw new Error(`option ${JSON.stringify(t)} is not one this program documents; allowed: ${[...byFlag.keys()].slice(0, 60).join(" ")}`);
  }
  return out;
}

/** Documented options that are not offered: they write files, run commands or reach the network. */
const UNOFFERED = /\b(output file|outfile|in[- ]place|overwrite|save[sd]? (it |them |the \w+ )?(to|in|into|as)\b|writes? (it |them |the \w+ |out )?(to|into|in) (?:(?:a|an|the|given|another|specified|named|output)\s+)*(file|files|disk|directory)|delete|remove (the )?files?|execute|exec|shell|run (a |the )?command|spawn|daemon|server|listen|password|command|code execution)\b/i;
/** Network-valued options. Their effect is declared by the capability's own risk, and the
 *  sandbox still decides whether any egress is possible, so they are offered only where the
 *  subcommand itself is not a read. */
const NETWORK_OPTION = /\b(network|connect|socket|url|uri|http|https|api|endpoint|host|remote)\b/i;

const FILE_ARG = /^(file|file ?name|filename|path|input|input ?file)$/i;
const READS_FILE = /\b(input|read|reads|load|loads|source|from|containing|reads? from)\b/i;
const offeredOption = (o: Investigation["options"][number], allowNetwork = false) => {
  if (/^-{1,2}(h|help|V|version|\?)$/.test(o.flags[0]) || UNOFFERED.test(o.description)) return false;
  if (!allowNetwork && NETWORK_OPTION.test(o.description)) return false;
  // A file-valued option is offered only when its documentation says it reads: writing paths
  // stay refused, and a read is confined by the sandbox like any other input.
  if (o.arg && FILE_ARG.test(o.arg)) return READS_FILE.test(o.description);
  return true;
};
function optionContract(options: Investigation["options"], port = "options", allowNetwork = false): { port: string; allowed: Array<{ flags: string[]; arg: boolean; optionalArg?: boolean }>; excluded?: string[] } {
  const offered = options.filter((o) => offeredOption(o, allowNetwork));
  const excluded = [...new Set(options.filter((o) => !offeredOption(o, allowNetwork)).flatMap((o) => o.flags))];
  return { port, allowed: offered.map(o => ({ flags: o.flags.filter(f => !excluded.includes(f)), arg: !!o.arg, ...(o.optionalArg ? { optionalArg: true } : {}) })).filter(o => o.flags.length > 0), excluded };
}

/**
 * Re-run a capability's conformance examples in the sandbox and compare output digests. All match:
 * the program here behaves as it did when the capability was learned.
 */
export async function replayExamples(inv: CliInvoke, sandbox: Sandbox): Promise<{ matched: number; total: number; mismatches: string[]; runs: number }> {
  const crypto = await import("node:crypto");
  const examples = inv.examples ?? [];
  const mismatches: string[] = [];
  let matched = 0;
  for (const [i, ex] of examples.entries()) {
    const argv = [...inv.args.filter((a): a is string => typeof a === "string"), ...(ex.literals ?? []), ...Object.keys(ex.files ?? {})];
    const r = await sandbox.run(inv.bin, argv, { stdin: ex.stdin ?? "", files: ex.files, purpose: "revalidation" });
    const stripped = r.workDir ? r.stdout.split(r.workDir).join("<work>").split(r.workDir.replace(/^\/private/, "")).join("<work>") : r.stdout;
    const out = inv.volatile === "timestamps" ? withoutTimes(stripped) : stripped;
    let applicationError = false;
    try { applicationError = reportsApplicationError(JSON.parse(r.stdout)); } catch {}
    if (!r.limit && !r.timedOut && !r.truncated && inv.okExit.includes(r.code ?? -1) && !applicationError &&
        crypto.createHash("sha256").update(out).digest("hex") === ex.outputSha256) matched++;
    else mismatches.push(`example ${i + 1}: expected ${JSON.stringify(ex.outputPreview.slice(0, 60))}, got ${JSON.stringify(out.slice(0, 60))}`);
  }
  return { matched, total: examples.length, mismatches, runs: examples.length };
}

// ---------------------------------------------------------------- synthetic samples (generic)

interface Sample { kind: string; content: string }

/** Generic sample documents, chosen by words the program's own documentation uses. */
export function samplesFor(docs: string, seed: number): Sample[] {
  const d = docs.toLowerCase();
  const pick = <T,>(xs: T[], i: number) => xs[(seed + i) % xs.length];
  const words = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel", "india", "juliet", "kilo", "lima"];
  const sentence = (i: number) => `${pick(words, i)} ${pick(words, i + 3)} ${pick(words, i + 7)} line ${i + seed % 7}`;
  const out: Sample[] = [];
  const all = /./.test(d); // every generic kind is tried; documentation words only add emphasis
  if (all || /\bx?html\b/.test(d)) {
    for (const v of [0, 4]) {
      out.push({ kind: "html", content: `<html><head><title>${sentence(1 + v)}</title></head><body><h1>${sentence(2 + v)}</h1><p>${sentence(3 + v)}<p>${sentence(4 + v)}<ul><li>${pick(words, 5 + v)}<li>${pick(words, 6 + v)}</ul></body></html>\n` });
      out.push({ kind: "html", content: `<!DOCTYPE html>\n<html>\n<head><title>${sentence(5 + v)}</title></head>\n<body>\n<div><b>${sentence(6 + v)}</div>\n<table><tr><td>${pick(words, 8 + v)}<td>${pick(words, 9 + v)}</table>\n</body>\n</html>\n` });
    }
  }
  // Two distinct unary inputs or two distinct two-file pairs. The investigator
  // already budgets two variants; repeating one document cannot support transfer.
  for (const v of [0, 1, 2, 3]) {
    if (all || /\bxml\b/.test(d)) out.push({ kind: "xml", content: `<?xml version="1.0"?>\n<items><item id="${(seed + 2 * v) % 97}">${sentence(1 + v)}</item><item id="${(seed + 2 * v + 1) % 97}">${sentence(2 + v)}</item></items>\n` });
    if (all || /\bjson\b/.test(d)) out.push({ kind: "json", content: JSON.stringify({ name: pick(words, 1 + v), count: (seed + v) % 50, tags: [pick(words, 2 + v), pick(words, 3 + v)] }) + "\n" });
    if (all || /\bcsv\b|comma.separated/.test(d)) out.push({ kind: "csv", content: `name,count\n${pick(words, 1 + v)},${(seed + v) % 9}\n${pick(words, 2 + v)},${(seed + v + 3) % 9}\n` });
  }
  // A feature-rich text that exercises common behaviours (tabs, repeats, blank lines, case,
  // numbers, runs of spaces), so a program's operative transformation is actually observed.
  out.push({ kind: "text", content: `${pick(words, 2)}\t${seed % 90 + 10}\t${pick(words, 4).toUpperCase()}\n${pick(words, 5)}  ${pick(words, 6)}   end\n\n${pick(words, 2)}\t${seed % 90 + 10}\t${pick(words, 4).toUpperCase()}\nZeta 3\nalpha 21\n` });
  // Plain text, in related pairs that differ in some lines (useful to compare/merge tools).
  for (const v of [0, 11]) {
    const base = Array.from({ length: 6 + (v % 3) }, (_, i) => sentence(i + v));
    const changed = base.map((l, i) => (i === 2 ? `${l} changed` : i === 4 ? sentence(i + 20 + v) : l));
    out.push({ kind: "text", content: base.join("\n") + "\n" });
    out.push({ kind: "text", content: changed.join("\n") + "\n" });
  }
  return out;
}

// ---------------------------------------------------------------- observations

/** JSON output: fields present with the same kind in every observed result become ports (marked observed). */
export function observedFields(outputs: string[]): Port[] {
  const parsed = outputs.map((o) => {
    try {
      return JSON.parse(o);
    } catch {
      return undefined;
    }
  });
  if (parsed.some((p) => p === undefined)) return [];
  const leaves = (v: unknown, prefix: string, depth: number, out: Map<string, unknown>) => {
    if (depth > 3 || !v || typeof v !== "object" || Array.isArray(v)) return;
    for (const [k, x] of Object.entries(v)) {
      const path = prefix ? `${prefix}.${k}` : k;
      if (x && typeof x === "object" && !Array.isArray(x)) leaves(x, path, depth + 1, out);
      else out.set(path, x);
    }
    return out;
  };
  const maps = parsed.map((p) => leaves(p, "", 0, new Map()) ?? new Map());
  const first = maps[0];
  const ports: Port[] = [];
  for (const [path, value] of first) {
    const kinds = maps.map((m) => (m.has(path) ? typeof m.get(path) : "missing"));
    if (kinds.some((k) => k !== kinds[0] || k === "missing")) continue;
    const name = path.split(".").pop()!;
    const type = typeof value === "number" ? "number" : typeof value === "boolean" ? "boolean" : Array.isArray(value) ? "list:json" : inferType(name, { type: "string" });
    ports.push({ name: path, type: type === "id" ? "text" : type, required: true, observed: true });
  }
  return ports.slice(0, 40);
}

const visibleText = (s: string) => s.replace(/<[^>]*>/g, " ").replace(/&[a-z]+;/g, " ").toLowerCase().match(/[a-z0-9]+/g) ?? [];

export function outputKind(stdout: string): CliInvoke["output"] {
  const t = stdout.trim();
  if (/^[{[]/.test(t)) {
    try {
      JSON.parse(t);
      return "json";
    } catch {
      /* not json */
    }
  }
  if (/^<\?xml\b/i.test(t) && !/<html\b/i.test(t)) return "xml";
  if (/<(!doctype html|html|body|head|p|div)\b/i.test(t)) return "html";
  return "text";
}

const SEM: Record<string, SemType> = { html: "html", xml: "text", json: "json", csv: "text", text: "text" };

function slug(s: string) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "run";
}

const OUTPUT_WORDS = /\b(output|print|show|display|format|indent|pretty|quiet|suppress|error|warning|report|count|side|column|wrap|sort|unique|case|upper|lower|number|summary|xml|xhtml|json|clean|strip|compact|width|minimal|verbose|ignore|merge|left|right|common|only)\b/i;

export async function investigateCli(bin: string, sandbox: Sandbox, opts: { seed?: number } = {}): Promise<{ reflection: Reflection | null; investigation: Investigation }> {
  const fs = await import("node:fs");
  const crypto = await import("node:crypto");
  const path = await import("node:path");
  const name = path.basename(bin);
  const seed = opts.seed ?? 7;
  const inv: Investigation = {
    program: { bin, name, sha256: "", size: 0 },
    sandbox: sandbox.kind,
    runs: [],
    options: [],
    operands: { required: [], optional: [], variadic: false },
    claims: [],
    limits: { maxRuns: MAX_RUNS, timeoutMs: 5000, maxOutputBytes: 1_000_000 },
    summary: "",
  };
  const claim = (subject: string, c: string, status: EvidenceStatus, evidence: string) => inv.claims.push({ subject, claim: c, status, evidence });
  if (!fs.existsSync(bin)) {
    inv.summary = `${bin} is not installed`;
    claim(name, "program is present", "contradicted", `no file at ${bin}`);
    return { reflection: null, investigation: inv };
  }
  const bytes = fs.readFileSync(bin);
  inv.program.sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
  inv.program.size = bytes.length;

  let budget = MAX_RUNS;
  const run = async (purpose: string, args: string[], o: { stdin?: string; files?: Record<string, string> } = {}): Promise<SandboxRun | null> => {
    if (budget-- <= 0) return null;
    const raw = await sandbox.run(bin, args, { ...o, purpose: "investigation" });
    // Programs that print their own file names would differ run to run only by the sandbox's
    // private directory; that is not behaviour.
    const strip = (t: string) => (raw.workDir ? t.split(raw.workDir).join("<work>").split(raw.workDir.replace(/^\/private/, "")).join("<work>") : t);
    const r = { ...raw, stdout: strip(raw.stdout), stderr: strip(raw.stderr) };
    inv.runs.push({ id: inv.runs.length + 1, purpose, args, stdinBytes: (o.stdin ?? "").length, files: Object.keys(o.files ?? {}), code: r.code, timedOut: r.timedOut, stdoutBytes: r.stdout.length, stdoutPreview: r.stdout.slice(0, 300), stderrPreview: r.stderr.slice(0, 300), created: r.created, ms: r.durationMs });
    return r;
  };

  // 1. Declared: usage text and manual page.
  let usage = "";
  for (const a of [["--help"], ["-h"], []]) {
    const r = await run("read usage text", a);
    const text = `${r?.stdout ?? ""}\n${r?.stderr ?? ""}`;
    if (r && !r.timedOut && /usage|options?:|synopsis/i.test(text) && text.trim().length > usage.trim().length) usage = text;
    if (usage) break;
  }
  let manual = "";
  // Versioned installs (xsubpp5.34, pg_dump-17, python3.12) file their manual under the base name.
  for (const page of [...new Set([name, name.replace(/[-_.]?\d+(?:\.\d+)*$/, "")])].filter(Boolean)) {
    const m = await sandbox.run("/usr/bin/man", ["-P", "cat", page], { purpose: "investigation" }).catch(() => null);
    if (m && m.code === 0 && m.stdout.trim()) {
      manual = m.stdout.replace(/.\x08/g, "");
      break;
    }
  }
  // Purpose: the manual's NAME line; without a manual, the first prose line of the usage text.
  const prose = usage.split("\n").map((l) => l.trim()).find((l) => l && !/^(usage|options?|synopsis)\b/i.test(l) && !/^-/.test(l) && /[a-z]{3,}\s+[a-z]{3,}/i.test(l));
  inv.program.description = /NAME\s*\n\s*(.+?)\n\s*\n/s.exec(manual)?.[1]?.replace(/\s+/g, " ").trim() ?? (prose ? `${name} - ${prose}` : undefined);
  const version = await run("read version", ["--version"]);
  if (version && version.code === 0 && version.stdout.trim()) inv.program.version = version.stdout.trim().split("\n")[0].slice(0, 120);
  const docs = `${usage}\n${manual}`;
  if (!docs.trim()) {
    claim(name, "documents its usage", "unknown", "no usage text or manual page");
  } else {
    claim(name, "documents its usage", "declared", usage ? "usage text" + (manual ? " and manual page" : "") : "manual page");
  }
  const parsed = parseUsage(docs);
  inv.options = parsed.options;
  // Wrappers that hand their options to another program ("OPTIONs are the same as for 'cmp' or
  // 'diff'", zgrep -> grep): that program's documentation declares them.
  const delegate = /options? (?:are|is) (?:the )?same as (?:for |those of |those for )?[`'"]?([a-z][\w.-]*)[`'"]?(?:\s+or\s+[`'"]?([a-z][\w.-]*)[`'"]?)?/i.exec(docs);
  if (delegate) {
    for (const other of [delegate[2], delegate[1]].filter(Boolean) as string[]) {
      const om = await sandbox.run("/usr/bin/man", ["-P", "cat", other], { purpose: "investigation" }).catch(() => null);
      if (!om || om.code !== 0 || !om.stdout.trim()) continue;
      const seenFlags = new Set(inv.options.flatMap((o) => o.flags));
      const extra = parseUsage(om.stdout.replace(/.\x08/g, "")).options.filter((o) => !o.flags.some((f) => seenFlags.has(f)));
      inv.options.push(...extra.map((o) => ({ ...o, description: `${o.description} (documented by ${other}, to which ${name} passes its options)` })));
      claim(name, `options: ${extra.length} more declared by ${other}'s documentation, which ${name} says it passes them to`, "declared", delegate[0]);
      break;
    }
  }
  const synopsis = [...parsed.synopsis, ...(/SYNOPSIS\s*\n([\s\S]*?)\n\s*\n/.exec(manual)?.[1]?.split("\n").map((l) => l.trim()) ?? [])];
  inv.operands = parseOperands(synopsis, name);
  if (inv.program.description) claim(name, `purpose: ${inv.program.description}`, "declared", "manual page NAME section");
  claim(name, `options: ${inv.options.length} declared`, inv.options.length ? "declared" : "unknown", "usage/manual option lines");
  claim(name, `operands: required [${inv.operands.required.join(", ")}], optional [${inv.operands.optional.join(", ")}]${inv.operands.variadic ? ", variadic" : ""}`, synopsis.length ? "inferred" : "unknown", synopsis.slice(0, 2).join(" | "));

  // 2. Subcommands: a dispatcher declares commands, each with its own options and operands.
  // Discovery is generic: a command section in the help, or a bare list the help points at.
  let subcommands = parseSubcommands(docs);
  if (subcommands.length) {
    claim(name, `commands: ${subcommands.length} declared in a command section`, "declared", subcommands.slice(0, 8).map((s) => s.name).join(", "));
  } else if (/\b(commands?|subcommands?|verbs?)\b/i.test(docs)) {
    for (const probe of [["-l"], ["--list"], ["--list-commands"], ["commands"]]) {
      const r = await run(`list commands with ${probe.join(" ")}`, probe);
      const list = r && !r.timedOut ? parseCommandList(r.stdout, name) : [];
      if (list.length) {
        subcommands = list;
        claim(name, `commands: ${list.length} listed by "${name} ${probe.join(" ")}"`, "declared", list.slice(0, 8).map((s) => s.name).join(", "));
        break;
      }
    }
  }
  if (subcommands.length) {
    // Group-level flags are sometimes documented apart from the command list. A program
    // that says "help topics" documents where; follow only the flags/options topic it names.
    if (inv.options.filter((o) => offeredOption(o)).length < 2 && /\bhelp topics\b/i.test(docs)) {
      const topicsRun = await run("read help topics", ["help", "topics"]);
      const topics = topicsRun && !topicsRun.timedOut ? parseHelpTopics(`${topicsRun.stdout}\n${topicsRun.stderr}`) : [];
      const topic = topics.find((t) => /^(flags?|options?)$/i.test(t));
      if (topic) {
        const flagRun = await run(`read ${topic} documentation`, ["help", topic]);
        if (flagRun && flagRun.code === 0 && /-{1,2}[A-Za-z]/.test(flagRun.stdout)) {
          const merged = mergeOptions(inv.options, parseUsage(flagRun.stdout).options.map((o) => ({ ...o, description: `${o.description} (documented by ${name} help ${topic})` })));
          inv.options = merged.options;
          claim(name, `global options: ${merged.added} documented by "${name} help ${topic}"`, "declared", `${merged.added} option lines with descriptions`);
        }
      }
    }
    const subProvider = `cli:${slug(name)}`;
    const jsonByDefault = inv.options.some((o) => o.flags.includes("--json") && /\bdefault\b/i.test(o.description));
    const optionList = (xs: Investigation["options"]) => xs.slice(0, 40).map((o) => `${o.flags.join("/")}${o.arg ? ` <${o.arg}>` : o.optionalArg ? `[=${o.optionalArg}]` : ""}`).join(", ");
    const caps: Capability[] = [];
    for (const sub of subcommands.slice(0, MAX_VERBS)) {
      if (!/^[a-z][a-z0-9._-]*$/.test(sub.name)) continue;
      let verbText = "";
      let verbSource = "";
      for (const args of [[sub.name, "--help"], [sub.name, "-h"], ["help", sub.name]]) {
        const r = await run(`read ${sub.name} usage`, args);
        const text = `${r?.stdout ?? ""}\n${r?.stderr ?? ""}`;
        if (r && !r.timedOut && r.code === 0 && /usage|options?/i.test(text) && text.trim().length > verbText.trim().length) {
          verbText = text;
          verbSource = `${name} ${args.join(" ")}`;
        }
        if (verbText) break;
      }
      const id = `${subProvider}:${slug(sub.name)}`;
      if (!verbText.trim()) {
        claim(id, `subcommand "${sub.name}" documents its usage`, "unknown", `no help from "${name} ${sub.name} --help", "${name} ${sub.name} -h" or "${name} help ${sub.name}"`);
        continue;
      }
      const vp = parseUsage(verbText);
      const subProse = verbText.split("\n").map((l) => l.trim()).find((l) => l && !/^(usage|options?|synopsis|examples?|commands?|flags?)\b/i.test(l) && !/^-/.test(l) && /[a-z]{3,}/i.test(l));
      const description = sub.description || subProse || inv.program.description || name;
      const risk = commandRisk(sub.name, `${sub.description} ${subProse ?? ""}`);
      // A subcommand that is not itself a read may declare the network option it exists to use.
      // A read subcommand keeps network-valued options refused.
      const globalContract = optionContract(inv.options, "global_options", risk !== "read");
      const globalOffered = inv.options.filter((o) => offeredOption(o, risk !== "read"));
      const local = optionContract(vp.options, "options", risk !== "read");
      const offered = vp.options.filter((o) => offeredOption(o, risk !== "read"));
      const usesStdin = /\b(stdin|standard input)\b/i.test(`${docs}\n${verbText}`);
      const required = offered.filter((o) => /\brequired\b/i.test(o.description)).map((o) => o.flags.join("/"));
      const inputs: Port[] = [];
      if (globalContract.allowed.length) inputs.push({ name: "global_options", type: "list:text", required: false, description: `Options placed before the subcommand (${globalContract.allowed.length} documented): ${optionList(globalOffered)}` });
      if (local.allowed.length) inputs.push({ name: "options", type: "list:text", required: false, description: `Options placed after "${sub.name}" (${local.allowed.length} documented): ${optionList(offered)}${required.length ? `. Required: ${required.join(", ")}` : ""}` });
      if (usesStdin) inputs.push({ name: "input", type: "text", required: false, anyText: true, description: "Content given on standard input" });
      inputs.push(
        { name: "files", type: "json", required: false, description: 'Named input files {"name.ext": "content"}: staged with exact flat names (no paths or leading dash). Options can refer to these names.' },
        { name: "operands", type: "list:text", required: false, description: 'Names from "files" to append as positional operands, in this order. Pass [] when the subcommand takes no file operands.' },
      );
      const cap: Capability = {
        id,
        title: `${name} ${sub.name}${sub.description ? `: ${sub.description}` : subProse ? `: ${subProse.replace(/\.$/, "")}` : ""}`.slice(0, 200),
        description: `${inv.program.description ?? name}. Subcommand "${sub.name}": ${description.replace(/\.$/, "")}. Runs the documented subcommand; options outside the declared lists are refused.${required.length ? ` Required options: ${required.join(", ")}.` : ""}${usesStdin ? ' Content may be given on standard input ("input").' : ""} Files are staged by exact name; pass "operands" to select which are appended ([] for none). Runs only in the sandbox.`.slice(0, 600),
        provider: subProvider,
        source: "cli",
        inputs,
        outputs: [{ name: "", type: jsonByDefault ? "json" : "text", required: true }],
        risk,
        tags: [name, sub.name, "declared-interface", "declared-only", "direct-only", ...(risk === "read" ? [] : [risk])].slice(0, 32),
        invoke: {
          kind: "cli",
          bin,
          args: [sub.name],
          ...(globalContract.allowed.length ? { options: globalContract } : {}),
          ...(local.allowed.length ? { optionsAfterArgs: local } : {}),
          ...(usesStdin ? { stdin: "input" } : {}),
          filesPort: "files",
          operandsPort: "operands",
          okExit: [0],
          output: jsonByDefault ? "json" : "text",
          sha256: inv.program.sha256,
        },
      };
      caps.push(cap);
      claim(id, `subcommand "${sub.name}" documents ${vp.options.length} option(s)${required.length ? `, ${required.length} required` : ""}`, "declared", verbSource);
    }
    if (caps.length) {
      inv.summary = `${caps.length} subcommand capabilit${caps.length === 1 ? "y" : "ies"} from ${inv.runs.length} sandboxed runs (${subcommands.length} commands discovered)`;
      return {
        reflection: {
          provider: {
            id: subProvider,
            title: `${name} (command-line program with subcommands)`,
            source: "cli",
            origin: bin,
            learnedAt: new Date().toISOString(),
            capabilityIds: caps.map((c) => c.id),
            meta: { investigation: inv, sha256: inv.program.sha256, version: inv.program.version },
          },
          capabilities: caps,
        },
        investigation: inv,
      };
    }
  }

  // 3. Experiments with synthetic inputs (never the evaluator's inputs).
  const samples = samplesFor(docs, seed);
  const kinds = [...new Set(samples.map((s) => s.kind))];
  // Literal operands (values, not files) are supplied as argv text; only the rest are file operands.
  const optionArgs = new Set(inv.options.map((o) => (o.arg ?? "").toLowerCase().replace(/[^a-z0-9]/g, "")).filter(Boolean));
  const literalNames = inv.operands.required.filter((n) => isLiteralOperand(n) && !optionArgs.has(n.toLowerCase().replace(/[^a-z0-9]/g, "")));
  const required = inv.operands.required.length - literalNames.length;
  // Operand parsing is the least reliable step: standard input is always tried as well.
  const channels: Array<{ id: string; arity: number }> = required >= 2 ? [{ id: "files", arity: required }, { id: "stdin", arity: 1 }] : [{ id: "stdin", arity: 1 }, { id: "files", arity: Math.max(1, required) }];
  // Numbered file operands ("FILE1 [FILE2]"): a comparison wants two files even when the second is optional.
  if (required < 2 && [...inv.operands.required, ...inv.operands.optional].some((n) => /2$/.test(n) && !isLiteralOperand(n))) channels.push({ id: "files", arity: 2 });

  interface Trial { mode: string; flags: string[]; channel: string; kind: string; inputs: string[]; literals: string[]; args: string[]; r: SandboxRun }
  const trials: Trial[] = [];
  // variant selects a different sample (or a different pair of samples for two-operand programs).
  const attempt = async (mode: string, flags: string[], channel: { id: string; arity: number }, kind: string, variant = 0): Promise<Trial | null> => {
    const pool = samples.filter((s) => s.kind === kind);
    const pairs = Math.max(1, Math.floor(pool.length / 2));
    const texts = channel.arity === 2
      ? pool.length >= 2 ? [pool[(variant % pairs) * 2].content, pool[(variant % pairs) * 2 + 1].content] : [pool[0]?.content, samples.find((s) => s.kind === "text")?.content]
      : [pool[variant % pool.length]?.content];
    if (texts.some((t) => !t)) return null;
    const files = channel.id === "files" ? Object.fromEntries(texts.map((t, i) => [`input${i + 1}.${kind === "text" ? "txt" : kind}`, t!])) : undefined;
    const literals = literalNames.map((n) => literalSample(n, variant, texts[0] ?? ""));
    const args = [...flags, ...literals, ...(files ? Object.keys(files) : [])];
    const r = await run(`mode ${mode}: ${kind} via ${channel.id}${literals.length ? ` with ${literals.join(" ")}` : ""}`, args, { stdin: channel.id === "stdin" ? texts[0] : undefined, files });
    if (!r) return null;
    const t = { mode, flags, channel: channel.id, kind, inputs: texts as string[], literals, args, r };
    trials.push(t);
    return t;
  };
  // Output that is the program's usage or help text is an error report, not a result.
  const usageLike = (out: string) => {
    const o = out.trim();
    if (!o) return false;
    if (usage.trim() && (o === usage.trim() || usage.includes(o.split("\n")[0].trim()) && /usage/i.test(o.split("\n")[0]))) return true;
    if (/^\s*usage:/i.test(o)) return true;
    // A program asking for input it cannot get ("Enter a user name:", "Password:") wants a terminal.
    return /^(enter|please enter|password|pass-?phrase|username|login)\b[^\n]*:\s*$/im.test(o);
  };
  // A failure exit whose output shares nothing with the input's content is an error report (a
  // program saying "not a zipfile"), not a result. Diff-like programs exit 1 yet echo their input.
  const errorReport = (t: Trial) => {
    if ((t.r.code ?? 0) === 0) return false;
    const want = new Set(t.inputs.flatMap(visibleText).filter((w) => w.length >= 3));
    if (!want.size) return false;
    const got = new Set(visibleText(t.r.stdout));
    return [...want].filter((w) => got.has(w)).length < want.size / 2;
  };
  const works = (t: Trial | null) => !!t && !t.r.timedOut && !t.r.truncated && t.r.stdout.trim().length > 0 && !usageLike(t.r.stdout) && !errorReport(t);

  // Default mode on every channel and kind; keep the channels that work.
  const okChannels: Array<{ id: string; arity: number }> = [];
  const tryChannels = async () => {
    for (const ch of channels) {
      let ok = false;
      for (const k of kinds) for (const v of [0, 1]) if (works(await attempt("default", [], ch, k, v))) ok = true;
      if (ok && !okChannels.includes(ch)) okChannels.push(ch);
    }
  };
  await tryChannels();
  // Nothing worked without them: supply an optional literal operand too ("[PATTERN] [FILE...]").
  if (!okChannels.length) {
    const optionalLiterals = inv.operands.optional.filter((n) => isLiteralOperand(n) && !optionArgs.has(n.toLowerCase().replace(/[^a-z0-9]/g, "")) && !literalNames.includes(n));
    if (optionalLiterals.length) {
      literalNames.push(optionalLiterals[0]);
      claim(name, `needs the optional operand "${optionalLiterals[0]}" to produce output`, "observed", "no channel worked without it");
      await tryChannels();
    }
  }
  const best = okChannels[0];
  if (!best) {
    // Say why, when the program said why: a missing configuration, file, device or privilege is an
    // environmental precondition, not a capability that failed.
    //
    // A line naming a path RCX staged itself does not count. An interpreter handed a generic data
    // sample reports "can't open file <work>/input1.txt": that says the sample was not a program,
    // not that something is missing from the environment. Misreading it also hides the program,
    // because the declared interface below is offered only when nothing environmental is wrong.
    const supplied = new Set(trials.flatMap((t) => t.args));
    const ownOperand = (line: string) => [...supplied].some((a) => a && line.includes(`<work>/${a}`));
    const reasons = trials.map((t) => t.r.stderr.split("\n").find((l) => !ownOperand(l) && /no such file|not found|cannot open|can't open|configuration|config file|permission denied|not permitted|must be (run as )?root|requires? root|not supported|no .*configured|unable to/i.test(l))).filter(Boolean) as string[];
    const precondition = reasons.length >= Math.max(2, trials.length / 2) ? reasons[0].trim().slice(0, 160) : undefined;
    inv.summary = precondition ? `not investigable here: ${name} reports a missing precondition ("${precondition}") on every input tried (${trials.length} trials)` : `no input channel produced output for ${name} (${trials.length} trials)`;
    claim(name, "produces output for supplied input", trials.length ? "contradicted" : "unknown", inv.summary);
    // Generic inputs cannot exercise every program (a decoder needs encoded input). If the program
    // documents options, it is still offered, clearly as a declared interface: behaviour not
    // observed, never composed automatically, no fingerprint (so never imported elsewhere).
    const declared = inv.options.filter((o) => offeredOption(o));
    if (!precondition && declared.length && docs.trim()) {
      const providerId = `cli:${slug(name)}`;
      const id = `${providerId}:invoke`;
      claim(id, "behaviour not observed: declared by the documentation only", "declared", inv.summary);
      const cap: Capability = {
        id,
        title: `${name} with documented options (declared only, behaviour not observed): ${(inv.program.description ?? name).replace(/^[^-–]+[-–]\s*/, "")}`,
        description: `${inv.program.description ?? name}. No experiment with generic inputs produced output (${inv.summary}), so its behaviour is declared by its documentation only. Pass content on standard input ("input") or as named files ("files"), and documented options ("options"); undocumented options are refused. Runs only in the sandbox.`.slice(0, 500),
        provider: providerId,
        source: "cli",
        inputs: [
          { name: "input", type: "text", required: false, anyText: true, description: "Content given on standard input" },
          { name: "options", type: "list:text", required: false, description: `Documented options and their values, one item each: ${declared.slice(0, 40).map((o) => `${o.flags.join("/")}${o.arg ? ` <${o.arg}>` : o.optionalArg ? `[=${o.optionalArg}]` : ""}`).join(", ")}` },
          { name: "files", type: "json", required: false, description: 'Named input files {"name.ext": "content"}: staged with exact flat names (no paths or leading dash). Options can refer to these names. All are operands unless "operands" selects otherwise.' },
          { name: "operands", type: "list:text", required: false, description: 'Names from "files" to append as positional operands, in this order. Omit for all files; [] for none. Auxiliary files used by options need not also be operands.' },
        ],
        outputs: [{ name: "", type: "text", required: true }],
        risk: "read",
        tags: [name, "declared-interface", "declared-only", "direct-only", "unsupported"],
        invoke: { kind: "cli", bin, args: [], stdin: "input", okExit: [0, 1], output: "text", sha256: inv.program.sha256, options: optionContract(inv.options), filesPort: "files", operandsPort: "operands" },
      };
      inv.summary += `; offered as a declared interface only (${declared.length} documented options)`;
      return { reflection: { provider: { id: providerId, title: `${name} (command-line program)`, source: "cli", origin: bin, learnedAt: new Date().toISOString(), capabilityIds: [id], meta: { investigation: inv, sha256: inv.program.sha256, version: inv.program.version } }, capabilities: [cap] }, investigation: inv };
    }
    return { reflection: null, investigation: inv };
  }
  // Modes: flags without arguments whose own description is about the output.
  const candidates = inv.options.filter((o) => !o.arg && !o.flags.some((f) => /^-{1,2}(h|help|V|version|\?|usage)$/.test(f)) && OUTPUT_WORDS.test(o.description) && !/version|help|usage|modify|in.place|write|output file|outfile|overwrite|save/i.test(o.description)).slice(0, 8);
  const defaultWorks = (k: string) => trials.some((t) => t.mode === "default" && t.channel === best.id && t.kind === k && works(t));
  // Options are probed with plain text when the program takes it: the most general kind.
  const primaryKind = (defaultWorks("text") ? "text" : kinds.find(defaultWorks)) ?? kinds[0];
  // The channel took several kinds of text (plain, markup, JSON, CSV): every mode reads any text.
  const channelAnyText = defaultWorks("text") && kinds.filter(defaultWorks).length >= 2;
  for (const o of candidates) {
    const flag = o.flags[o.flags.length - 1];
    if (works(await attempt(flag.replace(/^-+/, ""), [flag], best, primaryKind, 0))) await attempt(flag.replace(/^-+/, ""), [flag], best, primaryKind, 1);
  }

  // Failure behaviour: empty input.
  const empty = await run("probe empty input", best.id === "files" ? Array.from({ length: best.arity }, (_, i) => `empty${i + 1}.txt`) : [], best.id === "files" ? { files: Object.fromEntries(Array.from({ length: best.arity }, (_, i) => [`empty${i + 1}.txt`, ""])) } : { stdin: "" });

  // 3. Behaviours: group working trials by mode; keep modes whose output differs from default.
  const okExit = [...new Set(trials.filter(works).map((t) => t.r.code ?? -1))].sort();
  const trialInput = (t: Trial) => JSON.stringify([t.channel, t.kind, t.literals, t.inputs]);
  const defaultOutputs = new Map(trials.filter(t => t.mode === "default" && works(t)).map(t => [trialInput(t), t.r.stdout]));
  const modes = [...new Set(trials.map((t) => t.mode))];
  const capabilities: Capability[] = [];
  const providerId = `cli:${slug(name)}`;
  for (const mode of modes) {
    const mt = trials.filter((t) => t.mode === mode && t.channel === best.id && works(t));
    if (!mt.length) {
      if (mode !== "default") claim(`${providerId}:${slug(mode)}`, `option ${trials.find((t) => t.mode === mode)?.flags.join(" ")} produces output`, "contradicted", "ran with a valid sample; no output");
      continue;
    }
    // Compare the option and default on the same data; different inputs can
    // legitimately yield different outputs without the flag having any effect.
    if (mode !== "default" && mt.every((t) => t.r.stdout === defaultOutputs.get(trialInput(t)))) {
      claim(`${providerId}:${slug(mode)}`, `option ${mt[0].flags.join(" ")} changes the output`, "contradicted", "output identical to the default mode");
      // The option is equivalent to the default: its description still describes what the default
      // does, so keep it there (otherwise the only account of the behaviour is lost).
      const opt = inv.options.find((o) => o.flags.some((f) => f.replace(/^-+/, "") === mode));
      const def = capabilities.find((c) => c.id === `${providerId}:default`);
      if (opt && def) {
        def.tags = [...new Set([...def.tags, ...(opt.description.toLowerCase().match(/[a-z]{3,}/g) ?? [])])].slice(0, 40);
        def.description = `${def.description} Equivalent to ${mt[0].flags.join(" ")}: ${opt.description}`.slice(0, 400);
        claim(def.id, `equivalent to ${mt[0].flags.join(" ")} (${opt.description})`, "experimentally-supported", "identical output for the same inputs");
      }
      continue;
    }
    // Determinism: repeat the first working trial.
    // Output that ignores the input is not a transformation of it (a program printing its
    // configuration, or an error, for anything it is given).
    // Recorded, not dropped: a predicate (valid/invalid) can legitimately give one answer for every
    // sample. Usage and error text are already excluded above.
    const distinctInputs = new Set(mt.map((t) => [...t.literals, ...t.inputs].join("\u0000"))).size;
    const constant = distinctInputs >= 2 && new Set(mt.map((t) => t.r.stdout)).size === 1;
    const first = mt[0];
    const again = await run(`repeat for determinism (${mode})`, [...first.flags, ...first.literals, ...(first.channel === "files" ? first.inputs.map((_, i) => `input${i + 1}.${first.kind === "text" ? "txt" : first.kind}`) : [])], first.channel === "stdin" ? { stdin: first.inputs[0] } : { files: Object.fromEntries(first.inputs.map((t, i) => [`input${i + 1}.${first.kind === "text" ? "txt" : first.kind}`, t])) });
    // Identical runs that differ only by date-times (file timestamps) are deterministic apart from
    // those values: they are normalised in this mode's fingerprint and examples, nowhere else.
    const volatileTimes = !!again && again.stdout !== first.r.stdout && withoutTimes(again.stdout) === withoutTimes(first.r.stdout);
    const deterministic = !!again && (again.stdout === first.r.stdout || volatileTimes);
    const fp = (s: string) => (volatileTimes ? withoutTimes(s) : s);
    const outKinds = [...new Set(mt.map((t) => outputKind(t.r.stdout)))];
    const out = outKinds.length === 1 ? outKinds[0] : "text";
    const id = `${providerId}:${slug(mode)}`;
    const inKinds = [...new Set(mt.map((t) => t.kind))];
    const inType: SemType = inKinds.length === 1 ? SEM[inKinds[0]] ?? "text" : "text";
    // Relations between input and output, computed generically.
    const preserves = mt.every((t) => {
      const want = new Set(t.inputs.flatMap(visibleText));
      const got = new Set(visibleText(t.r.stdout));
      return [...want].every((w) => got.has(w));
    });
    const echoes = mt.every((t) => t.r.stdout.trim() === t.inputs[0].trim());
    const option = inv.options.find((o) => o.flags.some((f) => f.replace(/^-+/, "") === mode));
    const portNames = best.id === "stdin" ? [inType === "html" ? "html" : inType === "json" ? "json" : "input"] : Array.from({ length: best.arity }, (_, i) => {
      // Required file operands first, then numbered optional ones ("FILE1 [FILE2]"), then file1, file2...
      const fileOps = [...inv.operands.required.filter((n) => !literalNames.includes(n)), ...inv.operands.optional.filter((n) => /\d$/.test(n) && !isLiteralOperand(n))];
      const n = fileOps[i];
      return n && /^[a-z][\w]*$/i.test(n) ? n : `file${i + 1}`;
    });
    // Several kinds of text worked (plain, markup, JSON, CSV): the input takes any text.
    const anyText = channelAnyText || (inKinds.length >= 2 && inKinds.includes("text"));
    // Typed by what the program says it is for (its documentation names one kind that worked, e.g.
    // HTML), still taking other text where experiments showed it does.
    // Only the stated purpose counts, and not output-format phrasing ("print ... as JSON").
    const purpose = inv.program.description ?? "";
    const documented = ["html", "xml", "json", "csv"].filter((k) => {
      const kw = k === "html" ? "x?html" : k;
      return new RegExp(`\\b${kw}\\b`, "i").test(purpose) && !new RegExp(`\\b(as|to|into|in)\\s+${kw}\\b`, "i").test(purpose) && defaultWorks(k);
    });
    const portType: SemType = documented.length === 1 && SEM[documented[0]] !== "text" ? SEM[documented[0]] : anyText ? "text" : inType;
    const names = best.id === "stdin" ? [portType === "html" ? "html" : portType === "json" ? "json" : "input"] : portNames;
    const literalPort = (n: string) => (/^[a-z][\w]*$/i.test(n) ? n : `value${literalNames.indexOf(n) + 1}`);
    const inputs: Port[] = [
      ...literalNames.map((n): Port => ({ name: literalPort(n), type: "text", required: true, description: `Literal operand "${n}" (passed as an argument, not as file content); experiments used e.g. ${JSON.stringify(mt[0]?.literals[literalNames.indexOf(n)] ?? "")}` })),
      ...names.map((n): Port => ({ name: n, type: portType, required: true, ...(anyText ? { anyText: true } : {}), description: (best.id === "stdin" ? "Content given on standard input" : "Content passed as a file operand") + ". Supply text to preserve its bytes; objects and arrays are serialized as JSON." })),
    ];
    const behaviour = crypto
      .createHash("sha256")
      .update(JSON.stringify(mt.map((t) => [[...t.literals, ...t.inputs].join("\u0000"), fp(t.r.stdout)]).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))))
      .digest("hex")
      .slice(0, 16);
    const invoke: CliInvoke = {
      kind: "cli",
      bin,
      args: [...first.flags, ...literalNames.map((n) => ({ input: literalPort(n), literal: true })), ...(best.id === "files" ? portNames.map((n) => ({ input: n })) : [])],
      ...(best.id === "stdin" ? { stdin: names[0] } : {}),
      // Exit 0 is success by convention; other codes count only where observed with real output
      // (diff-like programs exit 1 when inputs differ).
      okExit: [...new Set([0, ...mt.map((t) => t.r.code ?? -1)])].sort(),
      output: out,
      sha256: inv.program.sha256,
      behaviour,
      ...(volatileTimes ? { volatile: "timestamps" as const } : {}),
      examples: mt.slice(0, 2).map((t) => ({
        ...(t.channel === "stdin" ? { stdin: t.inputs[0] } : { files: Object.fromEntries(t.inputs.map((x, i) => [`input${i + 1}.${t.kind === "text" ? "txt" : t.kind}`, x])) }),
        ...(t.literals.length ? { literals: t.literals } : {}),
        outputSha256: crypto.createHash("sha256").update(fp(t.r.stdout)).digest("hex"),
        outputPreview: t.r.stdout.slice(0, 160),
      })),
    };
    const what = option ? option.description.replace(/\.$/, "") : inv.program.description?.replace(/^[^-–]+[-–]\s*/, "") ?? `run ${name}`;
    const supported = mt.length >= 2 && deterministic && new Set(mt.map((t) => [...t.literals, ...t.inputs].join("\u0000"))).size >= 2;
    capabilities.push({
      id,
      title: `${name}${mode === "default" ? "" : ` ${mt[0].flags.join(" ")}`}: ${what}`,
      description: `${inv.program.description ?? name}. ${mode === "default" ? "Default behaviour" : `With ${mt[0].flags.join(" ")}: ${option?.description ?? ""}`}. Learned by sandboxed investigation of ${bin} (sha256 ${inv.program.sha256.slice(0, 12)}), not from a contract; runs only in the sandbox.`.slice(0, 400),
      provider: providerId,
      source: "cli",
      inputs,
      outputs: [{ name: "", type: SEM[out] ?? "text", required: true }, ...(out === "json" ? observedFields(mt.map((t) => t.r.stdout)) : [])],
      risk: "read",
      tags: [name, ...(inv.program.description ?? "").toLowerCase().match(/[a-z]{3,}/g) ?? [], ...(option ? option.description.toLowerCase().match(/[a-z]{3,}/g) ?? [] : [])].slice(0, 30),
      invoke,
    });
    claim(id, `accepts ${inKinds.join("/")} input via ${best.id} and prints ${out}`, supported ? "experimentally-supported" : "observed", `${mt.length} run(s) across ${distinctInputs} distinct input(s); exit ${invoke.okExit.join("/")}`);
    claim(id, volatileTimes ? "deterministic for identical input, apart from date-time values (e.g. file timestamps)" : "deterministic for identical input", again ? (deterministic ? "experimentally-supported" : "contradicted") : "unknown", again ? (volatileTimes ? "repeated run identical once date-times are normalised" : "repeated run compared byte for byte") : "no budget for a repeat");
    if (preserves) claim(id, "output keeps every word of the input", supported ? "experimentally-supported" : "observed", "word sets compared");
    if (echoes) claim(id, "output equals the input (no transformation)", "observed", "byte comparison");
    if (mt.some((t) => t.r.created.length)) claim(id, `creates files: ${[...new Set(mt.flatMap((t) => t.r.created))].join(", ")}`, "observed", "contained in the sandbox's temporary directory");
    claim(id, "side effects outside the sandbox", "unknown", "the sandbox prevents them; not observable");
    if (!deterministic) (capabilities[capabilities.length - 1].tags as string[]).push("nondeterministic");
    // Behaviour only observed, never supported by distinct repeatable inputs: available to call
    // directly with its evidence, but not chosen by automatic composition.
    if (!supported) (capabilities[capabilities.length - 1].tags as string[]).push("unsupported");
    // Values the caller must choose (patterns, sets, numbers): callable directly, not composed automatically.
    if (literalNames.length) (capabilities[capabilities.length - 1].tags as string[]).push("direct-only");
    // Evidence that this mode keeps every word of its input (an outcome contract invariant).
    if (preserves && supported && !echoes) (capabilities[capabilities.length - 1].tags as string[]).push("preserves-input-words");
    if (constant) {
      claim(id, "output did not vary across the distinct inputs tried", "observed", `${distinctInputs} distinct inputs gave identical output`);
      (capabilities[capabilities.length - 1].tags as string[]).push("input-independent-in-samples", "unsupported");
    }
  }
  // The documented-options interface: the program run with options its documentation declares,
  // chosen by a caller who knows what it needs (an agent asking for "wrap at 20 columns").
  // Each option's effect is declared, and tested here where the budget allows.
  const offered = inv.options.filter((o) => offeredOption(o));
  const base = capabilities.find((c) => c.id === `${providerId}:default`) ?? capabilities[0];
  if (offered.length && base && base.invoke.kind === "cli") {
    const id = `${providerId}:invoke`;
    const baseOut = trials.find((t) => t.mode === "default" && t.channel === best.id && t.kind === primaryKind && works(t));
    for (const o of offered.filter((x) => x.arg).slice(0, 6)) {
      if (!baseOut) break;
      const flag = o.flags[o.flags.length - 1];
      const value = literalSample(o.arg!, 0, baseOut.inputs[0] ?? "");
      const t = await attempt(`option ${flag}`, [flag, value], best, primaryKind, 0);
      if (!t) break;
      const changed = works(t) && t.r.stdout !== baseOut.r.stdout;
      claim(id, `option ${flag} ${o.arg} (${o.description.slice(0, 80)}) changes the output (tried ${flag} ${value})`, changed ? "observed" : works(t) ? "contradicted" : "unknown", changed ? "output differs from the default for the same input" : works(t) ? "same output as the default" : "the run produced no usable output");
    }
    const inv0 = base.invoke as CliInvoke;
    capabilities.push({
      id,
      title: `${name} with documented options: ${(inv.program.description ?? name).replace(/^[^-–]+[-–]\s*/, "")}`,
      description: `${inv.program.description ?? name}. Runs the program with options chosen by the caller from the ${offered.length} its documentation declares (pass them in "options", e.g. ["${offered[0].flags[0]}"${offered[0].arg ? `, "<${offered[0].arg}>"` : ""}]); undocumented options are refused. Option effects are declared by the documentation; see the card's evidence for those tested. Runs only in the sandbox.`.slice(0, 500),
      provider: providerId,
      source: "cli",
      inputs: [
        ...base.inputs.map((p0) => ({ ...p0, required: false })),
        { name: "options", type: "list:text", required: false, description: `Documented options and their values, one item each: ${offered.slice(0, 40).map((o) => `${o.flags.join("/")}${o.arg ? ` <${o.arg}>` : o.optionalArg ? `[=${o.optionalArg}]` : ""}`).join(", ")}` },
        { name: "files", type: "json", required: false, description: 'Named input files {"name.txt": "content"}: staged with exact flat names (no paths or leading dash). Options can refer to these names. All are operands unless "operands" selects otherwise.' },
        { name: "operands", type: "list:text", required: false, description: 'Names from "files" to append as positional operands, in this order. Omit for all files; [] for none. Auxiliary files used by options need not also be operands.' },
      ],
      outputs: base.outputs,
      risk: "read",
      // Evidence about the program's default behaviour holds for this interface too.
      tags: [name, "declared-interface", "direct-only", ...base.tags.filter((t) => /^(nondeterministic|unsupported|input-independent-in-samples)$/.test(t)), ...(inv.program.description ?? "").toLowerCase().match(/[a-z]{3,}/g) ?? []].slice(0, 32),
      invoke: { ...inv0, behaviour: inv0.behaviour ? `${inv0.behaviour}+options` : undefined, options: optionContract(inv.options), filesPort: "files", operandsPort: "operands" },
    });
    claim(id, `offers ${offered.length} documented options; refuses any other`, "declared", `${inv.options.length - offered.length} documented options not offered (help/version, or they write files, run commands or use the network)`);
  }
  // A representation option, discovered generically: exact stdout remains available when JSON
  // cannot be represented as JavaScript values (large numbers, duplicate keys), or bytes matter.
  const jsonSource = [...capabilities].reverse().find(c => c.invoke.kind === "cli" && c.invoke.output === "json");
  if (jsonSource && jsonSource.invoke.kind === "cli") {
    const id = `${providerId}:stdout`;
    capabilities.push({ ...jsonSource, id,
      title: `${name}: exact standard output text`,
      description: `Same authorised invocation as ${jsonSource.id}, preserving standard output exactly as text. Use for exact formatting, large numbers or duplicate object keys. No JSON value conversion or inferred field projection.`,
      outputs: [{ name: "", type: "text", required: true }],
      tags: [...jsonSource.tags, "exact-stdout", "json-text"],
      invoke: { ...jsonSource.invoke, output: "text", behaviour: jsonSource.invoke.behaviour ? `${jsonSource.invoke.behaviour}+stdout` : undefined },
    });
    claim(id, "returns exact standard output without JSON value conversion", "declared", "runtime representation; same program, arguments, sandbox and authority checks");
  }
  if (empty) claim(name, `on empty input exits ${empty.code}${empty.stdout.trim() ? " with output" : " without output"}`, "observed", empty.stderr.slice(0, 120));
  inv.summary = `${capabilities.length} capabilit${capabilities.length === 1 ? "y" : "ies"} from ${inv.runs.length} sandboxed runs (${okChannels.map((c) => c.id).join(", ")}; ok exit ${okExit.join("/")})`;
  if (!capabilities.length) return { reflection: null, investigation: inv };
  return {
    reflection: {
      provider: {
        id: providerId,
        title: `${name} (command-line program)`,
        source: "cli",
        origin: bin,
        learnedAt: new Date().toISOString(),
        capabilityIds: capabilities.map((c) => c.id),
        meta: { investigation: inv, sha256: inv.program.sha256, version: inv.program.version },
      },
      capabilities,
    },
    investigation: inv,
  };
}
