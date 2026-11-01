// EXAPT LAB. Everything on screen comes from the running engine. Program documentation and generated
// output are untrusted, so all of it reaches the page as text nodes, never as markup.
const h = (tag, attrs = {}, ...kids) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (v === true) el.setAttribute(k, "");
    else if (v !== false && v !== undefined && v !== null) el.setAttribute(k, v);
  }
  for (const kid of kids.flat()) if (kid !== null && kid !== undefined && kid !== false) el.append(kid.nodeType ? kid : String(kid));
  return el;
};
const svg = (tag, attrs = {}, ...kids) => {
  const el = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  for (const kid of kids.flat()) if (kid !== null && kid !== undefined) el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  return el;
};
const api = async (path, body) => {
  const res = await fetch(`/api${path}`, body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? `request failed (${res.status})`);
  return data;
};

const LEVELS = ["not-established", "syntax-valid", "executed", "passed-visible", "passed-independent", "passed-holdout", "verified-in-domain"];
const WORDS = {
  "not-established": "Not established", "syntax-valid": "Syntax valid", executed: "Executed", "passed-visible": "Passed visible examples",
  "passed-independent": "Passed independent tests", "passed-holdout": "Passed held-out tests", "verified-in-domain": "Verified within its domain",
};
const STATUS = {
  existing: ["Existing", ""], "candidate-missing": ["Missing", "warn"], "synthesised-unverified": ["Unverified", "warn"], "verified-within-scope": ["Verified within scope", "ok"],
  invalidated: ["Invalidated", "bad"], refused: ["Refused", "bad"], unavailable: ["Unavailable", "bad"],
};
const chip = (text, kind = "") => h("span", { class: `chip ${kind}` }, text);
const statusChip = (s) => chip(...(STATUS[s] ?? [s, ""]));
const stat = (n, label) => h("div", { class: "stat" }, h("b", {}, n), h("span", {}, label));
const empty = (text) => h("div", { class: "empty" }, text);
const time = (iso) => new Date(iso).toLocaleTimeString([], { hour12: false });

const state = { view: "universe", run: null, capability: null, analysis: null, goalText: "", goalId: "", live: [] };
const views = {};
const main = document.getElementById("view");

function page(title, sub, ...actions) {
  return h("div", { class: "page-head" }, h("div", {}, h("h1", {}, title), h("p", { class: "sub" }, sub)), h("div", { class: "row" }, actions));
}

async function show(name) {
  state.view = name;
  for (const b of document.querySelectorAll("nav button")) b.toggleAttribute("aria-current", false), b.dataset.view === name && b.setAttribute("aria-current", "page");
  try {
    const node = await views[name]();
    main.replaceChildren(node);
  } catch (e) {
    main.replaceChildren(h("div", { class: "empty bad-text" }, String(e.message)));
  }
  main.focus({ preventScroll: true });
}

// ---------------------------------------------------------------- graph

const short = (label) => label.split("{")[0];
const fieldsOf = (label) => (label.includes("{") ? label.slice(label.indexOf("{") + 1, -1) : "");
const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** Layered drawing of representations (boxes) and the operations between them (edges). */
function flowGraph(edges, opts = {}) {
  const labels = [...new Set(edges.flatMap((e) => [e.from, e.to]))];
  if (!labels.length) return empty("Nothing has been discovered yet.");
  // Layers by distance from the sources, so a cycle shows as a return arrow, not an ever-longer chain.
  const incoming = new Map(labels.map((l) => [l, 0]));
  for (const e of edges) if (e.from !== e.to) incoming.set(e.to, incoming.get(e.to) + 1);
  const rank = new Map();
  let frontier = labels.filter((l) => incoming.get(l) === 0);
  if (!frontier.length) frontier = [labels[0]];
  for (let depth = 0; frontier.length; depth++) {
    const next = [];
    for (const l of frontier) if (!rank.has(l)) rank.set(l, depth);
    for (const l of frontier) for (const e of edges) if (e.from === l && !rank.has(e.to) && !next.includes(e.to)) next.push(e.to);
    frontier = next;
  }
  for (const l of labels) if (!rank.has(l)) rank.set(l, 0);
  const columns = new Map();
  for (const l of labels) (columns.get(rank.get(l)) ?? columns.set(rank.get(l), []).get(rank.get(l))).push(l);
  const W = 200, H = 54, GX = 118, GY = 34;
  const pos = new Map();
  let maxY = 0;
  [...columns.keys()].sort((a, b) => a - b).forEach((c, i) => columns.get(c).forEach((l, j) => {
    pos.set(l, { x: 18 + i * (W + GX), y: 18 + j * (H + GY) });
    maxY = Math.max(maxY, 18 + j * (H + GY));
  }));
  const width = 36 + columns.size * W + (columns.size - 1) * GX;
  const root = svg("svg", { viewBox: `0 0 ${width} ${maxY + H + 22}`, width, height: maxY + H + 22, role: "img", "aria-label": "Representations and the operations between them" });
  const defs = svg("defs", {}, ...["faint", "warn", "new"].map((c) => svg("marker", { id: `arrow-${c}`, viewBox: "0 0 8 8", refX: 7, refY: 4, markerWidth: 7, markerHeight: 7, orient: "auto" }, svg("path", { d: "M0 0L8 4L0 8z", style: `fill:var(--${c})` }))));
  root.append(defs);
  const seen = new Map();
  for (const e of edges) {
    const a = pos.get(e.from), b = pos.get(e.to);
    if (!a || !b) continue;
    const kind = e.status === "candidate-missing" ? "missing" : e.status === "verified-within-scope" ? "verified" : "";
    const key = `${e.from}>${e.to}`;
    const n = seen.get(key) ?? 0;
    seen.set(key, n + 1);
    const self = e.from === e.to;
    const back = b.x <= a.x && !self;
    const x1 = back ? a.x : a.x + W, y1 = a.y + H / 2 + n * 8, x2 = back ? b.x + W : b.x, y2 = b.y + H / 2 + n * 8;
    const mid = (x1 + x2) / 2;
    const d = self ? `M${a.x + W - 30} ${a.y} C ${a.x + W - 10} ${a.y - 26}, ${a.x + W + 30} ${a.y - 12}, ${a.x + W} ${a.y + 14}` : back ? `M${x1} ${y1} C ${x1 - 70} ${y1 + 80}, ${x2 + 70} ${y2 + 80}, ${x2} ${y2}` : `M${x1} ${y1} C ${mid} ${y1}, ${mid} ${y2}, ${x2} ${y2}`;
    const marker = kind === "missing" ? "warn" : kind === "verified" ? "new" : "faint";
    root.append(svg("g", { class: `g-edge ${kind}` }, svg("path", { d, "marker-end": `url(#arrow-${marker})` }),
      svg("text", { x: self ? a.x + W - 4 : mid, y: self ? a.y - 22 : (back ? Math.max(y1, y2) + 58 : (y1 + y2) / 2 - 6 - n * 10), "text-anchor": "middle" }, kind === "missing" ? "missing" : kind === "verified" ? clip(e.title ?? "new capability", 26) : clip(e.title ?? e.via.replace(/^cli:|:mined$/g, ""), 24))));
  }
  for (const l of labels) {
    const { x, y } = pos.get(l);
    root.append(svg("g", { class: `g-node ${opts.goal === l ? "goal" : ""}`, transform: `translate(${x} ${y})` },
      svg("title", {}, l), svg("rect", { width: W, height: H, rx: 7 }),
      svg("text", { x: 11, y: 22, "font-weight": 600 }, clip(short(l), 27)), svg("text", { x: 11, y: 39, class: "fields" }, clip(fieldsOf(l), 32))));
  }
  return h("div", { class: "graph-wrap" }, root);
}

// ---------------------------------------------------------------- views

views.universe = async () => {
  const q = state.query ?? "";
  const [u, s] = await Promise.all([api(`/universe?q=${encodeURIComponent(q)}`), api("/state")]);
  const count = s.counts;
  const search = h("input", { type: "search", placeholder: "Search capabilities, representations, fields", value: q, "aria-label": "Search capabilities", onchange: (e) => { state.query = e.target.value; show("universe"); } });
  // A program's mined contract supersedes RightClick X's generic reading of the same program.
  const mined = new Set(u.nodes.filter((n) => n.id.endsWith(":mined")).map((n) => n.id.split(":")[1]));
  const order = (n) => (n.status === "existing" ? (n.id.endsWith(":mined") ? 1 : 2) : 0);
  const rows = u.nodes.filter((n) => (n.source !== "builtin" && n.source !== "platform") || n.status !== "existing").filter((n) => !(n.id.endsWith(":default") && mined.has(n.id.split(":")[1]))).sort((a, b) => order(a) - order(b)).slice(0, 60).map((n) =>
    h("tr", {}, h("td", {}, h("div", { class: "mono" }, n.id), h("div", { class: "note" }, clip(n.title, 80))), h("td", {}, statusChip(n.status)), h("td", { class: "mono" }, clip(n.inputs[0]?.repr ?? n.inputs[0]?.semantic ?? "", 48)), h("td", { class: "mono" }, clip(n.outputs[0]?.repr ?? n.outputs[0]?.semantic ?? "", 48))));
  return h("div", {},
    page("Capability Universe", "What this installation can do, established by experiment. Boxes are representations of data. Arrows are operations. A dashed arrow is a transformation known to be missing."),
    h("div", { class: "stats" }, stat(u.tools.length, "operations with a mined contract"), stat(count.total, "capabilities in the graph"), stat(count.candidateMissing, "known missing"), stat(count.verified, "acquired and verified"), stat(count.invalidated + count.refused, "invalidated or refused"), stat(s.receipts, "receipts")),
    flowGraph(u.flow.map((e) => ({ ...e, title: e.status === "verified-within-scope" ? "acquired" : undefined }))),
    h("h2", {}, "Capabilities"), h("div", { class: "row", style: "margin-bottom:8px" }, search),
    h("div", { class: "card" }, rows.length ? h("table", {}, h("thead", {}, h("tr", {}, h("th", {}, "Capability"), h("th", {}, "Status"), h("th", {}, "Accepts"), h("th", {}, "Produces"))), h("tbody", {}, rows)) : h("p", { class: "note" }, "Nothing matches.")));
};

const feedLine = (e) => {
  const words = {
    stage: () => e.stage, analysis: () => e.summary, "contract.built": () => `Contract built with oracles: ${[...new Set(e.oracles)].join(", ")}`, "tests.prepared": () => `${e.visible} visible, ${e.boundary} boundary and ${e.malformed} malformed cases prepared`,
    "round.started": () => `Round ${e.round}: ${e.trainingPairs} example(s), ${e.counterexamples} counterexample(s)`, "candidate.proposed": () => `Candidate from ${e.producer}${e.explanation?.[0] ? `: ${e.explanation.slice(0, 2).join("; ")}` : ""}`,
    "candidate.rejected": () => `Rejected at ${e.rejectedAt}: ${e.reason ?? ""}`, "candidate.survived": () => `A candidate survived every gate, reaching ${WORDS[e.level]}`, counterexample: () => `Counterexample: ${e.problem}`,
    "synthesis.note": () => e.note, verified: () => e.assessment, workflow: () => (e.ok ? "The completed workflow ran" : "The workflow did not complete"), "run.finished": () => e.outcome, "run.failed": () => e.error,
  };
  return (words[e.type] ?? (() => e.type))();
};

views.workspace = async () => {
  const s = await api("/state");
  const goals = s.goals;
  if (!state.goalId && !state.goalText && goals[0]) state.goalId = goals[0].id;
  const picker = h("select", { "aria-label": "Prepared goal", onchange: (e) => { state.goalId = e.target.value; state.analysis = null; show("workspace"); } }, h("option", { value: "" }, "Write my own goal"), goals.map((g) => h("option", { value: g.id, selected: g.id === state.goalId }, g.title)));
  const editor = h("textarea", { "aria-label": "Goal JSON", spellcheck: "false", rows: 9, oninput: (e) => (state.goalText = e.target.value) });
  const picked = goals.find((g) => g.id === state.goalId);
  editor.value = picked ? JSON.stringify(picked.goal, null, 2) : state.goalText || JSON.stringify({ id: "my-goal", intent: "Describe the outcome", have: { samples: [{ text: "a;b\n1;2\n" }] }, want: { program: "name-of-program" } }, null, 2);
  editor.readOnly = !!picked;
  const strategy = h("select", { "aria-label": "Synthesis strategy" }, ["auto", "deterministic-only", "model-first", "model-only"].map((v) => h("option", { value: v }, v)));
  const body = () => (picked ? { goalId: picked.id } : { goal: JSON.parse(editor.value) });
  const out = h("div", {});
  const analyse = h("button", { class: "quiet", onclick: async () => {
    analyse.disabled = true;
    out.replaceChildren(h("p", { class: "note" }, "Running the programs to find out what is reachable…"));
    try {
      state.analysis = await api("/analyse", body());
      out.replaceChildren(analysisCard(state.analysis));
    } catch (e) { out.replaceChildren(h("p", { class: "bad-text" }, e.message)); }
    analyse.disabled = false;
  } }, "Analyse");
  const invent = h("button", { class: "primary", onclick: async () => {
    invent.disabled = true;
    state.live = [];
    try {
      const r = await api("/runs", { ...body(), strategy: strategy.value });
      state.run = r.id;
      renderFeed();
    } catch (e) { out.replaceChildren(h("p", { class: "bad-text" }, e.message)); }
    invent.disabled = false;
  } }, "Invent");
  const modelLine = s.model ? chip(`Model: ${s.model.provider}/${s.model.model}`, "info") : chip("No model: deterministic synthesis only");
  return h("div", {},
    page("Invention Workspace", "State an outcome. EXAPT decides whether it can already be reached, and if not, tries to construct what is missing.", modelLine),
    h("div", { class: "grid two" },
      h("div", { class: "card grid" }, h("label", { class: "field" }, "Goal", picker), h("label", { class: "field" }, "Definition", editor), h("div", { class: "row" }, h("label", { class: "field", style: "flex:1" }, "Strategy", strategy)), h("div", { class: "row end" }, analyse, invent)),
      h("div", { class: "card" }, h("h2", {}, "Live run"), h("div", { id: "feed", class: "feed", "aria-live": "polite" }, state.live.length ? state.live.map(liveRow) : h("p", { class: "note" }, "Events appear here as they happen. Nothing is shown until the engine reports it.")))),
    h("div", { style: "margin-top:12px" }, out, state.analysis ? analysisCard(state.analysis) : null));
};

const liveRow = (e) => h("div", {}, h("time", {}, time(e.at)), h("span", { class: e.type === "candidate.rejected" ? "bad-text" : "" }, clip(String(feedLine(e)), 240)));
function renderFeed() {
  const f = document.getElementById("feed");
  if (f) f.replaceChildren(...state.live.map(liveRow)), (f.scrollTop = f.scrollHeight);
}

const STATUS_WORDS = { "achievable-existing": ["Already possible", "ok"], "achievable-composition": ["Possible by composing what exists", "ok"], "gap-found": ["A transformation is missing", "warn"], underspecified: ["Not specified enough", "warn"], "not-constructible": ["Not constructible from what is here", "bad"], unverifiable: ["Could be built, but not verified", "bad"] };

function analysisCard(a) {
  const [word, kind] = STATUS_WORDS[a.status] ?? [a.status, ""];
  return h("div", { class: "card" }, h("div", { class: "row" }, chip(word, kind)), h("p", {}, a.summary), h("p", { class: "note" }, `RightClick X alone: ${a.rcx.plans} type-level plan(s). ${a.rcx.note}.`), a.questions.map((q) => h("p", { class: "bad-text" }, q)), a.gaps.length ? h("button", { class: "quiet", onclick: () => show("map") }, "See the missing capability map") : null);
}

views.map = async () => {
  const a = state.analysis;
  if (!a) return h("div", {}, page("Missing Capability Map", "The operational paths that exist, the exact transformation that is missing, and how each candidate gap ranks."), empty("Analyse a goal in the Invention Workspace first."));
  const u = await api("/universe");
  const best = a.gaps[0];
  const edges = u.flow.filter((e) => e.status !== "candidate-missing" && (a.reachable.some((r) => r.label === e.from || r.label === e.to) || a.required.some((r) => r.label === e.from || r.label === e.to)));
  if (best) {
    const [from, to] = best.title.split(" -> ");
    if (!edges.some((e) => e.from === from && e.to === to)) edges.push({ from, to, via: best.id, status: "candidate-missing" });
  }
  const scoreBars = best ? Object.entries(best.scores).map(([k, v]) => h("div", { class: "bar score" }, h("span", {}, k), h("div", { class: "track" }, h("div", { class: "fill", style: `width:${Math.round(v * 100)}%` })), h("span", {}, v.toFixed(2)))) : null;
  return h("div", {},
    page("Missing Capability Map", a.summary),
    flowGraph(edges),
    h("h2", {}, "Ranked gaps"),
    h("div", { class: "card" }, h("table", {}, h("thead", {}, h("tr", {}, h("th", {}, "Score"), h("th", {}, "Transformation"), h("th", {}, "Oracles"), h("th", {}, "Attempt?"))), h("tbody", {}, a.gaps.map((g) => h("tr", {}, h("td", {}, g.score.toFixed(3)), h("td", { class: "mono" }, g.title), h("td", {}, g.oracles.map((o) => chip(o, o === "inverse-route" || o === "ground-truth" ? "ok" : ""))), h("td", {}, g.worthAttempting ? chip("yes", "ok") : h("span", { class: "note" }, g.reasons[0] ?? "no"))))))),
    best ? h("div", { class: "grid two", style: "margin-top:12px" }, h("div", { class: "card" }, h("h3", {}, "Why this gap ranks first"), scoreBars), h("div", { class: "card" }, h("h3", {}, "Evidence that would establish correctness"), h("ul", {}, best.evidenceNeeded.map((e) => h("li", {}, e))))) : null);
};

function ladder(level, won, stopped) {
  const reached = LEVELS.indexOf(level);
  return h("div", { class: `ladder ${won ? "won" : "lost"}`, role: "img", "aria-label": `Reached: ${WORDS[level]}` }, LEVELS.slice(1).map((l, i) => h("i", { class: i + 1 <= reached ? "on" : i === reached && stopped ? "stop" : "", title: WORDS[l] })));
}

views.lab = async () => {
  const runs = await api("/runs");
  if (!runs.length) return h("div", {}, page("Experiment Lab", "Every attempt, the tests it faced, and why it was rejected."), empty("No runs yet. Start one in the Invention Workspace."));
  const id = state.run ?? runs[0].id;
  const [run, events] = await Promise.all([api(`/runs/${id}`), api(`/runs/${id}/events`)]);
  const pick = h("div", { class: "list" }, runs.slice(0, 20).map((r) => h("button", { "aria-pressed": r.id === id ? "true" : "false", onclick: () => { state.run = r.id; show("lab"); } }, h("div", {}, clip(r.goal, 36)), h("div", { class: "note" }, `${r.status}, ${time(r.startedAt)}`))));
  const attempts = run.attempts.map((a) => h("div", { class: "card" },
    h("div", { class: "row" }, h("strong", {}, a.candidate.producer), a.candidate.kind === "injected-control" ? chip("negative control", "warn") : a.candidate.kind === "model" ? chip("real model", "info") : chip("deterministic"), a.survived ? chip("survived", "ok") : chip(`rejected at ${a.rejectedAt}`, "bad")),
    ladder(a.level, a.survived, !a.survived),
    h("div", { class: "tiers" }, Object.entries(a.tiers).map(([t, v]) => h("span", {}, `${t} ${v.passed}/${v.total}`))),
    a.reason ? h("p", { class: "note" }, clip(a.reason, 240)) : null,
    a.candidate.explanation?.length ? h("details", {}, h("summary", { class: "note" }, "What it believes"), h("pre", {}, a.candidate.explanation.join("\n"))) : null));
  const e = run.evidence;
  return h("div", {},
    page("Experiment Lab", run.outcome),
    h("div", { class: "grid side" }, h("div", {}, h("h2", {}, "Runs"), pick),
      h("div", {},
        h("h2", {}, "Attempts"), h("div", { class: "grid" }, attempts.length ? attempts : empty(run.stage)),
        e ? h("div", {}, h("h2", {}, "Independent assessment"), h("div", { class: "card" }, h("div", { class: "row" }, chip(WORDS[e.level], e.level === "verified-in-domain" ? "ok" : "warn"), run.synthesis ? chip(run.synthesis.mode === "model" ? `Real model: ${run.synthesis.producer}` : `Deterministic: ${run.synthesis.producer}`, run.synthesis.mode === "model" ? "info" : "") : null), ladder(e.level, e.level === "verified-in-domain"), h("p", {}, e.assessment),
          h("table", {}, h("thead", {}, h("tr", {}, h("th", {}, "Oracle"), h("th", {}, "Passed"), h("th", {}, "Kind"))), h("tbody", {}, e.oracles.map((o) => h("tr", {}, h("td", {}, o.name), h("td", {}, `${o.runs - o.failures}/${o.runs}`), h("td", {}, o.valueLevel ? chip("value-level", "ok") : o.independent ? chip("independent") : chip("structural")))))),
          h("p", { class: "note" }, `Injected value faults caught: ${e.mutation.value.killed}/${e.mutation.value.total}. All faults: ${e.mutation.killed}/${e.mutation.total}.`), h("ul", {}, e.limitations.map((l) => h("li", { class: "note" }, l))))) : null,
        run.counterexamples?.length ? h("div", {}, h("h2", {}, "Counterexamples"), h("div", { class: "grid" }, run.counterexamples.slice(0, 6).map((c) => h("div", { class: "card" }, h("p", {}, c.problem), h("pre", {}, c.input))))) : null,
        h("h2", {}, "Event log"), h("div", { class: "card feed" }, events.map(liveRow)))));
};

views.vault = async () => {
  const { capabilities } = await api("/capabilities");
  if (!capabilities.length) return h("div", {}, page("Capability Vault", "Retained capabilities, with their contracts, evidence and controls."), empty("Nothing has been acquired yet."));
  const id = state.capability ?? capabilities[0].id;
  const c = await api(`/capabilities/${encodeURIComponent(id)}`);
  const list = h("div", { class: "list" }, capabilities.map((m) => h("button", { "aria-pressed": m.id === id ? "true" : "false", onclick: () => { state.capability = m.id; show("vault"); } }, h("div", { class: "mono" }, m.id), h("div", { class: "row", style: "margin-top:4px" }, statusChip(m.status), chip(`v${m.version}`)))));
  const input = h("textarea", { "aria-label": "Input for this capability", placeholder: "Input value", rows: 5 });
  const output = h("pre", {}, "Output appears here.");
  const run = h("button", { class: "primary", onclick: async () => {
    run.disabled = true;
    try {
      const r = await api(`/capabilities/${encodeURIComponent(id)}/use`, { input: input.value });
      output.textContent = `${r.output}\n\n${r.capability}@${r.version} in ${r.ms}ms${r.receipt ? `, receipt ${r.receipt.slice(0, 16)}` : ""}`;
    } catch (e) { output.textContent = `Refused: ${e.message}`; }
    run.disabled = false;
  } }, "Run in the sandbox");
  const act = (label, path, body) => h("button", { class: "quiet", onclick: async (ev) => {
    ev.target.disabled = true;
    try {
      const r = await api(`/capabilities/${encodeURIComponent(id)}/${path}`, body);
      output.textContent = JSON.stringify(r, null, 2);
      if (path === "evolve") state.view = "vault";
    } catch (e) { output.textContent = `Refused: ${e.message}`; }
    ev.target.disabled = false;
  } }, label);
  return h("div", {},
    page("Capability Vault", c.purpose),
    h("div", { class: "grid side" }, h("div", {}, h("h2", {}, "Retained"), list),
      h("div", { class: "grid" },
        h("div", { class: "card" }, h("div", { class: "row" }, statusChip(c.status), chip(WORDS[c.level], c.level === "verified-in-domain" ? "ok" : "warn"), chip(`version ${c.version}`), c.pinned ? chip(`pinned to ${c.pinned}`, "warn") : null), h("p", {}, c.assessment),
          h("table", {}, h("tbody", {}, [["Accepts", c.input.representation], ["Produces", c.output.representation], ["Domain", c.domain.join("; ")], ["Producer", `${c.provenance.producer} (${c.provenance.kind})`], ["Created", c.provenance.createdAt], ["Artefact", `${c.sourceSha256.slice(0, 24)}…, ${c.sourceBytes} bytes`], ["Permissions", `network ${c.permissions.network ? "yes" : "none"}, filesystem ${c.permissions.filesystem}, risk ${c.permissions.risk}`], ["Rejected attempts", c.rejectedAttempts]].map(([k, v]) => h("tr", {}, h("td", { class: "note" }, k), h("td", { class: "mono" }, v)))))),
        h("div", { class: "card" }, h("h3", {}, "Limitations"), h("ul", {}, c.limitations.map((l) => h("li", {}, l)))),
        h("div", { class: "card" }, h("h3", {}, "Dependencies"), c.dependencies.length ? h("table", {}, h("tbody", {}, c.dependencies.map((d) => h("tr", {}, h("td", {}, d.program ?? d.capability), h("td", {}, d.role ?? `version ${d.version}`), h("td", { class: "mono" }, d.sha256 ?? ""))))) : h("p", { class: "note" }, "None.")),
        h("div", { class: "card grid" }, h("h3", {}, "Invoke"), input, h("div", { class: "row" }, run, act("Revalidate", "revalidate", {}), act("Evolve: smaller", "evolve", { objective: "smaller" })), output),
        h("details", { class: "card" }, h("summary", {}, "Generated source"), h("pre", {}, c.source)),
        c.rejected?.length ? h("details", { class: "card" }, h("summary", {}, `${c.rejected.length} rejected attempts`), h("table", {}, h("tbody", {}, c.rejected.map((r) => h("tr", {}, h("td", {}, r.producer), h("td", {}, r.rejectedAt), h("td", { class: "note" }, clip(r.reason, 160))))))) : null)));
};

views.evolution = async () => {
  const attempts = await api("/evolution");
  if (!attempts.length) return h("div", {}, page("Evolution History", "Measured improvements and regressions across capability versions."), empty("No improvement has been attempted yet. Start one from the Capability Vault."));
  const bar = (name, value, max, unit) => h("div", { class: "bar" }, h("span", {}, name), h("div", { class: "track" }, h("div", { class: "fill", style: `width:${max ? Math.max(2, Math.round((value / max) * 100)) : 0}%` })), h("span", {}, `${value}${unit}`));
  const kinds = { promoted: "ok", regressed: "bad", "no-improvement": "warn", invalid: "bad" };
  return h("div", {},
    page("Evolution History", "Every attempt stays on record. A version is promoted only if it passes everything its predecessor passed and shows a measured improvement."),
    h("div", { class: "grid" }, attempts.slice().reverse().map((a) => h("div", { class: "card" },
      h("div", { class: "row" }, h("strong", { class: "mono" }, `${a.capability}@${a.fromVersion}`), chip(`objective: ${a.objective}`), a.promoted ? chip(`promoted to version ${a.promoted}`, "ok") : chip("no promotion", "warn")),
      h("p", { class: "note" }, a.outcome),
      a.candidates.map((c) => {
        const max = Math.max(a.baseline.bytes, c.measured?.bytes ?? 0);
        return h("div", { style: "margin-top:10px" }, h("div", { class: "row" }, chip(c.outcome, kinds[c.outcome]), h("span", { class: "note" }, `${c.producer}: ${clip(c.reason, 150)}`)),
          c.measured ? h("div", {}, bar("before", a.baseline.bytes, max, " B"), bar("after", c.measured.bytes, max, " B"), h("p", { class: "note" }, `median ${a.baseline.medianMs}ms to ${c.measured.medianMs}ms; peak ${a.baseline.peakRssKb} to ${c.measured.peakRssKb} KiB`)) : null);
      })))));
};

const NAV = [["universe", "Capability Universe"], ["workspace", "Invention Workspace"], ["map", "Missing Capability Map"], ["lab", "Experiment Lab"], ["vault", "Capability Vault"], ["evolution", "Evolution History"]];
document.getElementById("nav").replaceChildren(...NAV.map(([id, label]) => h("button", { "data-view": id, onclick: () => show(id) }, label)));

async function health() {
  const s = await api("/state");
  document.getElementById("health").replaceChildren(
    h("div", {}, h("b", {}, s.model ? `${s.model.model}` : "No model"), s.model ? s.model.provider : "Deterministic synthesis only"),
    h("div", {}, h("b", {}, `Generated code: ${s.boundary.backend}`), `Programs: ${s.programSandbox ?? "no sandbox"}`));
}

const events = new EventSource("/api/events");
events.onmessage = (m) => {
  const e = JSON.parse(m.data);
  if (e.run === state.run) {
    state.live.push(e);
    renderFeed();
  }
  if (e.type === "run.finished") {
    health();
    if (state.view === "universe") show("universe");
  }
};

health();
show("universe");
