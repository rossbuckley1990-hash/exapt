// P (SBP1) -> Q (SEISQ/2)
export function adapter(pText) {
  const lines = pText.split('\n').filter((l) => l.trim());
  if (lines[0] !== '#SBP1') throw new Error('not SBP1');
  const out = ['SEISQ/2'];
  let n = 0;
  for (const l of lines.slice(1)) {
    const m = /^(\S+)\.(\w{3})\s+(\d{4})-(\d{3})T(\d\d):(\d\d):(\d\d)\.(\d{3})\s+(\S+)\s+(\d+)ct\s+(\S+)s\s+q([0-4])$/.exec(l);
    if (!m) throw new Error('bad P line: ' + l);
    const [, sta, ch, y, doy, hh, mm, ss, ms, ph, cnt, per, q] = m;
    // GPS time -> UTC (18 s leap offset), day-of-year -> epoch ms
    const gps = Date.UTC(+y, 0, +doy, +hh, +mm, +ss, +ms);
    const utc = gps - 18000;
    const amp = (+cnt * 0.61).toFixed(1);       // counts -> nm
    const freq = (1 / +per).toFixed(3);         // period s -> Hz
    const wt = (4 - +q) * 25;                   // quality 0..4 -> weight %
    out.push([sta, ch, utc, ph, amp, freq, wt].join('\t'));
    n++;
  }
  out.push('END\t' + n);
  return out.join('\n') + '\n';
}
