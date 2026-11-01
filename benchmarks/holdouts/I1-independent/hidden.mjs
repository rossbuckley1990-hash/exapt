let s = 7;
const rnd = () => (s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296;
const pick = (a) => a[Math.floor(rnd() * a.length)];
const p2 = (n) => String(n).padStart(2, '0');
function one(stas, chans, phases, base, n, ampMax) {
  const rows = [];
  for (let i = 0; i < n; i++) {
    const t = base + Math.floor(rnd() * 3 * 3600 * 1000) + (i % 4 === 0 ? 0 : 0);
    rows.push(t);
  }
  rows.sort((a, b) => a - b);
  return rows.map((t) => {
    const d = new Date(t);
    const date = `${d.getUTCFullYear()}${p2(d.getUTCMonth() + 1)}${p2(d.getUTCDate())}`;
    const hms = `${p2(d.getUTCHours())}${p2(d.getUTCMinutes())}${p2(d.getUTCSeconds())}.${p2(Math.floor(d.getUTCMilliseconds() / 10))}`;
    const per = (0.05 + rnd() * 6).toFixed(2);
    return `${pick(stas)} ${pick(chans)} ${date} ${hms} ${pick(phases)} ${1 + Math.floor(rnd() * ampMax)} ${per} ${Math.floor(rnd() * 5)}`;
  }).join('\n') + '\n';
}
export function inputs() {
  return [
    one(['ANMO', 'COR', 'YKA'], ['BHZ', 'BHN'], ['P', 'S'], Date.UTC(2023, 11, 31, 22, 30), 12, 40000),
    one(['SNZO', 'MAJO'], ['HHZ', 'HHE', 'HHN'], ['Pn', 'Sn', 'P'], Date.UTC(2024, 1, 28, 23, 0), 25, 900),
    one(['KBS', 'ESK', 'TLY', 'HRV'], ['BHZ'], ['Pg', 'Sg', 'P', 'S'], Date.UTC(2020, 1, 29, 21, 45), 40, 250000),
    one(['PAB', 'RER'], ['LHZ', 'LHN'], ['P', 'Pn'], Date.UTC(2025, 6, 4, 8, 15), 8, 12),
    one(['TSUM', 'KIP', 'ULN', 'BJT', 'LSA'], ['BHZ', 'BHE'], ['P', 'S', 'Pg', 'Sn'], Date.UTC(2022, 2, 13, 10, 0), 33, 7000),
    one(['SPA', 'VNDA'], ['BHZ', 'SHZ'], ['S', 'Sg'], Date.UTC(2021, 11, 31, 22, 59), 18, 1500000),
  ];
}
