export function transform(input, lib) {
  if (typeof input !== "string") throw new Error("input must be a string");
  const lines = input.split(/\r?\n/);
  if (!lines.some((l) => /^TAP version \d+/.test(l))) {
    throw new Error("not TAP output");
  }
  const unescape = (s) => s.replace(/\\([\\#])/g, "$1");
  const recs = [];
  let inYaml = false;
  let yamlIndent = 0;
  for (const line of lines) {
    if (inYaml) {
      const m = /^(\s*)\.\.\.\s*$/.exec(line);
      if (m && m[1].length <= yamlIndent) inYaml = false;
      continue;
    }
    const y = /^(\s*)---\s*$/.exec(line);
    if (y) {
      inYaml = true;
      yamlIndent = y[1].length;
      continue;
    }
    const m = /^(\s*)(not ok|ok)\s+(\d+)(?:\s*-?\s*(.*))?$/.exec(line);
    if (!m) continue;
    let name = m[4] || "";
    let status = m[2] === "ok" ? "pass" : "fail";
    const d = /\s+#\s*(skip|todo)\b.*$/i.exec(name);
    if (d) {
      status = d[1].toLowerCase() === "skip" ? "skip" : "todo";
      name = name.slice(0, d.index);
    } else if (/^#\s*(skip|todo)\b/i.test(name)) {
      status = /^#\s*skip/i.test(name) ? "skip" : "todo";
      name = "";
    }
    name = unescape(name);
    recs.push({ indent: m[1].length, name, status, parent: -1, hasChild: false });
  }
  if (inYaml) throw new Error("unterminated YAML block");
  for (let i = 0; i < recs.length; i++) {
    for (let j = i + 1; j < recs.length; j++) {
      if (recs[j].indent < recs[i].indent) {
        recs[i].parent = j;
        recs[j].hasChild = true;
        break;
      }
    }
  }
  const out = [];
  for (const r of recs) {
    if (r.hasChild) continue;
    const parts = [];
    let p = r.parent;
    while (p !== -1) {
      parts.unshift(recs[p].name);
      p = recs[p].parent;
    }
    out.push(
      `{"suite": ${JSON.stringify(parts.join(" > "))}, "name": ${JSON.stringify(r.name)}, "status": ${JSON.stringify(r.status)}}`
    );
  }
  return out.length ? out.join("\n") + "\n" : "";
}
