export function adapter(pText) {
  const L = pText.split('\n').filter(x => x !== '');
  if (L[0] !== 'BKP1') throw new Error('bad P');
  const QN = { S: 'seen', E: 'eggs', N: 'absent' };
  const rows = L.slice(1).map(l => {
    const [hive, yd, q, brood, t, oz, mites] = l.split(';');
    const [y, doy] = yd.split('.');
    const date = new Date(Date.UTC(+y, 0, +doy)).toISOString().slice(0, 10);
    const tempF = ((Math.round(+t * 9 / 5) + 320) / 10).toFixed(1);
    const kg = (+oz * 0.028349523).toFixed(1);
    const [c, s] = mites.split(':').map(Number);
    return [hive, date, QN[q], brood, tempF, kg, (c / s * 100).toFixed(2)].join('\t');
  });
  return ['HQ2', 'hive\tdate\tqueen\tbrood\ttemp_f\tweight_kg\tmites_per_100', ...rows, `#${rows.length}`].join('\n') + '\n';
}
