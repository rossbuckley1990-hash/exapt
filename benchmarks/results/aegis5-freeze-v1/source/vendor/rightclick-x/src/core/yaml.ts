// A small YAML reader for machine-readable contracts (OpenAPI documents published as YAML).
// Supports what such documents use: block mappings and sequences, flow [..] and {..},
// plain / single- / double-quoted scalars, literal (|) and folded (>) block scalars, comments,
// and a leading document marker. Anchors, aliases, tags and multi-document streams are not
// supported: such input is rejected with an error rather than guessed at.

export function parseYaml(text: string): unknown {
  const lines = text.replace(/\r\n?/g, "\n").replace(/\t/g, "  ").split("\n");
  let i = 0;
  const blank = (l: string) => /^\s*(#.*)?$/.test(l);
  const indentOf = (l: string) => l.length - l.trimStart().length;
  const stripComment = (s: string) => {
    let q: string | null = null;
    for (let k = 0; k < s.length; k++) {
      const c = s[k];
      if (q) {
        if (c === q && s[k - 1] !== "\\") q = null;
      } else if (c === '"' || c === "'") q = c;
      else if (c === "#" && (k === 0 || /\s/.test(s[k - 1]))) return s.slice(0, k).trimEnd();
    }
    return s.trimEnd();
  };
  while (i < lines.length && (blank(lines[i]) || /^(---|%YAML|%TAG)/.test(lines[i].trim()))) i++;
  if (lines.slice(i).some((l) => /^---\s*$/.test(l) || /^\.\.\.\s*$/.test(l))) throw new Error("multi-document YAML is not supported");

  const scalar = (raw: string): unknown => {
    const s = raw.trim();
    if (s === "" || s === "~" || s === "null" || s === "Null" || s === "NULL") return null;
    if (/^[&*!]/.test(s)) throw new Error(`YAML anchors, aliases and tags are not supported: ${s.slice(0, 30)}`);
    if (s.startsWith('"')) return JSON.parse(s.replace(/\\\//g, "/"));
    if (s.startsWith("'")) return s.slice(1, -1).replace(/''/g, "'");
    if (s.startsWith("[") || s.startsWith("{")) return flow(s);
    if (/^(true|True|TRUE)$/.test(s)) return true;
    if (/^(false|False|FALSE)$/.test(s)) return false;
    if (/^[-+]?(\d+\.?\d*([eE][-+]?\d+)?|\.\d+)$/.test(s) && !/^0\d/.test(s)) return Number(s);
    return s;
  };
  const flow = (s: string): unknown => {
    let k = 0;
    const ws = () => { while (k < s.length && /\s/.test(s[k])) k++; };
    const value = (): unknown => {
      ws();
      if (s[k] === "[") {
        k++;
        const arr: unknown[] = [];
        ws();
        if (s[k] === "]") { k++; return arr; }
        for (;;) { arr.push(value()); ws(); if (s[k] === ",") { k++; continue; } if (s[k] === "]") { k++; return arr; } throw new Error("bad flow sequence"); }
      }
      if (s[k] === "{") {
        k++;
        const obj: Record<string, unknown> = {};
        ws();
        if (s[k] === "}") { k++; return obj; }
        for (;;) {
          const key = String(atom(":"));
          if (s[k] !== ":") throw new Error("bad flow mapping");
          k++;
          obj[key] = value();
          ws();
          if (s[k] === ",") { k++; continue; }
          if (s[k] === "}") { k++; return obj; }
          throw new Error("bad flow mapping");
        }
      }
      return atom(",]}");
    };
    const atom = (stops: string): unknown => {
      ws();
      const start = k;
      if (s[k] === '"' || s[k] === "'") {
        const q = s[k++];
        while (k < s.length && !(s[k] === q && s[k - 1] !== "\\")) k++;
        k++;
        return scalar(s.slice(start, k));
      }
      while (k < s.length && !stops.includes(s[k])) k++;
      return scalar(s.slice(start, k));
    };
    const v = value();
    return v;
  };

  const block = (indent: number): unknown => {
    while (i < lines.length && blank(lines[i])) i++;
    if (i >= lines.length) return null;
    const first = lines[i];
    const ind = indentOf(first);
    if (ind < indent) return null;
    if (first.trimStart().startsWith("- ") || first.trim() === "-") return sequence(ind);
    return mapping(ind);
  };
  const blockScalar = (header: string, parentIndent: number): string => {
    const folded = header.startsWith(">");
    const keep = header.includes("+");
    const strip = header.includes("-");
    const body: string[] = [];
    let ind = -1;
    while (i < lines.length) {
      const l = lines[i];
      if (!l.trim()) { body.push(""); i++; continue; }
      const li = indentOf(l);
      if (li <= parentIndent) break;
      if (ind < 0) ind = li;
      if (li < ind) break;
      body.push(l.slice(ind));
      i++;
    }
    while (!keep && body.length && body[body.length - 1] === "") body.pop();
    let out = folded ? body.reduce((acc, l, n) => (n === 0 ? l : l === "" ? `${acc}\n` : acc.endsWith("\n") || /^\s/.test(l) ? `${acc}${l}` : `${acc} ${l}`), "") : body.join("\n");
    if (!strip) out += "\n";
    return out;
  };
  const valueAfter = (rest: string, ind: number): unknown => {
    let v = stripComment(rest).trim();
    if (v === "") {
      // A sequence may sit at the same indentation as its key ("tags:\n- name: x").
      let j = i;
      while (j < lines.length && blank(lines[j])) j++;
      if (j < lines.length && indentOf(lines[j]) === ind && /^\s*-(\s|$)/.test(lines[j])) {
        i = j;
        return sequence(ind);
      }
      return block(ind + 1);
    }
    if (/^[|>][+-]?\d*$/.test(v)) return blockScalar(v, ind);
    // Plain and quoted scalars may continue on more-indented lines (folded with single spaces).
    const open = (x: string) => (x.startsWith('"') && !/[^\\]"$|^"$/.test(x.slice(1)) ) || (x.startsWith("'") && !/'$/.test(x.slice(1))) || (/^[\[{]/.test(x) && !balanced(x));
    while (i < lines.length && !blank(lines[i]) && indentOf(lines[i]) > ind && (open(v) || !/^[\[{"']/.test(v)) && !/^\s*-\s/.test(lines[i]) && !(!open(v) && /^\s*[^\s:#][^:#]*:(\s|$)/.test(lines[i]))) {
      v = `${v} ${stripComment(lines[i]).trim()}`;
      i++;
    }
    return scalar(v);
  };
  const balanced = (x: string) => {
    let d = 0;
    let q: string | null = null;
    for (const c of x) {
      if (q) { if (c === q) q = null; continue; }
      if (c === '"' || c === "'") q = c;
      else if (c === "[" || c === "{") d++;
      else if (c === "]" || c === "}") d--;
    }
    return d === 0;
  };
  const mapping = (ind: number): Record<string, unknown> => {
    const obj: Record<string, unknown> = {};
    while (i < lines.length) {
      if (blank(lines[i])) { i++; continue; }
      const l = lines[i];
      const li = indentOf(l);
      if (li < ind) break;
      if (li > ind) throw new Error(`unexpected indentation at line ${i + 1}`);
      const t = l.trim();
      if (t.startsWith("- ")) break;
      const m = /^("(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[^:#]+?|[^\s][^:]*?)\s*:(?:\s+(.*)|$)/.exec(t);
      if (!m) throw new Error(`cannot read YAML at line ${i + 1}: ${t.slice(0, 40)}`);
      const key = String(scalar(m[1]));
      i++;
      obj[key] = valueAfter(m[2] ?? "", ind);
    }
    return obj;
  };
  const sequence = (ind: number): unknown[] => {
    const arr: unknown[] = [];
    while (i < lines.length) {
      if (blank(lines[i])) { i++; continue; }
      const l = lines[i];
      const li = indentOf(l);
      if (li < ind || !l.trimStart().startsWith("-")) break;
      if (li > ind) throw new Error(`unexpected indentation at line ${i + 1}`);
      const rest = l.trimStart().slice(1);
      if (!rest.trim()) {
        i++;
        arr.push(block(ind + 1));
        continue;
      }
      // "- key: value" starts a mapping whose keys sit at the column after "- ".
      const inner = ind + 1 + (rest.length - rest.trimStart().length);
      const r = rest.trim();
      const startsMapping = !/^[\[{]/.test(r) && /^("(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[^\s:#][^:#]*?)\s*:(\s|$)/.test(r);
      if (startsMapping) {
        lines[i] = " ".repeat(inner) + rest.trimStart();
        arr.push(mapping(inner));
      } else {
        i++;
        arr.push(valueAfter(rest, ind));
      }
    }
    return arr;
  };
  return block(0);
}
