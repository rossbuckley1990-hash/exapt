export function inputs() {
  let s = 12345;
  const r = n => { s = (s * 1103515245 + 12345) % 2147483648; return s % n; };
  const Q = ['seen', 'seen', 'seen', 'eggs', 'absent'];
  const out = [];
  for (let k = 0; k < 6; k++) {
    const n = 8 + r(33);
    const year = [2023, 2024, 2025, 2026, 2024, 2022][k];
    const lines = [];
    for (let i = 0; i < n; i++) {
      const t = Date.UTC(year, 2, 1) + r(240) * 864e5;
      const date = new Date(t).toISOString().slice(0, 10);
      const hive = 'ABCNW'[r(5)] + (1 + r(40));
      const samp = [100, 200, 300, 250][r(4)];
      lines.push(`${date}  ${hive}  queen: ${Q[r(5)]}  brood: ${r(13)}  temp: ${28 + r(95) / 10}${r(10) ? '' : ''}C  weight: ${(18 + r(550) / 10).toFixed(1)}kg  mites: ${r(Math.floor(samp / 10))}/${samp}`);
    }
    out.push('# inspections batch ' + (k + 1) + '\n' + lines.join('\n') + '\n');
  }
  return out;
}
