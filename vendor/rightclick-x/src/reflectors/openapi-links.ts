// Bounded OpenAPI Link Objects: same-document operations and scalar JSON body
// pointers only. Unsupported/ambiguous links are omitted as a whole.
import { pointerParts } from "../core/links.ts";
import type { Capability, ContractLink } from "../core/types.ts";

type Obj = Record<string, any>;
export interface LinkedOperation { path: string; method: string; operation: Obj; parameters: Obj[]; capability: Capability; serverOverride: boolean }

export function reflectLinks(operations: LinkedOperation[], resolve: (value: any) => any): void {
  let count = 0;
  const byId = new Map<string, LinkedOperation[]>(), byRef = new Map<string, LinkedOperation[]>(), ids = new Map<string, number>();
  for (const op of operations) {
    if (typeof op.operation.operationId === "string") byId.set(op.operation.operationId, [...(byId.get(op.operation.operationId) ?? []), op]);
    const ref = `${op.path}\0${op.method}`; byRef.set(ref, [...(byRef.get(ref) ?? []), op]);
    ids.set(op.capability.id, (ids.get(op.capability.id) ?? 0) + 1);
  }
  const schemaAt = (schema: any, pointer: string) => {
    const parts = pointerParts(pointer);
    if (!parts) return;
    let s = resolve(schema);
    for (const part of parts) {
      if (!s || s.allOf || s.oneOf || s.anyOf) return;
      s = resolve(s.type === "array" && /^(0|[1-9]\d*)$/.test(part) ? s.items :
        s.properties && Object.hasOwn(s.properties, part) ? s.properties[part] : undefined);
    }
    return s && !s.allOf && !s.oneOf && !s.anyOf ? s : undefined;
  };
  for (const source of operations) {
    if (source.serverOverride || ids.get(source.capability.id) !== 1) continue;
    const links: ContractLink[] = [];
    for (const [status, raw] of Object.entries<Obj>(source.operation.responses ?? {})) {
      if (!/^2\d\d$/.test(status) || status === "202") continue;
      const response = resolve(raw);
      const content = Object.entries<Obj>(response?.content ?? {}).filter(([media]) => media === "application/json" || media.endsWith("+json"));
      if (content.length !== 1) continue;
      for (const [name, rawLink] of Object.entries<Obj>(response.links ?? {})) {
        if (count >= 128 || links.length >= 32 || name.length > 128) break;
        const link = resolve(rawLink);
        if (!link || link.server !== undefined || link.requestBody !== undefined ||
            (typeof link.operationId === "string") === (typeof link.operationRef === "string")) continue;
        let target: LinkedOperation[];
        if (typeof link.operationId === "string") target = byId.get(link.operationId) ?? [];
        else {
          if (!link.operationRef.startsWith("#/")) continue;
          let parts: string[] | undefined;
          try { parts = pointerParts(decodeURIComponent(link.operationRef.slice(1))); } catch { continue; }
          target = parts?.length === 3 && parts[0] === "paths" ? byRef.get(`${parts[1]}\0${parts[2]}`) ?? [] : [];
        }
        if (target.length !== 1 || target[0] === source || target[0].serverOverride || ids.get(target[0].capability.id) !== 1) continue;
        const to = target[0], parameters: ContractLink["parameters"] = [];
        const mappings = link.parameters && typeof link.parameters === "object" && !Array.isArray(link.parameters) ? Object.entries(link.parameters) : [];
        if (!mappings.length || mappings.length > 16) continue;
        for (const [key, expression] of mappings) {
          if (typeof expression !== "string" || !expression.startsWith("$response.body#/")) break;
          const pointer = expression.slice("$response.body#".length);
          const qualified = /^(path|query|header)\.(.+)$/.exec(key);
          const matches = to.parameters.filter(p => qualified ? p.in === qualified[1] && p.name === qualified[2] : p.name === key);
          if (matches.length !== 1) break;
          const param = matches[0], port = to.capability.inputs.find(p => p.name === param.name);
          const input = resolve(param.schema), output = schemaAt(content[0][1].schema, pointer);
          if (!port || input?.allOf || input?.oneOf || input?.anyOf || !["path", "query", "header"].includes(param.in) || ["__proto__", "constructor", "prototype"].includes(port.name) ||
              !["string", "integer", "number", "boolean"].includes(input?.type) || input.type !== output?.type || port.wire !== input.type ||
              to.parameters.filter(p => p.name === param.name).length !== 1 || parameters.some(p => p.port === port.name)) break;
          if (input.format !== undefined && (!["uuid", "uri"].includes(input.format) || input.type !== "string") ||
              input.format && output.format && input.format !== output.format) break;
          parameters.push({ port: port.name, pointer, wire: input.type, ...(input.format ? { format: input.format } : {}) });
        }
        if (parameters.length !== mappings.length) continue;
        links.push({ name, status: Number(status), target: to.capability.id, parameters }); count++;
      }
    }
    if (links.length) source.capability.links = links;
  }
}
