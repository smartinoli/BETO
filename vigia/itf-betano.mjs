#!/usr/bin/env node
/* ============================================================
   ITF-BETANO — las cuotas reales de Betano Chile, directo de Betano.

   Reemplaza a OddsPapi (itf-historico + itf-cuotas-bet365), que se sacó
   el 2026-10-11 a pedido de Sebastián: la API traía Betano en ~30 % de
   los partidos, con key, límite mensual y 3.2 s por request. Betano
   expone el mismo JSON que usa su página (betanosports.com/api/...),
   responde a un fetch simple sin navegador ni key (medido 2026-10-11) y
   trae todos los partidos de un torneo en un solo pedido.

   Cómo:
     1. /api/sport/tenis/ligas/   → las ligas de "ITF Hombres". Betano las
        llama por PAÍS ("Alemania", "Italia - Clasificación"), no por
        ciudad, y separa la quali del cuadro principal.
     2. cada liga                 → sus partidos con la cuota de Ganador.
     3. el partido vale si cae en la semana de un torneo masculino nuestro
        y LOS DOS jugadores están en su entry list: eso pone el nombre del
        torneo y descarta cruces raros.

   Solo partidos por jugar, con 10 min de colchón y dentro de --horas.
   Escribe itf-cuotas-bet365.json (mismo formato y nombre de siempre:
   itf-informe y itf-tabla no cambian), incremental por liga.

   Uso:  node vigia/itf-betano.mjs [--horas 36]
   ============================================================ */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mismoJugador } from './itf-reglas.mjs';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const DATOS = path.join(DIR, 'datos', 'itf');
const SALIDA = path.join(DIR, 'itf-cuotas-bet365.json');
const BASE = 'https://www.betanosports.com';
const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i > 0 ? process.argv[i + 1] : d };
const HORAS = +arg('horas', 36);
const leer = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')) } catch { return null } };
const espera = ms => new Promise(r => setTimeout(r, ms));

async function betano(ruta) {
  for (let i = 0; ; i++) {
    try {
      const r = await fetch(BASE + '/api' + ruta + '?req=la,s,stnf,c,mb',
        { headers: { accept: 'application/json', 'user-agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(30000) });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return await r.json();
    } catch (e) {
      if (i >= 2) throw e;
      await espera(2000 * 2 ** i);
    }
  }
}

/* ---------- torneos masculinos nuestros ---------- */
const mapa = leer(path.join(DATOS, 'torneos.json')) || {};
const EDICIONES = [];
for (const sem of Object.values(mapa.semanas || {})) for (const [k, t] of Object.entries(sem))
  if (k.startsWith('m-itf')) EDICIONES.push({ clave: k, nombre: t.nombre,
    ini: t.fechas?.quali || t.fechas?.main, fin: t.fechas?.final || t.fechas?.quali || t.fechas?.main });
const SECCIONES = new Map();
const seccionesDe = clave => {
  if (!SECCIONES.has(clave)) SECCIONES.set(clave, leer(path.join(DATOS, clave + '.aceptacion.json'))?.secciones || {});
  return SECCIONES.get(clave);
};
/* 2 = está en el cuadro o la quali; 1 = solo como alterno (A) o retirado
   (W); 0 = no está. Las listas traen cientos de A y W, y con ellos un
   jugador "está" en tres torneos a la vez (medido 2026-10-11: Furlanetto
   jugaba la quali de Pula y calzaba con Burgas). */
const nota = (clave, n) => {
  let mejor = 0;
  for (const [c, lista] of Object.entries(seccionesDe(clave)))
    if (lista.some(p => mismoJugador(p.nombre, n))) mejor = Math.max(mejor, c === 'A' || c === 'W' ? 1 : 2);
  return mejor;
};
/* El partido tiene que caer dentro de la semana del torneo (quali →
   final). Sin eso, el domingo de traslape la edición que termina hoy le
   gana a la que empieza (Offenbach salía Pontevedra). Entre las que
   quedan, gana la de mejor nota sumada. */
function torneoDe(p1, p2, inicio) {
  const dia = new Date(inicio).toISOString().slice(0, 10);
  let mejor = null, mn = 0;
  for (const e of EDICIONES) {
    if (!e.ini || dia < e.ini || dia > e.fin) continue;
    const a = nota(e.clave, p1), b = a && nota(e.clave, p2);
    if (a && b && a + b > mn) { mejor = e; mn = a + b }
  }
  return mejor;
}

/* ---------- 1. las ligas ITF Hombres ---------- */
const ligasJ = await betano('/sport/tenis/ligas/');
/* se buscan las URLs en todo el JSON: el grupo "ITF Hombres" a veces no
   lista las quali, que sí aparecen en otras partes de la respuesta */
const LIGAS = [...new Set([...JSON.stringify(ligasJ).matchAll(/\/sport\/tenis\/itf-hombres\/[a-z0-9-]+\/\d+\//g)].map(m => m[0]))];
console.log(`${LIGAS.length} ligas ITF Hombres en Betano`);

/* ---------- 2 y 3. partidos, cuotas y torneo ---------- */
const ahora = Date.now(), hasta = ahora + HORAS * 36e5;
const visto = new Date().toISOString().slice(0, 16) + 'Z';
const cuotas = [];
let sinCuota = 0, sinTorneo = 0, fallidas = 0;
const guardar = parcial => fs.writeFileSync(SALIDA, JSON.stringify({ generado: new Date().toISOString(),
  casa: 'betano', soloCasa: 'betano', parcial, cuotas }, null, 1));
for (const liga of LIGAS) {
  let j;
  try { j = await betano(liga) } catch (e) { fallidas++; console.log(`  ? ${liga}: no se pudo consultar (${e.message})`); continue }
  for (const b of j?.data?.blocks || []) for (const e of b.events || []) {
    if (!(e.startTime > ahora + 10 * 60e3 && e.startTime < hasta)) continue
    const m = (e.markets || []).find(x => x.type === 'HTOH');
    const s = m?.selections || [];
    if (s.length !== 2 || !(s[0].price > 1) || !(s[1].price > 1)) { sinCuota++; continue }
    const t = torneoDe(s[0].name, s[1].name, e.startTime);
    if (!t) { sinTorneo++; console.log(`  · ${b.name}: ${s[0].name} vs ${s[1].name} — no calza con ninguna entry list`); continue }
    cuotas.push({ torneo: t.nombre, p1: s[0].name, p2: s[1].name, g1: +s[0].price, g2: +s[1].price,
      visto, fuente: 'betano', fixtureId: 'betano-' + e.id, inicio: new Date(e.startTime).toISOString() });
    console.log(`  + ${t.nombre.padEnd(26)} ${s[0].name} ${s[0].price} / ${s[1].name} ${s[1].price}`);
  }
  guardar(true);
  await espera(500);
}
guardar(false);
console.log(`\n${cuotas.length} partidos con cuota de Betano en las próximas ${HORAS} h`
  + (sinTorneo ? ` · ${sinTorneo} sin entry list que calce` : '')
  + (sinCuota ? ` · ${sinCuota} sin cuota de ganador` : '')
  + (fallidas ? ` · ${fallidas} ligas no se pudieron consultar` : '')
  + ' → vigia/itf-cuotas-bet365.json');
