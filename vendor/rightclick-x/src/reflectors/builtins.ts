// Built-in capabilities: portable, dependency-free transforms that act as the
// graph's connective tissue. They are what let a GraphQL result feed an MCP
// tool feed a web form: html -> text, url -> domain, text -> language, ...

import type { Capability, Port, Reflection, SemType } from "../core/types.ts";
import { convertMoney, MONEY_CURRENCIES, moneyType } from "../core/quantities.ts";
import { readBody, request, type Net } from "./net.ts";

export type BuiltinFn = (args: Record<string, any>, net: Net) => Promise<unknown> | unknown;

interface Def {
  fn: string;
  title: string;
  description: string;
  inputs: Array<[string, SemType, boolean?]>;
  outputs: Array<[string, SemType]>;
  tags: string[];
  risk?: Capability["risk"];
  run: BuiltinFn;
}

const p = (name: string, type: SemType, required = true): Port => ({ name, type, required });

const DEFS: Def[] = [
  ...MONEY_CURRENCIES.flatMap((currency): Def[] => (["minor", "major"] as const).map((from): Def => {
    const to = from === "minor" ? "major" : "minor";
    return {
      fn: `quantity.money.${currency.code.toLowerCase()}.${from}-to-${to}`,
      title: `Convert ${currency.code} ${from} units to ${to} units`,
      description: `Convert ${currency.label} without changing currency. Major to minor units rounds half away from zero; minor units must be integers.`,
      inputs: [["amount", moneyType(currency.code, from)]],
      outputs: [["", moneyType(currency.code, to)]],
      tags: ["quantity", "money", "convert", currency.code],
      run: ({ amount }) => convertMoney(amount, currency.code, from, to),
    };
  })),
  {
    fn: "web.fetch",
    title: "Fetch web page",
    description: "Download a URL and return its body (HTML or text).",
    inputs: [["url", "url"]],
    outputs: [["", "html"]],
    tags: ["web", "http", "download", "page", "read"],
    risk: "external",
    run: async ({ url }, net) => {
      const res = await request(net, url, { headers: { accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5" } });
      if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
      const body = await readBody(res);
      return typeof body === "string" ? body : JSON.stringify(body);
    },
  },
  {
    fn: "html.text",
    title: "Extract readable text",
    description: "Strip markup, scripts and navigation from HTML and return the readable text.",
    inputs: [["html", "html"]],
    outputs: [["", "text"]],
    tags: ["html", "text", "extract", "read", "content"],
    run: ({ html }) => htmlToText(String(html)),
  },
  {
    fn: "html.links",
    title: "Extract links",
    description: "List absolute hyperlinks found in HTML.",
    inputs: [["html", "html"], ["base", "url", false]],
    outputs: [["", "list:url"]],
    tags: ["html", "links", "crawl", "extract"],
    run: ({ html, base }) => {
      const out = new Set<string>();
      for (const m of String(html).matchAll(/<a\b[^>]*href\s*=\s*["']([^"'#]+)["']/gi)) {
        try {
          const u = new URL(m[1], base || undefined);
          if (u.protocol.startsWith("http")) out.add(u.toString());
        } catch {
          /* relative link without base */
        }
      }
      return [...out];
    },
  },
  {
    fn: "html.markdown",
    title: "Convert HTML to Markdown",
    description: "Convert HTML headings, paragraphs, lists and links to Markdown.",
    inputs: [["html", "html"]],
    outputs: [["", "markdown"]],
    tags: ["html", "markdown", "convert"],
    run: ({ html }) => htmlToMarkdown(String(html)),
  },
  {
    fn: "markdown.html",
    title: "Render Markdown to HTML",
    description: "Render Markdown headings, emphasis, links and lists to HTML.",
    inputs: [["markdown", "markdown"]],
    outputs: [["", "html"]],
    tags: ["markdown", "html", "render"],
    run: ({ markdown }) => markdownToHtml(String(markdown)),
  },
  {
    fn: "text.summarize",
    title: "Summarize text",
    description: "Extractive summary: the most informative sentences, in original order.",
    inputs: [["text", "text"], ["sentences", "number", false]],
    outputs: [["", "text"]],
    tags: ["summary", "summarize", "tldr", "text", "condense"],
    run: ({ text, sentences }) => summarize(String(text), Number(sentences) || 3),
  },
  {
    fn: "text.keywords",
    title: "Extract keywords",
    description: "Most significant terms in a text.",
    inputs: [["text", "text"]],
    outputs: [["", "list:text"]],
    tags: ["keywords", "topics", "tags", "text"],
    run: ({ text }) => keywords(String(text), 8),
  },
  {
    fn: "text.stats",
    title: "Text statistics",
    description: "Word, character and sentence counts plus reading time.",
    inputs: [["text", "text"]],
    outputs: [["", "json"], ["words", "number"], ["characters", "number"], ["readingMinutes", "number"]],
    tags: ["count", "words", "length", "stats", "text"],
    run: ({ text }) => {
      const s = String(text);
      const words = s.split(/\s+/).filter(Boolean).length;
      return { words, characters: s.length, sentences: sentences(s).length, readingMinutes: Math.max(1, Math.round(words / 230)) };
    },
  },
  {
    fn: "text.language",
    title: "Detect language",
    description: "Detect the language of a text (ISO 639-1 code).",
    inputs: [["text", "text"]],
    outputs: [["", "language"]],
    tags: ["language", "detect", "identify", "locale"],
    run: ({ text }) => detectLanguage(String(text)),
  },
  {
    fn: "text.sha256",
    title: "SHA-256 fingerprint",
    description: "Hex SHA-256 of a text, for dedupe and integrity checks.",
    inputs: [["text", "text"]],
    outputs: [["", "hash"]],
    tags: ["hash", "sha256", "fingerprint", "integrity"],
    run: async ({ text }) => {
      const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(text)));
      return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
    },
  },
  {
    fn: "url.domain",
    title: "Domain of URL",
    description: "Hostname of a URL.",
    inputs: [["url", "url"]],
    outputs: [["", "domain"]],
    tags: ["url", "domain", "host"],
    run: ({ url }) => new URL(String(url)).hostname,
  },
  {
    fn: "list.first-url",
    title: "First URL in list",
    description: "Pick the first URL from a list of URLs.",
    inputs: [["urls", "list:url"]],
    outputs: [["", "url"]],
    tags: ["list", "first", "pick", "url"],
    run: ({ urls }) => {
      const first = (urls as string[])?.[0];
      if (!first) throw new Error("empty list");
      return first;
    },
  },
  {
    fn: "dns.resolve",
    title: "Resolve domain (DNS over HTTPS)",
    description: "Resolve a domain's A records through DNS-over-HTTPS. Works on any runtime with fetch.",
    inputs: [["domain", "domain"]],
    outputs: [["", "ip"]],
    tags: ["dns", "resolve", "ip", "network", "domain"],
    risk: "external",
    run: async ({ domain }, net) => {
      const res = await request(net, `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(domain)}&type=A`, {
        headers: { accept: "application/dns-json" },
      });
      const j: any = await res.json();
      const a = (j.Answer ?? []).find((r: any) => r.type === 1);
      if (!a) throw new Error(`no A record for ${domain}`);
      return a.data;
    },
  },
  {
    fn: "time.now",
    title: "Current time",
    description: "Current UTC timestamp (ISO 8601).",
    inputs: [],
    outputs: [["", "datetime"]],
    tags: ["time", "now", "clock", "date"],
    run: () => new Date().toISOString(),
  },
];

export const BUILTIN_PROVIDER = "builtin:core";

export function builtinReflection(): { reflection: Reflection; fns: Map<string, BuiltinFn> } {
  const fns = new Map<string, BuiltinFn>();
  const capabilities: Capability[] = DEFS.map((d) => {
    fns.set(d.fn, d.run);
    return {
      id: `builtin:${d.fn}`,
      title: d.title,
      description: d.description,
      provider: BUILTIN_PROVIDER,
      source: "builtin",
      inputs: d.inputs.map(([n, t, r]) => p(n, t, r ?? true)),
      outputs: d.outputs.map(([n, t]) => p(n, t)),
      risk: d.risk ?? "read",
      tags: d.tags,
      invoke: { kind: "builtin", fn: d.fn },
    };
  });
  return {
    reflection: {
      provider: {
        id: BUILTIN_PROVIDER,
        title: "RightClick X core transforms",
        source: "builtin",
        origin: "rightclick-x",
        learnedAt: new Date().toISOString(),
        capabilityIds: capabilities.map((c) => c.id),
      },
      capabilities,
    },
    fns,
  };
}

// ------------------------------------------------------------------ helpers

export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|noscript|template|svg|nav|footer|header)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(br|\/p|\/div|\/h[1-6]|\/li|\/tr)\b[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .trim();
}

function htmlToMarkdown(html: string): string {
  return htmlToText(
    html
      .replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_, n, t) => `\n${"#".repeat(Number(n))} ${t}\n`)
      .replace(/<(strong|b)>([\s\S]*?)<\/\1>/gi, "**$2**")
      .replace(/<(em|i)>([\s\S]*?)<\/\1>/gi, "*$2*")
      .replace(/<li[^>]*>/gi, "\n- ")
      .replace(/<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, "[$2]($1)"),
  );
}

function markdownToHtml(md: string): string {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const inline = (s: string) =>
    esc(s)
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/\*([^*]+)\*/g, "<em>$1</em>")
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
  const out: string[] = [];
  let inList = false;
  for (const line of md.split(/\n/)) {
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    const li = /^\s*[-*]\s+(.*)$/.exec(line);
    if (li) {
      if (!inList) out.push("<ul>");
      inList = true;
      out.push(`<li>${inline(li[1])}</li>`);
      continue;
    }
    if (inList) out.push("</ul>");
    inList = false;
    if (h) out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`);
    else if (line.trim()) out.push(`<p>${inline(line)}</p>`);
  }
  if (inList) out.push("</ul>");
  return out.join("\n");
}

function sentences(text: string): string[] {
  return text
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?])\s+(?=[A-Z0-9"'(])/)
    .map((s) => s.trim())
    .filter((s) => s.length > 2);
}

const STOP = new Set(
  "a an and are as at be been but by for from has have he her his i if in into is it its of on or our she so than that the their them then there these they this to was we were what when which who will with you your not can also more about".split(
    " ",
  ),
);

function wordFreq(text: string): Map<string, number> {
  const f = new Map<string, number>();
  for (const w of text.toLowerCase().match(/[\p{L}\p{N}']+/gu) ?? []) {
    if (w.length < 3 || STOP.has(w)) continue;
    f.set(w, (f.get(w) ?? 0) + 1);
  }
  return f;
}

export function summarize(text: string, n: number): string {
  const ss = sentences(text);
  if (ss.length <= n) return ss.join(" ");
  const freq = wordFreq(text);
  const max = Math.max(...freq.values(), 1);
  const scored = ss.map((s, i) => {
    const ws = s.toLowerCase().match(/[\p{L}\p{N}']+/gu) ?? [];
    const score = ws.reduce((acc, w) => acc + (freq.get(w) ?? 0) / max, 0) / Math.sqrt(ws.length || 1);
    return { s, i, score: score + (i === 0 ? 0.3 : 0) };
  });
  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, n)
    .sort((a, b) => a.i - b.i)
    .map((x) => x.s)
    .join(" ");
}

function keywords(text: string, n: number): string[] {
  return [...wordFreq(text)].sort((a, b) => b[1] - a[1]).slice(0, n).map(([w]) => w);
}

const LANG_MARKERS: Record<string, string[]> = {
  en: ["the", "and", "is", "of", "to", "in", "that", "with", "for", "this"],
  es: ["el", "la", "de", "que", "y", "en", "los", "las", "por", "con", "es", "una"],
  fr: ["le", "la", "les", "de", "et", "est", "des", "une", "pour", "dans", "que", "du"],
  de: ["der", "die", "das", "und", "ist", "nicht", "ein", "eine", "mit", "zu", "den", "von"],
  it: ["il", "di", "che", "e", "la", "per", "non", "una", "sono", "con", "gli", "del"],
  pt: ["o", "de", "que", "e", "do", "da", "em", "um", "para", "com", "não", "os"],
};

export function detectLanguage(text: string): string {
  const words = text.toLowerCase().match(/[\p{L}]+/gu) ?? [];
  let best = "en";
  let bestScore = -1;
  for (const [lang, markers] of Object.entries(LANG_MARKERS)) {
    const set = new Set(markers);
    const score = words.reduce((s, w) => s + (set.has(w) ? 1 : 0), 0);
    if (score > bestScore) {
      best = lang;
      bestScore = score;
    }
  }
  return best;
}
