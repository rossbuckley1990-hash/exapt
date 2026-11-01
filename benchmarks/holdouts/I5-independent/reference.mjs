export function adapter(pText) {
  const lines = pText.split('\n').filter(l => l !== '');
  if (lines[0] !== '#QSOPACK 1') throw new Error('bad P header');
  const out = ['QSLAUDIT/2'];
  let n = 0;
  for (const l of lines.slice(1)) {
    if (l.startsWith('END ')) continue;
    const f = l.split(' ');
    const [, call, ydoy, sec, khz, mode, rs, rr, dbm] = f;
    const name = f.slice(9).join(' ');
    const [y, doy] = ydoy.split(':').map(Number);
    const day = new Date(Date.UTC(y, 0, doy));
    const s = +sec;
    const hh = String(Math.floor(s / 3600)).padStart(2, '0');
    const mm = String(Math.floor(s % 3600 / 60)).padStart(2, '0');
    const ss = String(s % 60).padStart(2, '0');
    const watts = Math.round(Math.pow(10, parseFloat(dbm) / 10) / 1000);
    out.push('[contact]', `call=${call}`, `when=${day.toISOString().slice(0, 10)}T${hh}:${mm}:${ss}Z`,
      `mhz=${(+khz / 1000).toFixed(3)}`, `mode=${mode}`, `rst=${rs}/${rr}`, `watts=${watts}`, `op="${name}"`, '[end]');
    n++;
  }
  out.push(`[total ${n}]`);
  return out.join('\n') + '\n';
}
