export function adapter(pText) {
  const lines = pText.split('\n').filter(l => l.length);
  if (lines[0] !== '#ferrysched/1') throw new Error('not ferrysched/1');
  const out = ['FERRYFEED 2 GBP'];
  const p2 = n => String(n).padStart(2, '0');
  for (const l of lines.slice(1)) {
    const [t, date, from, to, dep, dur, fare, cap, vessel] = l.split(':');
    if (t !== 'S') throw new Error('bad record: ' + l);
    const d = `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`;
    const time = `${p2(Math.floor(dep / 60))}:${p2(dep % 60)}`;
    const f = `${Math.floor(fare / 100)}.${p2(fare % 100)}`;
    out.push(`sailing ${d} ${time} ${from}>${to} dur=${dur * 5} fare=${f} seats=${cap} vessel="${vessel}"`);
  }
  out.push(`END ${out.length - 1}`);
  return out.join('\n') + '\n';
}
