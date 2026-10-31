// Plain web pages -> capabilities. Every <form> on a page is a typed function
// the site already publishes; this reflector makes it one. The page also
// yields discovery hints (service-desc links, linked specs) for research.

import { inferType } from "../core/semantics.ts";
import type { Capability, Port, Reflection } from "../core/types.ts";
import { slug } from "./net.ts";

function attrs(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of tag.matchAll(/([a-zA-Z_:-]+)\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/g)) {
    out[m[1].toLowerCase()] = decode(m[3] ?? m[4] ?? m[5] ?? "");
  }
  return out;
}

function decode(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

export function pageTitle(html: string): string | undefined {
  return /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]?.trim().replace(/\s+/g, " ");
}

export function discoveryHints(html: string, pageUrl: string): string[] {
  const hints = new Set<string>();
  for (const m of html.matchAll(/<link\b[^>]*>/gi)) {
    const a = attrs(m[0]);
    const rel = (a.rel ?? "").toLowerCase();
    if (a.href && (rel.includes("service-desc") || rel.includes("openapi") || /openapi|swagger|graphql|mcp/.test(a.type ?? ""))) {
      hints.add(new URL(a.href, pageUrl).toString());
    }
  }
  for (const m of html.matchAll(/href\s*=\s*["']([^"']*(openapi|swagger)[^"']*\.json)["']/gi)) {
    hints.add(new URL(m[1], pageUrl).toString());
  }
  return [...hints];
}

const TYPE_HINT: Record<string, { type?: string; format?: string }> = {
  email: { type: "string", format: "email" },
  url: { type: "string", format: "uri" },
  number: { type: "number" },
  range: { type: "number" },
  date: { type: "string", format: "date" },
  "datetime-local": { type: "string", format: "date-time" },
  checkbox: { type: "boolean" },
  color: { type: "string" },
};

export function reflectWeb(html: string, pageUrl: string): Reflection {
  const url = new URL(pageUrl);
  const title = pageTitle(html) ?? url.host;
  const providerId = `web:${slug(url.host + url.pathname)}`;
  const capabilities: Capability[] = [];

  let i = 0;
  for (const m of html.matchAll(/<form\b([^>]*)>([\s\S]*?)<\/form>/gi)) {
    i++;
    const fa = attrs(`<form ${m[1]}>`);
    const method = (fa.method ?? "get").toUpperCase() === "POST" ? "POST" : "GET";
    const action = new URL(fa.action || pageUrl, pageUrl).toString();
    const inputs: Port[] = [];
    const constants: Record<string, string> = {};
    for (const f of m[2].matchAll(/<(input|textarea|select)\b([^>]*)>/gi)) {
      const a = attrs(f[0]);
      if (!a.name) continue;
      const kind = f[1].toLowerCase() === "input" ? (a.type ?? "text").toLowerCase() : f[1].toLowerCase();
      if (["submit", "button", "reset", "image", "file", "password"].includes(kind)) continue;
      if (kind === "hidden") {
        constants[a.name] = a.value ?? "";
        continue;
      }
      const label = a["aria-label"] ?? a.placeholder ?? a.title ?? "";
      inputs.push({
        name: a.name,
        type: inferType(a.name, TYPE_HINT[kind] ?? { type: "string" }, label),
        required: "required" in a || /\brequired\b/.test(f[2]),
        description: label || undefined,
        wire: kind,
      });
    }
    if (!inputs.length) continue;
    // A form with one text box and no explicit `required` is still unusable empty.
    if (!inputs.some((p) => p.required)) inputs[0].required = true;
    const name = fa["aria-label"] ?? fa.name ?? fa.id ?? (inputs.length === 1 ? `${inputs[0].name} form` : `form ${i}`);
    capabilities.push({
      id: `${providerId}:form-${slug(name)}`,
      title: `${title}: ${name}`,
      description: `Submit the "${name}" form on ${url.host}${url.pathname} (${method} ${action}).`,
      provider: providerId,
      source: "web",
      inputs,
      outputs: [{ name: "", type: "html", required: true }],
      risk: method === "GET" ? "read" : "write",
      tags: ["web", "form", url.host, name],
      invoke: {
        kind: "http",
        method,
        url: action,
        pathParams: [],
        queryParams: method === "GET" ? inputs.map((p) => p.name) : [],
        headerParams: [],
        body: method === "POST" ? "form" : null,
        bodyParams: method === "POST" ? inputs.map((p) => p.name) : [],
        constants,
      },
    });
  }

  return {
    provider: {
      id: providerId,
      title,
      source: "web",
      origin: pageUrl,
      learnedAt: new Date().toISOString(),
      capabilityIds: capabilities.map((c) => c.id),
      meta: { hints: discoveryHints(html, pageUrl) },
    },
    capabilities,
  };
}
