#!/usr/bin/env node
/* ============================================================
   ITF-BACKTEST — todo el histórico en disco, ronda por ronda.

   Reconstruye cada partido JUGADO de todos los cuadros guardados y mide
   qué señal acierta en cada ronda exacta (Q1, Q2, Q3, R1, R2, R3, QF,
   SF, F), no en el grupo grueso "temprano/tarde" que usábamos.

   Mide cinco señales sobre el mismo partido, para poder compararlas:
     WTN · ATP · ITF · ranking nacional · edad (el más joven)
   más la forma (games cedidos) y la marca de entrada (seed, Q, WC, JR).

   Los datos de nivel salen SIEMPRE de la entry list del propio torneo:
   el índice global produce falsos positivos con homónimos.

   Escribe vigia/itf-backtest.json con todo el detalle.
   Uso:  node vigia/itf-backtest.mjs
   ============================================================ */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gamesCedidos, setsCedidos } from './itf-reglas.mjs';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const DATOS = path.join(DIR, 'datos', 'itf');
const norm = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z ]/g, ' ').replace(/\s+/g, ' ').trim();

/* ficha por torneo: nunca del índice global */
function fichas(clave) {
  const f = path.join(DATOS, clave + '.aceptacion.json');
  if (!fs.existsSync(f)) return null;
  let j; try { j = JSON.parse(fs.readFileSync(f, 'utf8')) } catch { return null }
  const m = new Map();
  for (const [sec, arr] of Object.entries(j.secciones || {}))
    for (const p of arr) m.set(norm(p.nombre), {
      wtn: p.wtn, atp: p.atp, itf: p.itf, nac: p.nacional, nacido: p.nacido,
      jr: sec === 'JR', seccion: sec, wtnVisible: p.wtnVisible !== false,
    });
  return m;
}
function busca(m, n) {
  const k = norm(n); if (m.has(k)) return m.get(k);
  const t = k.split(' ').filter(x => x.length >= 3);
  if (!t.length) return null;
  for (const [kk, v] of m) {
    const tt = new Set(kk.split(' '));
    if (t.filter(x => tt.has(x)).length >= Math.min(2, t.length)) return v;
  }
  return null;
}

/* nombre corto y canónico de la ronda, desde el cuadro oficial */
const CORTA = { '1st Round': 'R1', '2nd Round': 'R2', '3rd Round': 'R3', '4th Round': 'R4',
  'Quarter-finals': 'QF', 'Quarter-final': 'QF', 'Semi-finals': 'SF', 'Semi-final': 'SF', 'Final': 'F' };
const rondaDe = (ev, nombre) => {
  const c = CORTA[nombre] || nombre;
  return ev === 'Q' ? (c === 'R1' ? 'Q1' : c === 'R2' ? 'Q2' : c === 'R3' ? 'Q3' : 'Q·' + c) : c;
};
/* trayectoria previa de un jugador DENTRO del mismo cuadro, para la forma
   con la que llegaba a ESE partido (no la del torneo completo) */
function formaPrevia(nombre, cuadros, hastaEv, hastaRonda) {
  const pasos = [];
  for (const [ev, c] of Object.entries(cuadros)) {
    for (const r of c.rondas || []) {
      if (ev === hastaEv && r.numero >= hastaRonda) continue;
      if (ev === 'M' && hastaEv === 'Q') continue;
      for (const p of r.partidos) {
        if (p.estado !== 'jugado') continue;
        const i = p.lados.findIndex(l => l.nombre && norm(l.nombre) === norm(nombre));
        if (i < 0) continue;
        const yo = p.lados[i], ri = p.lados[1 - i];
        pasos.push(yo.sets.map((s, k) => s + '-' + (ri.sets[k] ?? '?')).join(' '));
      }
    }
  }
  return pasos.join(' · ');
}

/* ---------- recolectar ---------- */
const archivos = [];
for (const f of fs.readdirSync(DATOS))
  if (f.endsWith('.json') && !f.includes('aceptacion') && !f.includes('torneos')) archivos.push(path.join(DATOS, f));
for (const f of fs.readdirSync(path.join(DATOS, 'vivo'))) archivos.push(path.join(DATOS, 'vivo', f));

const filas = [];
for (const arch of archivos) {
  const clave = path.basename(arch).replace('.json', '');
  if (!clave.startsWith('m-itf')) continue;              // solo hombres
  const F = fichas(clave); if (!F) continue;
  let j; try { j = JSON.parse(fs.readFileSync(arch, 'utf8')) } catch { continue }
  const cuadros = j.cuadros || j;
  const meta = j.categoria ? { categoria: j.categoria, superficie: j.superficie } : {};
  for (const [ev, c] of Object.entries(cuadros)) {
    if (!c || !c.rondas) continue;
    for (const r of c.rondas) for (const p of r.partidos) {
      if (p.estado !== 'jugado') continue;
      const ret = /retired|walkover/i.test(p.nota || '');
      const L = p.lados; if (!L || L.length !== 2 || !L[0].nombre || !L[1].nombre) continue;
      const iw = L.findIndex(x => x.ganador); if (iw < 0) continue;
      const a = busca(F, L[0].nombre), b = busca(F, L[1].nombre);
      if (!a || !b) continue;
      const tray = [0, 1].map(i => formaPrevia(L[i].nombre, cuadros, ev, r.numero));
      const forma = tray.map(gamesCedidos), sets = tray.map(setsCedidos);
      filas.push({
        clave, ...meta, evento: ev, ronda: rondaDe(ev, r.nombre), retiro: ret, ganador: iw,
        lados: [0, 1].map(i => ({
          nombre: L[i].nombre, seed: L[i].seed ?? null, entrada: L[i].entrada || null,
          wtn: [a, b][i].wtn, atp: [a, b][i].atp, itf: [a, b][i].itf,
          nac: [a, b][i].nac, nacido: [a, b][i].nacido, jr: [a, b][i].jr, forma: forma[i], sets: sets[i],
        })),
      });
    }
  }
}

/* ---------- medir cada señal ----------
   Una señal "opina" solo cuando tiene los dos datos y no empata. */
const ANIO = 2026;
const SEÑALES = {
  WTN: l => [l[0].wtn, l[1].wtn], /* menor es mejor */
  ATP: l => [l[0].atp, l[1].atp],
  ITF: l => [l[0].itf, l[1].itf],
  'rank país': l => [l[0].nac, l[1].nac],
  'forma': l => [l[0].forma, l[1].forma],
  'más joven': l => [l[0].nacido, l[1].nacido].map(n => n ? ANIO - n : null),
  'sembrado': l => [l[0].seed, l[1].seed],
};
function opina(f, nombre) {
  const [x, y] = SEÑALES[nombre](f.lados);
  if (x == null || y == null || x === y) return null;
  return x < y ? 0 : 1;                                   /* menor gana en todas */
}

const ORDEN = ['Q1', 'Q2', 'Q3', 'R1', 'R2', 'R3', 'QF', 'SF', 'F'];
const sinRet = filas.filter(f => !f.retiro);
const ic = (k, n) => n ? 1.96 * Math.sqrt((k / n) * (1 - k / n) / n) * 100 : 0;

const resumen = {};
for (const ronda of ORDEN) {
  const a = sinRet.filter(f => f.ronda === ronda);
  if (!a.length) continue;
  resumen[ronda] = { n: a.length, señales: {} };
  for (const s of Object.keys(SEÑALES)) {
    const con = a.map(f => ({ f, o: opina(f, s) })).filter(x => x.o != null);
    if (con.length < 10) { resumen[ronda].señales[s] = { n: con.length }; continue; }
    const k = con.filter(x => x.o === x.f.ganador).length;
    resumen[ronda].señales[s] = { n: con.length, acierta: k / con.length, ic: ic(k, con.length) / 100 };
  }
  /* el WTN por bandas de Δ, dentro de la ronda */
  const bandas = {};
  for (const [nom, lo, hi] of [['<1.5', 0, 1.5], ['1.5-2.5', 1.5, 2.5], ['2.5-4', 2.5, 4], ['4+', 4, 99]]) {
    const b = a.filter(f => {
      const [x, y] = [f.lados[0].wtn, f.lados[1].wtn];
      if (x == null || y == null) return false;
      const d = Math.abs(x - y); return d >= lo && d < hi;
    });
    if (b.length < 10) { bandas[nom] = { n: b.length }; continue; }
    const k = b.filter(f => opina(f, 'WTN') === f.ganador).length;
    bandas[nom] = { n: b.length, acierta: k / b.length, ic: ic(k, b.length) / 100 };
  }
  resumen[ronda].bandas = bandas;
}

fs.writeFileSync(path.join(DIR, 'itf-backtest.json'),
  JSON.stringify({ generado: new Date().toISOString(), total: filas.length, sinRetiro: sinRet.length, resumen, filas }, null, 0));

/* ---------- salida por consola ---------- */
const pc = v => v == null ? '  —  ' : (v * 100).toFixed(1).padStart(5);
console.log(`Partidos jugados con datos de nivel: ${filas.length} (${sinRet.length} sin retiros)\n`);
console.log('ACIERTO DE CADA SEÑAL, RONDA POR RONDA');
const cols = Object.keys(SEÑALES);
console.log('  ronda    n   ' + cols.map(c => c.padStart(10)).join(''));
for (const r of ORDEN) {
  if (!resumen[r]) continue;
  const s = resumen[r].señales;
  console.log('  ' + r.padEnd(6) + String(resumen[r].n).padStart(5) + '   ' +
    cols.map(c => (s[c].acierta == null ? '     n<10' : pc(s[c].acierta) + '%').padStart(10)).join(''));
}
console.log('\nWTN POR BANDA DE Δ, DENTRO DE CADA RONDA');
const bandasNom = ['<1.5', '1.5-2.5', '2.5-4', '4+'];
console.log('  ronda   ' + bandasNom.map(b => (b + ' (n)').padStart(16)).join(''));
for (const r of ORDEN) {
  if (!resumen[r]) continue;
  console.log('  ' + r.padEnd(8) + bandasNom.map(b => {
    const x = resumen[r].bandas[b];
    return (x.acierta == null ? `n=${x.n}` : `${(x.acierta * 100).toFixed(1)}% (${x.n})`).padStart(16);
  }).join(''));
}
console.log('\n→ vigia/itf-backtest.json');
