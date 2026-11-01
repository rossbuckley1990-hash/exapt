// Six further raw inputs in the tally log format (deterministic)
const MON = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const SECS = ['Stalls', 'Dress Circle', 'Balcony', 'Boxes'];
const CHS = ['card', 'cash', 'web', 'comp'];
const PRICES = ['12.50', '18', '£22.00', '27.5', '35.00', '48.00', '65', '£85.00', '9.99', '120.00'];
export function inputs() {
  let seed = 20261101;
  const rnd = (n) => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed % n; };
  const counts = [8, 14, 22, 30, 40, 17];
  const years = [2026, 2027, 2028, 2024, 2031, 2020];
  return counts.map((n, k) => {
    const lines = [];
    if (k % 2) lines.push('# late season run');
    for (let i = 0; i < n; i++) {
      const ch = CHS[rnd(4)];
      const price = ch === 'comp' ? '0.00' : PRICES[rnd(PRICES.length)];
      const day = 1 + rnd(28), mon = MON[rnd(12)];
      const qty = rnd(7) === 0 ? 100 + rnd(400) : 1 + rnd(9);
      lines.push(`${day} ${mon} ${years[k]} | ${SECS[rnd(4)]} | ${qty} | ${price} | ${ch}`);
      if (i % 11 === 5) lines.push('');
    }
    return lines.join('\n') + '\n';
  });
}
