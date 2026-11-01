// A small deterministic extraction vocabulary. Relationships are directed
// contract declarations, never global type aliases or authority grants.
import type { Binding, Capability } from "./types.ts";

export function pointerParts(pointer: string): string[] | undefined {
  if (typeof pointer !== "string" || pointer.length > 1024 || !pointer.startsWith("/") || /~(?:[^01]|$)/.test(pointer)) return;
  const parts = pointer.slice(1).split("/").map(p => p.replace(/~1/g, "/").replace(/~0/g, "~"));
  if (parts.length > 16 || parts.some(p => ["__proto__", "prototype", "constructor"].includes(p))) return;
  return parts;
}

export function pointerValue(value: unknown, pointer: string): unknown {
  const parts = pointerParts(pointer);
  if (!parts) return;
  for (const part of parts) {
    if (!value || typeof value !== "object" || !Object.hasOwn(value, part) ||
        Array.isArray(value) && !/^(0|[1-9]\d*)$/.test(part)) return;
    value = (value as Record<string, unknown>)[part];
  }
  return value;
}

export function validLinkBinding(source: Capability | undefined, target: Capability | undefined, binding: Binding): boolean {
  const b = binding.link;
  if (!b || !source || !target || source.invoke.kind !== "http" || target.invoke.kind !== "http" || source.provider !== target.provider) return false;
  const links = source.links?.filter(l => l.name === b.name && l.status === b.status && l.target === target.id) ?? [];
  if (links.length !== 1) return false;
  const parameters = links[0].parameters.filter(p => p.port === binding.port && p.pointer === b.pointer && p.wire === b.wire && p.format === b.format);
  const port = target.inputs.find(p => p.name === binding.port);
  return parameters.length === 1 && !!port && port.wire === b.wire && !!pointerParts(b.pointer);
}

export function validLinkGroup(source: Capability | undefined, target: Capability | undefined, bindings: Binding[]): boolean {
  const linked = bindings.filter(b => b.link), first = linked[0];
  if (!first) return true;
  const relation = source?.links?.find(l => l.name === first.link!.name && l.status === first.link!.status && l.target === target?.id);
  return !!relation && relation.parameters.length === linked.length &&
    linked.every(b => b.from === first.from && b.link!.name === first.link!.name && b.link!.status === first.link!.status &&
      bindings.filter(other => other.port === b.port).length === 1 && validLinkBinding(source, target, b));
}

export function validLinkValue(value: unknown, binding: Binding, target: Capability): boolean {
  const wire = binding.link?.wire;
  const type = wire === "integer" ? Number.isSafeInteger(value) : wire === "number" ? typeof value === "number" && Number.isFinite(value) : typeof value === wire;
  const port = target.inputs.find(p => p.name === binding.port);
  if (binding.link?.format === "uuid" && (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value))) return false;
  if (binding.link?.format === "uri") {
    if (typeof value !== "string" || /\s/.test(value)) return false;
    try { new URL(value); } catch { return false; }
  }
  return type && value !== "" && (!port?.enum || port.enum.includes(String(value)));
}
