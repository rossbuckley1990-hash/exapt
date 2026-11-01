export function adapter(pText) {
  const lines = pText.split('\n');
  if (lines[0] !== '%% harvest-p1') throw new Error('not harvest-p1');
  const recs = [];
  let cur = null;
  for (const l of lines.slice(1)) {
    if (l === '%%') { cur = {}; recs.push(cur); continue; }
    if (!l) continue;
    const k = l.indexOf(': ');
    cur[l.slice(0, k)] = l.slice(k + 2);
  }
  let out = 'CRUSHLEDGER 2\n', total = 0;
  for (const r of recs) {
    const [d, m, y] = r.date.split('/');
    const kg = Math.round(parseFloat(r.weight) * 0.45359237);
    const bx = parseFloat(r.sugar);
    const sg = 1 + bx / (258.6 - (bx / 258.2) * 227.1);
    const oe = Math.round((sg - 1) * 1000);
    const tc = ((parseFloat(r.temp) - 32) * 5 / 9).toFixed(1);
    const v = r.variety.toUpperCase().replace(/[^A-Z]+/g, '_');
    total += kg;
    out += `LOT ${r.lot} @ ${y}-${m}-${d} :: blk=${r.block.toUpperCase()} var=${v} kg=${kg} oe=${oe} tc=${tc}\n`;
  }
  return out + `END ${recs.length} kg=${total}\n`;
}
