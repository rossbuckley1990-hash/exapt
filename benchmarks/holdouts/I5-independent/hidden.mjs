let seed = 20261101;
const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
const pick = (a) => a[Math.floor(rnd() * a.length)];
const pad = (n, w = 2) => String(n).padStart(w, '0');
const bands = [[1.8,1.99],[3.5,3.99],[5.35,5.40],[7.0,7.29],[10.11,10.14],[14.0,14.34],[18.07,18.16],[21.0,21.44],[24.9,24.98],[28.0,29.69],[50.1,53.9],[144.0,147.9],[432.0,449.9]];
const names = ['Marta','Kenji','Olu','Priya','Sven','Dmitri','Ana','Tom','Leila','Hugo','Mary Ann','Jean-Luc','Ravi','Ingrid'];
const pw = [1,2,5,10,15,20,30,50,75,100,150,200,400,600,1000,1500];
const pre = ['W','K','N','VE','G','DL','JA','VK','ZL','F','EA','PY','OH','SP'];
const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
function call() {
  let s = pick(pre) + Math.floor(rnd() * 10);
  const k = 1 + Math.floor(rnd() * 3);
  for (let i = 0; i < k; i++) s += letters[Math.floor(rnd() * 26)];
  return s;
}
function one(years) {
  const n = 8 + Math.floor(rnd() * 33);
  const out = ['# station log'];
  for (let i = 0; i < n; i++) {
    const y = pick(years), doy = 1 + Math.floor(rnd() * (y % 4 === 0 ? 366 : 365));
    const d = new Date(Date.UTC(y, 0, doy)).toISOString().slice(0, 10);
    const [lo, hi] = pick(bands);
    const mhz = (lo + rnd() * (hi - lo)).toFixed(3);
    const mode = pick(['SSB','SSB','CW','FM','AM','RTTY','CW']);
    const w = (mode === 'CW' || mode === 'RTTY') ? 3 : 2;
    const rp = () => w === 2 ? `${1 + Math.floor(rnd() * 5)}${1 + Math.floor(rnd() * 9)}` : `${1 + Math.floor(rnd() * 5)}${1 + Math.floor(rnd() * 9)}${pick([9,9,8,7])}`;
    out.push(`${d} ${pad(Math.floor(rnd() * 24))}:${pad(Math.floor(rnd() * 60))} ${call()} ${mhz} ${mode} ${rp()} ${rp()} ${pick(pw)} ${pick(names)}`);
    if (i % 9 === 4) out.push('');
  }
  return out.join('\n') + '\n';
}
export function inputs() {
  return [[2019],[2020,2024],[2023,2025],[2021,2022],[2024],[2016,2026]].map(one);
}
