const MON = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const VAR = ['Syrah','Viognier','Grenache','Tempranillo','Sangiovese','Riesling','Petit Verdot','Chenin Blanc','Malbec','Pinot Gris','Zinfandel','Mourvedre'];
const BLK = ['A1','A4','B2','B9','D3','E6','F12','G5','H8','J2'];
function rng(s) { return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }
function one(seed, n) {
  const r = rng(seed), rows = [];
  for (let i = 0; i < n; i++) {
    const day = 1 + Math.floor(r() * 28), mon = 7 + Math.floor(r() * 3);
    const lb = 400 + Math.floor(r() * 14000);
    const w = lb >= 1000 ? String(lb).replace(/\B(?=(\d{3})+$)/g, ',') : String(lb);
    rows.push(`${day} ${MON[mon]} 2026; ${BLK[Math.floor(r() * BLK.length)]}; ${VAR[Math.floor(r() * VAR.length)]}; ${w} lb; ${(17 + r() * 11).toFixed(1)} Bx; ${50 + Math.floor(r() * 45)}F`);
  }
  if (n > 9) rows.splice(3, 0, '# repeat delivery', rows[2].replace(/\d+(,\d+)? lb/, '910 lb'));
  return rows.join('\n') + '\n';
}
export function inputs() { return [8, 12, 20, 26, 32, 38].map((n, i) => one(1000 + i * 77, n)); }
