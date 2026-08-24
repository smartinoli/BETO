#!/usr/bin/env node
/* ============================================================
   ITF-MERCADO — ¿esta ronda la cotiza el mercado por nivel?

   La prueba que decidimos el 2026-08-24, y que va ANTES de mirar
   ningun partido en particular. No necesita resultados: solo cuotas y
   WTN. Ajusta la curva del mercado (logit de la probabilidad desvigada
   contra el ΔWTN) sobre las cuotas de cada grupo de rondas y la compara
   con la nuestra, cuya pendiente es 0.273.

     Q1      pendiente 0.227, R²=0.406  → cotiza por nivel, competimos
     Q2/R1   pendiente 0.012, R²=0.001  → no sigue el nivel, afuera
     finales pendiente -0.058           → cotiza al reves, afuera

   El sentido: en Q1 nadie ha jugado y el mercado solo tiene ranking,
   igual que nosotros. En Q2 ya los vio jugar y deja de usar el nivel —
   y cuando se aparta, acierta el. Por eso la pendiente de su curva
   funciona como semaforo: si se parece a la nuestra estamos mirando lo
   mismo; si es plana, el precio lleva informacion que no tenemos.

   Uso:  node vigia/itf-mercado.mjs
   ============================================================ */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pNivel, normRonda, GRUPO } from './itf-reglas.mjs';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const DATOS = path.join(DIR, 'datos', 'itf');
const norm = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z ]/g, ' ').replace(/\s+/g, ' ').trim();
const tok = s => new Set(norm(s).split(' ').filter(x => x.length >= 3));
const calza = (a, b) => { const A = tok(a), B = tok(b); let c = 0; for (const x of A) if (B.has(x)) c++;
  return c >= 1 && c >= Math.min(A.size, B.size) - 1; };
const leer = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')) } catch { return null } };

const mapa = leer(path.join(DATOS, 'torneos.json')) || {};
const claves = {};
for (const ts of Object.values(mapa.semanas || {})) for (const [k, t] of Object.entries(ts)) claves[t.nombre] = k;
for (const [k, t] of Object.entries(mapa.torneos || {})) claves[t.nombre] = k;

const CORTA = { '1st Round': 'R1', '2nd Round': 'R2', '3rd Round': 'R3', 'Quarter-finals': 'QF',
  'Quarter-final': 'QF', 'Semi-finals': 'SF', 'Semi-final': 'SF', 'Final': 'F' };
const etapaDe = (ev, r) => { const c = CORTA[r] || r;
  return ev === 'Q' ? (c === 'R1' ? 'Q1' : c === 'R2' ? 'Q2' : c === 'R3' ? 'Q3' : 'Q·' + c) : c; };

/* ---------- indice de partidos (jugados o no) con ficha de nivel ---------- */
const archivos = [];
for (const f of fs.readdirSync(DATOS))
  if (f.endsWith('.json') && !f.includes('aceptacion') && !f.includes('torneos')) archivos.push([f.replace('.json', ''), path.join(DATOS, f)]);
for (const f of fs.readdirSync(path.join(DATOS, 'vivo'))) archivos.push([f.replace('.json', ''), path.join(DATOS, 'vivo', f)]);

const idx = [];
for (const [clave, a] of archivos) {
  if (!clave.startsWith('m-itf')) continue;
  const j = leer(a); if (!j?.cuadros) continue;
  let F = null;
  const acc = leer(path.join(DATOS, clave + '.aceptacion.json'));
  if (acc) { F = new Map();
    for (const [sec, arr] of Object.entries(acc.secciones || {})) for (const p of arr) F.set(norm(p.nombre), { ...p, seccion: sec }); }
  for (const [ev, c] of Object.entries(j.cuadros)) {
    if (!c?.rondas) continue;
    for (const r of c.rondas) for (const m of r.partidos) {
      const L = m.lados;
      if (!L || L.length !== 2 || !L[0].nombre || !L[1].nombre) continue;
      idx.push({ clave, ev, etapa: etapaDe(ev, r.nombre), m, L, F });
    }
  }
}
function ficha(F, n) {
  if (!F) return null;
  const k = norm(n); if (F.has(k)) return F.get(k);
  const t = k.split(' ').filter(x => x.length >= 3); if (!t.length) return null;
  for (const [kk, v] of F) { const tt = new Set(kk.split(' '));
    if (t.filter(x => tt.has(x)).length >= Math.min(2, t.length)) return v; }
  return null;
}

/* ---------- cruzar cuotas con partidos ---------- */
const doc = leer(path.join(DIR, 'itf-cuotas-manuales.json')) || { cuotas: [] };
const pts = [], sinCalzar = [];
for (const q of doc.cuotas) {
  const clave = claves[q.torneo.replace(/\s*\(qualis\)\s*/, '')];
  const cand = idx.filter(e => (!clave || e.clave === clave) &&
    ((calza(e.L[0].nombre, q.p1) && calza(e.L[1].nombre, q.p2)) ||
     (calza(e.L[0].nombre, q.p2) && calza(e.L[1].nombre, q.p1))));
  if (cand.length !== 1) { sinCalzar.push(q); continue; }
  const e = cand[0];
  const i1 = calza(e.L[0].nombre, q.p1) ? 0 : 1;
  const fi = [0, 1].map(i => ficha(e.F, e.L[i].nombre));
  if (!fi[0] || !fi[1] || fi[0].wtn == null || fi[1].wtn == null || fi[0].wtn === fi[1].wtn) continue;
  const cuota = [0, 1].map(i => i === i1 ? q.g1 : q.g2);
  const k = fi[0].wtn < fi[1].wtn ? 0 : 1;
  const iw = e.L.findIndex(x => x.ganador);
  pts.push({ clave, torneo: q.torneo, etapa: e.etapa, grupo: GRUPO[normRonda(e.etapa)] || 'medias',
    d: Math.abs(fi[0].wtn - fi[1].wtn),
    mkt: (1 / cuota[k]) / ((1 / cuota[k]) + (1 / cuota[1 - k])),
    vig: (1 / cuota[0] + 1 / cuota[1]) - 1,
    cuota: cuota[k], favorito: e.L[k].nombre, rival: e.L[1 - k].nombre,
    seed: e.L[k].seed ?? null, entradaRival: e.L[1 - k].entrada || null,
    nuestra: pNivel(Math.abs(fi[0].wtn - fi[1].wtn), e.etapa, false).p,
    jugado: e.m.estado === 'jugado',
    gano: (e.m.estado === 'jugado' && iw >= 0) ? iw === k : null });
}

const lg = p => Math.log(p / (1 - p));
function curva(a) {
  if (a.length < 5) return null;
  const n = a.length, mx = a.reduce((s, x) => s + x.d, 0) / n, my = a.reduce((s, x) => s + lg(x.mkt), 0) / n;
  const sxx = a.reduce((s, x) => s + (x.d - mx) ** 2, 0);
  if (sxx < 1e-9) return null;
  const b = a.reduce((s, x) => s + (x.d - mx) * (lg(x.mkt) - my), 0) / sxx, i = my - b * mx;
  const ss = a.reduce((s, x) => s + (lg(x.mkt) - my) ** 2, 0);
  const rs = a.reduce((s, x) => s + (lg(x.mkt) - (i + b * x.d)) ** 2, 0);
  return { i, b, r2: ss > 0 ? 1 - rs / ss : 0, n, dMin: Math.min(...a.map(x => x.d)), dMax: Math.max(...a.map(x => x.d)) };
}
const T = (s, n) => String(s ?? '').slice(0, n).padEnd(n);
const veredicto = c => c.b >= 0.12 && c.r2 >= 0.25 ? 'cotiza por nivel: competimos'
  : c.b < 0 ? 'cotiza AL REVÉS del nivel: afuera' : 'no sigue el nivel: afuera';

console.log(`cuotas ${doc.cuotas.length} · cruzadas con WTN ${pts.length} · sin calzar ${sinCalzar.length}`);
console.log(`vig medio de Betano: ${(100 * pts.reduce((s, x) => s + x.vig, 0) / pts.length).toFixed(1)}%\n`);
console.log('¿EL MERCADO COTIZA POR NIVEL? — nuestra pendiente sobre Δ es 0.273');
for (const g of ['Q1', 'buenas', 'medias', 'finales']) {
  const a = pts.filter(x => x.grupo === g);
  const c = curva(a);
  const et = g === 'buenas' ? 'buenas (Q2,R1)' : g === 'medias' ? 'medias (Q3,R2)' : g === 'finales' ? 'finales (QF,SF,F)' : 'Q1';
  if (!c) { console.log(`  ${T(et, 18)} n=${a.length} — faltan cuotas`); continue; }
  console.log(`  ${T(et, 18)} logit p = ${c.i.toFixed(3)} ${c.b >= 0 ? '+' : '−'} ${Math.abs(c.b).toFixed(3)}·Δ   R²=${c.r2.toFixed(3)}  n=${c.n}  Δ ${c.dMin.toFixed(1)}-${c.dMax.toFixed(1)}   ${veredicto(c)}`);
}
/* R1 aparte: es la ronda que estamos evaluando */
const r1 = pts.filter(x => x.etapa === 'R1'), c1 = curva(r1);
if (c1) {
  console.log(`\nSOLO R1 DEL CUADRO PRINCIPAL (la ronda en evaluación)`);
  console.log(`  logit p = ${c1.i.toFixed(3)} ${c1.b >= 0 ? '+' : '−'} ${Math.abs(c1.b).toFixed(3)}·Δ   R²=${c1.r2.toFixed(3)}  n=${c1.n}   ${veredicto(c1)}`);
  const sinJugar = r1.filter(x => !x.jugado);
  console.log(`  ${sinJugar.length} de ${r1.length} todavía sin jugar`);
}
console.log('\nR1 PARTIDO A PARTIDO — nuestro favorito por WTN contra el precio');
console.log('  torneo            Δ WTN   nosotros  mercado   cuota   dif    favorito (rival)');
for (const x of r1.sort((a, b) => (a.nuestra - a.mkt) - (b.nuestra - b.mkt))) {
  const dif = x.nuestra - x.mkt;
  console.log(`  ${T(x.torneo, 17)} ${x.d.toFixed(2).padStart(5)}   ${(100 * x.nuestra).toFixed(0).padStart(6)}%  ` +
    `${(100 * x.mkt).toFixed(0).padStart(6)}%  ${String(x.cuota).padStart(6)}  ${((dif >= 0 ? '+' : '') + (100 * dif).toFixed(0) + 'pt').padStart(6)}   ` +
    `${T(x.favorito + (x.seed ? ` [${x.seed}]` : ''), 26)} (${x.rival}${x.entradaRival && x.entradaRival !== 'DA' ? ' ' + x.entradaRival : ''})`);
}
if (sinCalzar.length) {
  console.log('\nCUOTAS QUE NO CALZAN CON NINGÚN CUADRO EN DISCO');
  for (const q of sinCalzar) console.log(`  ${T(q.torneo, 20)} ${q.p1} vs ${q.p2}`);
}
fs.writeFileSync(path.join(DIR, 'itf-mercado.json'), JSON.stringify({ generado: new Date().toISOString(), puntos: pts }, null, 1));
console.log('\n→ vigia/itf-mercado.json');
