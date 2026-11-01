// Contract-declared result fields: every path a JSON schema declares, through objects and
// arrays, bounded. A plan is judged by what its result carries (core/satisfaction.ts), and
// that is often deeper than the ports used for binding.
import type { DeclaredField } from "./types.ts";

type Obj = Record<string, any>;

export function schemaFields(schema: Obj | undefined, resolve: (o: any) => any = (o) => o, maxDepth = 5, limit = 1500): DeclaredField[] {
  const out: DeclaredField[] = [];
  // Breadth-first, so a bound never hides shallow fields behind earlier fields' depths.
  let level: Array<{ s: Obj | undefined; prefix: string; seen: Set<any> }> = [{ s: schema, prefix: "", seen: new Set() }];
  for (let depth = 0; depth <= maxDepth && level.length && out.length < limit; depth++) {
    const next: typeof level = [];
    const expand = (s0: Obj | undefined, prefix: string, seen: Set<any>) => {
      const s = s0 ? resolve(s0) : undefined;
      if (!s || typeof s !== "object" || seen.has(s)) return;
      const seen2 = new Set([...seen, s]);
      for (const part of [...(s.allOf ?? []), ...(s.oneOf ?? []), ...(s.anyOf ?? [])]) expand(part, prefix, seen2);
      if (s.items) expand(s.items, prefix ? `${prefix}[]` : "[]", seen2);
      for (const [name, prop] of Object.entries<Obj>(s.properties ?? {})) {
        if (out.length >= limit) return;
        const path = prefix ? `${prefix}.${name}` : name;
        out.push({ path });
        next.push({ s: prop, prefix: path, seen: seen2 });
      }
    };
    for (const { s, prefix, seen } of level) expand(s, prefix, seen);
    level = next;
  }
  return out;
}
