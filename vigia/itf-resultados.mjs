#!/usr/bin/env node
/* ============================================================
   ITF-RESULTADOS — lo que dijimos contra lo que pasó.

   Toma TODAS las cuotas que tenemos (itf-cuotas-manuales.json), las
   cruza con el resultado real del cuadro, y les vuelve a pasar el
   juicio actual de itf-reglas.mjs. O sea: no compara contra lo que
   opinabamos ese dia, sino contra lo que opinariamos HOY con las
   mismas reglas. Asi cada cambio de reglas se puede juzgar sobre todo
   el registro y no solo sobre los partidos nuevos.

   Muestra cuatro cosas:
     1. como le fue al favorito por WTN, mire o no el sistema
     2. que hicieron los partidos que el sistema DESCARTO — la unica
        forma de saber si el filtro sirve o esta botando ganadores
     3. el acierto contra lo que el modelo predecia, con su p-valor
     4. el residuo de mercado, que es la señal que mas separa

   Uso:  node vigia/itf-resultados.mjs
   ============================================================ */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { analizar, pMercadoModelo } from './itf-reglas.mjs';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const DATOS = path.join(DIR, 'datos', 'itf');
const norm = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z ]/g, ' ').replace(/\s+/g, ' ').trim();
const tok = s => new Set(norm(s).split(' ').filter(x => x.length >= 3));
/* Betano y la ITF no escriben igual ("Baybar"/"Baybars", "Luca"/"Lucca"):
   basta con que compartan casi todos los tokens largos. */
const calza = (a, b) => { const A = tok(a), B = tok(b); let c = 0; for (const x of A) if (B.has(x)) c++;
  return c >= 1 && c >= Math.min(A.size, B.size) - 1; };
const leer = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')) } catch { return null } };

const mapa = leer(path.join(DATOS, 'torneos.json')) || {};
const claves = {};
for (const sem of Object.values(mapa.semanas || {})) for (const [k, t] of Object.entries(sem)) claves[t.nombre] = k;
for (const [k, t] of Object.entries(mapa.torneos || {})) claves[t.nombre] = k;

/* ---------- indice de partidos, con la ficha de nivel del propio torneo ---------- */
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
      idx.push({ clave, ev, ronda: r.nombre, numero: r.numero, m, L, F });
    }
  }
}
const CORTA = { '1st Round': 'R1', '2nd Round': 'R2', '3rd Round': 'R3', 'Quarter-finals': 'QF',
  'Quarter-final': 'QF', 'Semi-finals': 'SF', 'Semi-final': 'SF', 'Final': 'F' };
const etapaDe = (ev, r) => { const c = CORTA[r] || r;
  return ev === 'Q' ? (c === 'R1' ? 'Q1' : c === 'R2' ? 'Q2' : c === 'R3' ? 'Q3' : 'Q·' + c) : c; };
/* trayectoria previa dentro del mismo cuadro, para la forma con la que
   llegaba a ESE partido (no la del torneo completo) */
function trayectoria(nombre, clave, ev, hasta) {
  const pasos = [];
  for (const e of idx) {
    if (e.clave !== clave || e.m.estado !== 'jugado') continue;
    if (e.ev === ev && e.numero >= hasta) continue;
    if (e.ev === 'M' && ev === 'Q') continue;
    const i = e.L.findIndex(l => l.nombre && norm(l.nombre) === norm(nombre));
    if (i < 0) continue;
    pasos.push(e.L[i].sets.map((s, k) => s + '-' + (e.L[1 - i].sets[k] ?? '?')).join(' '));
  }
  return pasos.join(' · ');
}

/* ---------- cruzar cada cuota con su partido ---------- */
const doc = leer(path.join(DIR, 'itf-cuotas-manuales.json')) || { cuotas: [] };
const reg = [];
for (const q of doc.cuotas) {
  const clave = claves[q.torneo.replace(/\s*\(qualis\)\s*/, '')];
  const cand = idx.filter(e => (!clave || e.clave === clave) &&
    ((calza(e.L[0].nombre, q.p1) && calza(e.L[1].nombre, q.p2)) ||
     (calza(e.L[0].nombre, q.p2) && calza(e.L[1].nombre, q.p1))));
  if (cand.length !== 1) { reg.push({ q, estado: cand.length ? 'ambiguo' : 'no encontrado' }); continue; }
  const e = cand[0];
  if (e.m.estado !== 'jugado') { reg.push({ q, estado: 'sin jugar' }); continue; }
  const i1 = calza(e.L[0].nombre, q.p1) ? 0 : 1;
  const lados = [0, 1].map(i => {
    const fi = (e.F && e.F.get(norm(e.L[i].nombre))) || {};
    return { nombre: e.L[i].nombre,
      marca: e.L[i].seed ? `[${e.L[i].seed}]` : (e.L[i].entrada === 'Q' ? 'Q' : ''),
      atp: fi.atp ?? null, itf: fi.itf ?? null, wtn: fi.wtn ?? null,
      wtnVisible: fi.wtnVisible !== false, jr: fi.seccion === 'JR',
      gana: i === i1 ? q.g1 : q.g2, llega: trayectoria(e.L[i].nombre, e.clave, e.ev, e.numero) };
  });
  const etapa = etapaDe(e.ev, e.ronda);
  const v = analizar({ lados, ronda: etapa });
  const iw = e.L.findIndex(x => x.ganador);
  const kf = (lados[0].wtn != null && lados[1].wtn != null) ? (lados[0].wtn < lados[1].wtn ? 0 : 1) : null;
  const r = { q, estado: 'ok', etapa, clave: e.clave, v, lados, etiqueta: (v.banderas || []).slice(-1)[0] || '',
    ret: /retir|walkover/i.test(e.m.nota || ''),
    favWtn: kf != null ? lados[kf] : null, cuota: kf != null ? lados[kf].gana : null,
    gano: (kf != null && iw >= 0) ? calza(e.L[iw].nombre, lados[kf].nombre) : null };
  if (kf != null && lados[0].gana && lados[1].gana) {
    const yo = lados[kf], otro = lados[1 - kf];
    r.devig = (1 / yo.gana) / ((1 / yo.gana) + (1 / otro.gana));
    r.resid = r.devig - pMercadoModelo(Math.abs(lados[0].wtn - lados[1].wtn));
  }
  reg.push(r);
}

const ok = reg.filter(r => r.estado === 'ok');
const con = ok.filter(r => r.gano != null);
fs.writeFileSync(path.join(DIR, 'itf-resultados.json'),
  JSON.stringify({ generado: new Date().toISOString(), registro: ok }, null, 1));

/* ---------- salida ---------- */
const T = (s, n) => String(s ?? '').slice(0, n).padEnd(n);
const eco = a => { let i = 0, v = 0; for (const r of a) { if (r.cuota == null) continue; i++; if (r.gano) v += r.cuota; }
  return i ? `${(v - i >= 0 ? '+' : '')}${(v - i).toFixed(2)}u en ${i}u (${((v / i - 1) * 100).toFixed(0)}%)` : '—'; };
/* p-valor exacto por convolucion Poisson-binomial */
const cola = (g, bajo = true) => {
  let d = [1];
  for (const x of g) { const n = new Array(d.length + 1).fill(0);
    d.forEach((v, i) => { n[i] += v * (1 - x.v.nivel.p); n[i + 1] += v * x.v.nivel.p; }); d = n; }
  const k = g.filter(x => x.gano).length;
  return bajo ? d.slice(0, k + 1).reduce((a, b) => a + b, 0) : d.slice(k).reduce((a, b) => a + b, 0);
};

console.log(`cuotas registradas ${doc.cuotas.length} · con resultado ${ok.length} · ` +
  `sin jugar ${reg.filter(r => r.estado === 'sin jugar').length} · sin calzar ${reg.filter(r => ['no encontrado', 'ambiguo'].includes(r.estado)).length}\n`);

console.log('EL FAVORITO POR WTN, MIRE O NO EL SISTEMA');
console.log(`  ${con.filter(r => r.gano).length}/${con.length} = ${(100 * con.filter(r => r.gano).length / con.length).toFixed(1)}%  ·  apostarlos todos: ${eco(con)}`);
const marc = con.filter(r => ['segura', 'anomalia', 'mirar'].includes(r.v.tipo));
const desc = con.filter(r => r.v.tipo === 'pasar');
console.log(`  los que el sistema MARCA   : ${marc.filter(r => r.gano).length}/${marc.length}  ·  ${eco(marc)}`);
console.log(`  los que el sistema DESCARTA: ${desc.filter(r => r.gano).length}/${desc.length}  ·  ${eco(desc)}`);

console.log('\nCONTRA LO QUE EL MODELO PREDECÍA');
for (const [nom, g] of [['todo el registro', con.filter(r => r.v.nivel?.p != null)],
                        ['solo los marcados', marc.filter(r => r.v.nivel?.p != null)]]) {
  if (!g.length) continue;
  const esp = g.reduce((s, x) => s + x.v.nivel.p, 0);
  console.log(`  ${T(nom, 20)} n=${String(g.length).padStart(2)}  esperaba ${esp.toFixed(1)}  pasaron ${g.filter(x => x.gano).length}` +
    `  (${(100 * g.filter(x => x.gano).length / g.length).toFixed(0)}% contra ${(100 * esp / g.length).toFixed(0)}%)  p=${(100 * cola(g)).toFixed(0)}%`);
}

console.log('\nEL RESIDUO DE MERCADO — cuánto se aparta la cuota de lo que el propio');
console.log('mercado diría por ΔWTN. Es lo que más separa el registro:');
for (const [nom, f] of [['el mercado nos apoya   (resid ≥ 0)', x => x.resid >= 0],
                        ['el mercado contradice  (resid < 0)', x => x.resid < 0]]) {
  const g = con.filter(x => x.resid != null && f(x)); if (!g.length) continue;
  const cp = g.filter(x => x.v.nivel?.p != null);
  const esp = cp.reduce((s, x) => s + x.v.nivel.p, 0);
  console.log(`  ${nom}  n=${String(g.length).padStart(2)}  ganó ${g.filter(x => x.gano).length}/${g.length}` +
    `  ·  ${eco(g)}` + (cp.length ? `  ·  esperábamos ${(100 * esp / cp.length).toFixed(0)}%, p=${(100 * cola(cp)).toFixed(0)}%` : ''));
}
/* el criterio de valor busca justo donde el mercado nos contradice */
const cv = con.filter(x => x.v.precio?.val != null && x.resid != null);
if (cv.length > 3) {
  const xs = cv.map(x => x.v.precio.val), ys = cv.map(x => x.resid);
  const mx = xs.reduce((a, b) => a + b, 0) / xs.length, my = ys.reduce((a, b) => a + b, 0) / ys.length;
  const r = xs.reduce((s, v, i) => s + (v - mx) * (ys[i] - my), 0) /
    (Math.sqrt(xs.reduce((s, v) => s + (v - mx) ** 2, 0)) * Math.sqrt(ys.reduce((s, v) => s + (v - my) ** 2, 0)));
  console.log(`\n  correlación entre el VALOR que calculamos y el residuo: r = ${r.toFixed(3)} (n=${cv.length})`);
  console.log('  valor = p×cuota−1 se maximiza donde la cuota es más larga de lo que dice nuestra p,');
  console.log('  o sea justo donde el mercado más nos contradice. Los dos criterios se pelean.');
}

console.log('\nTODO EL REGISTRO, DE MÁS A MENOS SEGURO');
for (const r of ok.sort((a, b) => (b.v.nivel?.p || 0) - (a.v.nivel?.p || 0)))
  console.log(`  ${r.gano == null ? '?' : r.gano ? '✓' : '✗'} ${T(r.etapa, 4)} ${T(r.q.torneo.replace(/ \(qualis\)/, ''), 16)} ` +
    `${T(r.v.tipo, 9)} ${(r.v.nivel?.p ? (100 * r.v.nivel.p).toFixed(0) + '%' : ' —').padStart(4)} @${T(r.cuota ?? '—', 5)} ` +
    `${T(r.favWtn?.nombre ?? 'sin WTN', 26)} ${T(r.etiqueta, 22)}${r.ret ? ' (retiro)' : ''}`);
console.log('\n→ vigia/itf-resultados.json');
