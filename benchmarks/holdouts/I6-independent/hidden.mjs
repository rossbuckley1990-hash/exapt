const ROUTES = [
  ['Ullapool', 'Stornoway', 'Loch Seaforth', 170, 6.5, 1300],
  ['Tarbert', 'Lochmaddy', 'Hebrides', 90, 2.2, 850],
  ['Lymington', 'Yarmouth', 'Wight Sun', 80, 1.1, 1700],
  ['Portsmouth', 'Ryde', 'Fastcat Solent', 35, 3, 2400],
  ['Oban', 'Craignure', 'Isle of Mull', 50, 1, 1260],
  ['Largs', 'Millport', 'Cumbrae Maid', 15, 0.8, 360],
  ['Mallaig', 'Armadale', 'Coruisk', 75, 0.5, 495],
];
const MON = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
function rng(seed) { let s = seed >>> 0; return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32); }
function gen(seed, count) {
  const r = rng(seed), pick = a => a[Math.floor(r() * a.length)];
  const lines = ['# generated schedule ' + seed];
  for (let i = 0; i < count; i++) {
    const [a, b, v, base, , cap] = pick(ROUTES);
    const [from, to] = r() < 0.5 ? [a, b] : [b, a];
    const mins = base + Math.floor(r() * 20) - 5 + (r() < 0.1 ? 7 * 60 : 0);
    const dur = r() < 0.5 && mins % 60 === 0 ? `${mins / 60}h`
      : mins >= 60 && r() < 0.6 ? `${Math.floor(mins / 60)}h ${mins % 60}m` : `${mins} min`;
    const h = 1 + Math.floor(r() * 12), mi = Math.floor(r() * 60);
    const fareP = Math.floor(r() * 4000) + 200;
    const fare = r() < 0.2 ? `£${Math.floor(fareP / 100)}` : `£${Math.floor(fareP / 100)}.${String(fareP % 100).padStart(2, '0')}`;
    const day = 1 + Math.floor(r() * 28), mon = pick(MON);
    lines.push(`${day} ${mon} ${2026 + Math.floor(r() * 2)} | ${from} -> ${to} | ${r() < 0.7 ? 'MV ' : ''}${v} | dep ${h}:${String(mi).padStart(2, '0')}${r() < 0.5 ? 'am' : 'pm'} | ${dur} | ${fare} | ${cap - Math.floor(r() * 5) * 10} pax`);
  }
  return lines.join('\n') + '\n';
}
export function inputs() {
  return [8, 12, 17, 23, 31, 40].map((n, i) => gen(1000 + i * 77, n));
}
