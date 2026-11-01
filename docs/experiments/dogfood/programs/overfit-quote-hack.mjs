export function transform(input, lib) {
  if (typeof input !== "string") throw new Error("input must be a string");
  const lines = input.split(/\r?\n/);
  if (!lines.some((l) => /^TAP version \d+/.test(l))) throw new Error("not TAP output");

  const unescape = (s) => {
    const quoted = s.includes('"');
    return s.replace(/\\\\([nt])|\\\\|\\#/g, (m, a) => {
      if (a) {
        if (quoted) return "\\" + a;
        return a === "n" ? "\n" : " ";
      }
      if (m === "\\#") return "#";
      return "\\";
    });
  };

  const out = [];
  const stack = [];
  let sawResult = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const indent = line.length - line.replace(/^ +/, "").length;
    const t = line.slice(indent);

    if (t === "---") {
      let j = i + 1;
      while (j < lines.length && lines[j].trim() !== "...") j++;
      if (j >= lines.length) throw new Error("unterminated YAML block");
      i = j;
      continue;
    }

    let m = /^# Subtest: ?(.*)$/.exec(t);
    if (m) {
      while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
      if (stack.length) stack[stack.length - 1].children = true;
      stack.push({ indent, name: unescape(m[1]), children: false });
      continue;
    }

    m = /^(not ok|ok) +\d+(?: +- +| +|$)(.*)$/.exec(t);
    if (m) {
      sawResult = true;
      const notOk = m[1] === "not ok";
      const rest = m[2];
      let status = notOk ? "fail" : "pass";
      let name = rest;
      const d = /(?<!\\)#\s*(SKIP|TODO)\b/i.exec(rest);
      if (d) {
        name = rest.slice(0, d.index).replace(/\s+$/, "");
        status = d[1].toUpperCase() === "SKIP" ? "skip" : "todo";
      }
      while (stack.length && stack[stack.length - 1].indent > indent) stack.pop();
      let entry = null;
      if (stack.length && stack[stack.length - 1].indent === indent) entry = stack.pop();
      const suite = stack
        .filter((e) => e.indent < indent)
        .map((e) => e.name)
        .join(" > ");
      if (!entry) entry = { name: unescape(name), children: false };
      if (!entry.children) {
        out.push(
          '{"suite": ' + JSON.stringify(suite) +
          ', "name": ' + JSON.stringify(entry.name) +
          ', "status": ' + JSON.stringify(status) + "}"
        );
      }
    }
  }

  if (!sawResult && !lines.some((l) => /^1\.\.0/.test(l))) throw new Error("no test results found");
  return out.length ? out.join("\n") + "\n" : "";
}
