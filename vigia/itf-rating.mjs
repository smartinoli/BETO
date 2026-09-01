#!/usr/bin/env node
/* ============================================================
   ITF-RATING — el rating PROPIO del Vigía (Elo anclado en WTN).

   Pedido por Sebastián el 2026-08-28: "con los datos que tenemos,
   creemos nuestro propio ranking de jugadores".

   Por qué tiene sentido: el WTN es la mejor foto pública del nivel,
   pero se actualiza a su ritmo y va atrasado en los que suben rápido
   (el escalón sub-19 es exactamente eso). Este rating parte DESDE el
   WTN (ancla) y después se mueve partido a partido con NUESTROS
   cuadros — 3.400+ partidos, casi el triple del banco del modelo,
   porque aprovecha también los cuadros sin entry list.

   La mecánica, sencilla a propósito:
   · Escala Elo clásica (p = 1/(1+10^(-d/400))). 1 punto de WTN ≈ 81.5
     puntos Elo — sale de la pendiente medida en rondas tempranas
     (0.4692 por punto de WTN, en logit natural).
   · Arranque: 1500 + 81.5·(mediaWTN − wtn). Sin WTN conocido: media
     del circuito menos medio punto (perfil de qualifier), marcado frío.
   · K = 48 los primeros 6 partidos, 24 después. El margen importa:
     ganar 6-0 6-1 mueve más que 7-6 7-6 (multiplicador por % de games).
   · El orden es cronológico: semana del torneo y ronda dentro del
     cuadro. Así cada predicción del Elo es HONESTA (solo usa partidos
     anteriores) y la evaluación sale gratis.

   Uso:
     node vigia/itf-rating.mjs            construye + evalúa + top 25
     node vigia/itf-rating.mjs --divergencias   los que más se separan del WTN
   Escribe datos/itf/rating.json.
   ============================================================ */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const DATOS = path.join(DIR, 'datos', 'itf');
const leer = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')) } catch { return null } };

const ESCALA = 81.5;                       /* Elo por punto de WTN */
const ORD = { Q1: 0, Q2: 1, Q3: 2, R1: 3, R2: 4, R3: 5, R4: 5.5, QF: 6, SF: 7, F: 8 };
const ORD_M = { '1st Round': 'R1', '2nd Round': 'R2', '3rd Round': 'R3', 'Quarter-finals': 'QF', 'Semi-finals': 'SF', 'Final': 'F' };
const ORD_Q = { '1st Round': 'Q1', '2nd Round': 'Q2', '3rd Round': 'Q3' };
const GRUPO = { Q1: 'Q1', Q2: 'buenas', R1: 'buenas', Q3: 'medias', R2: 'medias', R3: 'medias', QF: 'finales', SF: 'finales', F: 'finales' };
const PEND = { Q1: 0.4105, buenas: 0.4692, medias: 0.3104, finales: 0.1741 };  /* curvas WTN del modelo */

/* ---------- WTN por jugador (la foto más reciente, y en UNA sola escala) ----------
   OJO, medido el 2026-09-01: entre el 25 y el 28 de agosto la ITF
   RECALIBRÓ el World Tennis Number. La mediana de las entry lists pasó
   de ~13.9 a ~8.1 y las diferencias entre jugadores se comprimieron.

   Antes esto se leía con readdirSync().sort() —orden ALFABÉTICO, no
   cronológico, pese a lo que decía el comentario— así que a cada jugador
   le tocaba una foto cualquiera y la media salía híbrida. El daño no era
   teórico: Marat Salbiev tomó su WTN de una foto nueva (7.4) contra esa
   media mezclada y arrancó en 1991 de Elo, "jugando como 7.62" con UN
   partido. Puro artefacto de escala.

   Arreglo: la foto más reciente POR FECHA, y cada era se lleva a la
   escala de referencia (la vieja, que es la del modelo y la del banco)
   por posición relativa —z-score dentro de su era—, que no depende de
   ninguna regresión entre escalas. */
const CORTE_ESCALA = '2026-08-26';
const crudas = new Map();                 /* id → {wtn, era, bajado} más reciente */
const listas = [];
for (const f of fs.readdirSync(DATOS)) {
  if (!f.startsWith('m-itf') || !f.endsWith('.aceptacion.json')) continue;
  const j = leer(path.join(DATOS, f)); if (!j) continue;
  listas.push({ bajado: j.bajado || '', j });
}
listas.sort((a, b) => String(a.bajado).localeCompare(String(b.bajado)));
const NOMBRE = new Map();
for (const { bajado, j } of listas) {
  const era = String(bajado) < CORTE_ESCALA ? 'vieja' : 'nueva';
  for (const p of Object.values(j?.secciones || {}).flat())
    if (p.id != null) {
      if (p.wtn != null) crudas.set(p.id, { wtn: p.wtn, era, bajado });
      if (p.nombre) NOMBRE.set(p.id, p.nombre);
    }
}
const stats = era => {
  const v = [...crudas.values()].filter(x => x.era === era).map(x => x.wtn);
  const m = v.reduce((a, b) => a + b, 0) / (v.length || 1);
  const sd = Math.sqrt(v.reduce((s, x) => s + (x - m) ** 2, 0) / (v.length || 1)) || 1;
  return { n: v.length, m, sd };
};
const EV = stats('vieja'), EN = stats('nueva');
const REF = EV.n >= 200 ? EV : EN;        /* la escala del modelo si la hay */
const WTN = new Map();
for (const [id, x] of crudas) {
  const e = x.era === 'vieja' ? EV : EN;
  WTN.set(id, e === REF || e.n < 50 ? x.wtn : +(REF.m + (x.wtn - e.m) * (REF.sd / e.sd)).toFixed(2));
}
const MEDIA_WTN = REF.m;
console.log(`escalas del WTN · vieja: n=${EV.n} media ${EV.m.toFixed(2)} sd ${EV.sd.toFixed(2)} · nueva: n=${EN.n} media ${EN.m.toFixed(2)} sd ${EN.sd.toFixed(2)} → todo a la escala ${REF === EV ? 'vieja' : 'nueva'}`);

/* ---------- todos los partidos, en orden cronológico ---------- */
const mapa = leer(path.join(DATOS, 'torneos.json')) || {};
const FECHA = {};
for (const sem of Object.values(mapa.semanas || {})) for (const [k, t] of Object.entries(sem))
  FECHA[k] = t.fechas?.quali || t.fechas?.main || null;
const cal = leer(path.join(DIR, 'itf-calendario.json'));
for (const t of cal?.torneos || []) if (!FECHA[t.clave]) FECHA[t.clave] = t.desde;

const porClave = new Map();               /* la versión con más partidos jugados gana */
for (const dir of [DATOS, path.join(DATOS, 'vivo')]) {
  let ff = []; try { ff = fs.readdirSync(dir) } catch { continue }
  for (const f of ff) {
    if (!f.startsWith('m-itf') || !f.endsWith('.json') || f.includes('aceptacion')) continue;
    const j = leer(path.join(dir, f)); if (!j?.cuadros) continue;
    const clave = f.replace('.json', '');
    const n = Object.values(j.cuadros).flatMap(c => (c.rondas || []).flatMap(r => r.partidos || []))
      .filter(m => m.estado === 'jugado').length;
    const prev = porClave.get(clave);
    if (!prev || n > prev.n) porClave.set(clave, { j, n });
  }
}
const partidos = [];
for (const [clave, { j }] of porClave) {
  const fecha = FECHA[clave] || '2026-08-01';
  for (const [ev, c] of Object.entries(j.cuadros)) for (const r of c.rondas || []) for (const m of r.partidos || []) {
    if (m.estado !== 'jugado' || !m.lados || m.lados.length !== 2) continue;
    const etapa = (/^q/i.test(ev) ? ORD_Q[r.nombre] : ORD_M[r.nombre]) || 'R2';
    const [a, b] = m.lados;
    const ida = a.jugadores?.[0]?.id, idb = b.jugadores?.[0]?.id;
    if (ida == null || idb == null) continue;
    if (a.jugadores.length > 1) continue;                       /* singles */
    const ga = (a.sets || []).reduce((s, x) => s + (+x || 0), 0);
    const gb = (b.sets || []).reduce((s, x) => s + (+x || 0), 0);
    const ganaA = !!a.ganador;
    if (!ganaA && !b.ganador) continue;
    const wo = /walkover/i.test(m.nota || '');
    partidos.push({ clave, fecha, etapa, orden: ORD[etapa] ?? 4, ida, idb, ganaA, ga, gb, wo,
      na: a.nombre, nb: b.nombre });
    if (a.nombre) NOMBRE.set(ida, a.nombre); if (b.nombre) NOMBRE.set(idb, b.nombre);
  }
}
partidos.sort((x, y) => x.fecha.localeCompare(y.fecha) || x.orden - y.orden);

/* ---------- el Elo, secuencial ---------- */
const elo = new Map(), nPJ = new Map();
const init = id => WTN.has(id) ? 1500 + ESCALA * (MEDIA_WTN - WTN.get(id)) : 1500 + ESCALA * (MEDIA_WTN - (MEDIA_WTN + 0.5));
const rating = id => { if (!elo.has(id)) elo.set(id, init(id)); return elo.get(id) };
const pElo = d => 1 / (1 + Math.pow(10, -d / 400));
const sig = x => 1 / (1 + Math.exp(-x));

/* evaluación honesta: predicción ANTES de actualizar */
const evalua = [];
const previos = [];        /* Elo PRE-partido, para auditar señales sin lookahead */
for (const m of partidos) {
  const ra = rating(m.ida), rb = rating(m.idb);
  previos.push({ clave: m.clave, ida: m.ida, idb: m.idb, eloA: +ra.toFixed(1), eloB: +rb.toFixed(1),
    nA: nPJ.get(m.ida) || 0, nB: nPJ.get(m.idb) || 0 });
  const pa = pElo(ra - rb);
  const na = nPJ.get(m.ida) || 0, nb = nPJ.get(m.idb) || 0;
  if (na >= 3 && nb >= 3 && WTN.has(m.ida) && WTN.has(m.idb) && !m.wo) {
    const dW = WTN.get(m.idb) - WTN.get(m.ida);        /* + = A mejor */
    const pW = sig((PEND[GRUPO[m.etapa]] ?? 0.31) * dW);
    const pB = sig((Math.log(pa / (1 - pa)) + Math.log(pW / (1 - pW))) / 2);
    evalua.push({ grupo: GRUPO[m.etapa], y: m.ganaA ? 1 : 0, pa, pW, pB });
  }
  if (!m.wo) {
    const K = a => ((nPJ.get(a) || 0) < 6 ? 48 : 24);
    const tot = m.ga + m.gb;
    const share = tot ? Math.max(m.ga, m.gb) / tot : 0.65;
    const mult = 0.6 + 0.8 * share;                    /* 6-0 6-0 mueve ~1.4x, 7-6 7-6 ~1.0x */
    const sA = m.ganaA ? 1 : 0;
    elo.set(m.ida, ra + K(m.ida) * mult * (sA - pa));
    elo.set(m.idb, rb + K(m.idb) * mult * ((1 - sA) - (1 - pa)));
  }
  nPJ.set(m.ida, (nPJ.get(m.ida) || 0) + 1);
  nPJ.set(m.idb, (nPJ.get(m.idb) || 0) + 1);
}

/* ---------- guardar ---------- */
const tabla = [...elo.entries()].map(([id, e]) => ({
  id, nombre: NOMBRE.get(id) || '?', elo: +e.toFixed(1), partidos: nPJ.get(id) || 0,
  wtn: WTN.get(id) ?? null,
  wtnImplicito: +(MEDIA_WTN - (e - 1500) / ESCALA).toFixed(2),
})).sort((a, b) => b.elo - a.elo);
fs.writeFileSync(path.join(DATOS, 'elo-previo.json'), JSON.stringify({
  nota: 'Elo de cada lado ANTES de cada partido (sin lookahead), para auditar la señal.',
  partidos: previos }));
fs.writeFileSync(path.join(DATOS, 'rating.json'), JSON.stringify({
  nota: 'Rating propio del Vigía: Elo anclado en WTN, movido por nuestros cuadros. itf-rating.mjs lo reconstruye.',
  generado: new Date().toISOString(), escala: ESCALA, mediaWtn: +MEDIA_WTN.toFixed(2),
  partidosUsados: partidos.length, jugadores: tabla }, null, 1));

/* ---------- consola ---------- */
const LL = f => -evalua.reduce((s, e) => s + (e.y ? Math.log(Math.max(f(e), 1e-9)) : Math.log(Math.max(1 - f(e), 1e-9))), 0) / evalua.length;
const AC = f => evalua.filter(e => (f(e) > 0.5) === !!e.y).length / evalua.length;
console.log(`${partidos.length} partidos ordenados · ${tabla.length} jugadores · media WTN ${MEDIA_WTN.toFixed(2)}`);
console.log(`\nEVALUACIÓN HONESTA (${evalua.length} partidos donde ambos tenían 3+ partidos previos y WTN):`);
console.log('  predictor        log-loss   acierta');
for (const [nom, f] of [['WTN (las curvas)', e => e.pW], ['ELO nuestro', e => e.pa], ['MEZCLA (mitad y mitad)', e => e.pB]])
  console.log('  ' + nom.padEnd(24) + LL(f).toFixed(4) + '   ' + (100 * AC(f)).toFixed(1) + '%');
console.log('\n  y en RONDAS FINALES (donde el WTN discrimina menos):');
const fin = evalua.filter(e => e.grupo === 'finales');
if (fin.length) {
  const LLf = f => -fin.reduce((s, e) => s + (e.y ? Math.log(Math.max(f(e), 1e-9)) : Math.log(Math.max(1 - f(e), 1e-9))), 0) / fin.length;
  const ACf = f => fin.filter(e => (f(e) > 0.5) === !!e.y).length / fin.length;
  for (const [nom, f] of [['WTN', e => e.pW], ['ELO', e => e.pa], ['MEZCLA', e => e.pB]])
    console.log('  ' + nom.padEnd(10) + LLf(f).toFixed(4) + '   ' + (100 * ACf(f)).toFixed(1) + '%   (n=' + fin.length + ')');
}
if (process.argv.includes('--divergencias')) {
  console.log('\nLOS QUE MÁS SE SEPARAN DEL WTN (5+ partidos):');
  const div = tabla.filter(t => t.wtn != null && t.partidos >= 5)
    .map(t => ({ ...t, d: +(t.wtn - t.wtnImplicito).toFixed(2) }))
    .sort((a, b) => b.d - a.d);
  console.log('  MEJORES de lo que dice su WTN:');
  for (const t of div.slice(0, 12)) console.log(`    ${t.nombre.padEnd(28)} WTN ${t.wtn}  → juega como ${t.wtnImplicito}  (${t.d > 0 ? '+' : ''}${t.d}) · ${t.partidos} pj`);
  console.log('  PEORES de lo que dice su WTN:');
  for (const t of div.slice(-8).reverse()) console.log(`    ${t.nombre.padEnd(28)} WTN ${t.wtn}  → juega como ${t.wtnImplicito}  (${t.d}) · ${t.partidos} pj`);
} else {
  console.log('\nTOP 25 DEL CIRCUITO SEGÚN NOSOTROS:');
  for (const [i, t] of tabla.filter(t => t.partidos >= 3).slice(0, 25).entries())
    console.log(`  ${String(i + 1).padStart(2)}. ${t.nombre.padEnd(30)} elo ${t.elo}  (WTN ${t.wtn ?? '—'} → juega como ${t.wtnImplicito}) · ${t.partidos} pj`);
}
console.log('\n→ vigia/datos/itf/rating.json');
