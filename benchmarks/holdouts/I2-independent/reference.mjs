// P (tally ledger) -> Q (settlement sheet)
const SEC = { S: 'STALLS', C: 'CIRCLE', B: 'BALCONY', X: 'BOX' };
const CH = { C: 'card', K: 'cash', W: 'online', F: 'comp' };
export function adapter(pText) {
  const lines = pText.split('\n').filter(l => l.trim() !== '');
  if (lines[0] !== '#P1') throw new Error('not P');
  const out = ['BOXOFFICE 1'];
  let gross = 0;
  for (const l of lines.slice(1)) {
    const r = Object.fromEntries(l.split(';').map(kv => kv.split('=')));
    const dt = new Date(Date.UTC(2020, 0, 1) + Number(r.d) * 86400000);
    const date = dt.toISOString().slice(0, 10);
    const p = Number(r.p), q = Number(r.q);
    gross += p * q;
    const unit = `${Math.floor(p / 100)}.${String(p % 100).padStart(2, '0')}`;
    out.push(`@${date} ${SEC[r.s]} x${q} ${unit} ${CH[r.c]}`);
  }
  out.push(`TOTAL ${out.length - 1} ${Math.floor(gross / 100)}.${String(gross % 100).padStart(2, '0')}`);
  return out.join('\n') + '\n';
}
