export function transform(input, lib) {
  if (typeof input !== "string") throw new Error("input must be a string");
  const lines = input.split(/\r?\n/);
  if (!lines.some((l) => /^TAP version \d+/.test(l))) {
    throw new Error("not TAP output");
  }
  const unesc = (s) => s.replace(/\\([#\\])/g, "$1");
  const stack = [];
  const out = [];
  const subRe = /^(\s*)# Subtest: (.*)$/;
  const resRe = /^(\s*)(not ok|ok) (\d+)(?: - (.*))?$/;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let m = subRe.exec(line);
    if (m) {
      const indent = m[1].length;
      while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
      if (stack.length) stack[stack.length - 1].hadChild = true;
      stack.push({ indent, name: unesc(m[2]), hadChild: false });
      continue;
    }
    m = resRe.exec(line);
    if (!m) continue;
    const indent = m[1].length;
    let raw = m[4] === undefined ? "" : m[4];
    let status = m[2] === "ok" ? "pass" : "fail";
    const d = /(?<!\\)\s#\s*(SKIP|TODO)\b/i.exec(raw);
    if (d) {
      status = d[1].toLowerCase() === "skip" ? "skip" : "todo";
      raw = raw.slice(0, d.index);
    }
    const name = unesc(raw);
    // yaml block
    let type = null;
    let j = i + 1;
    if (j < lines.length && lines[j].trim() === "---") {
      j++;
      while (j < lines.length && lines[j].trim() !== "...") {
        const t = /^\s*type:\s*'?([a-z]+)'?\s*$/.exec(lines[j]);
        if (t && lines[j].search(/\S/) === indent + 2) type = t[1];
        j++;
      }
      if (j >= lines.length) throw new Error("unterminated YAML block");
      i = j;
    }
    while (stack.length && stack[stack.length - 1].indent > indent) stack.pop();
    let node = null;
    if (stack.length && stack[stack.length - 1].indent === indent) node = stack.pop();
    const hadChild = node ? node.hadChild : false;
    if (type === "suite" || hadChild) continue;
    out.push({
      suite: stack.map((s) => s.name).join(" > "),
      name,
      status,
    });
  }
  return out
    .map(
      (e) =>
        `{"suite": ${JSON.stringify(e.suite)}, "name": ${JSON.stringify(e.name)}, "status": ${JSON.stringify(e.status)}}\n`
    )
    .join("");
}
