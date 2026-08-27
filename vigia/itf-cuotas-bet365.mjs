#!/usr/bin/env node
/* ============================================================
   ITF-CUOTAS-BET365 — la tanda del día SIN PDF: cuotas por API.

   Hace lo mismo que subir los PDF de Betano, pero desde OddsPapi con
   bet365: toma los partidos PENDIENTES del índice capturado
   (itf-historico.mjs --capturar), les pide la cotización vigente, y deja
   una tanda con el mismo formato que itf-cuotas-archivos, para que
   itf-informe --bet365 la analice con el modelo completo.

   POR QUÉ HAY QUE MAPEAR CIUDADES. OddsPapi llama a los torneos por la
   ciudad a secas ("Poznan", "Pecs") y mezcla el circuito masculino con el
   femenino — "Kursumlijska Banja" tiene M15 y W15 la misma semana. El
   cruce va por ciudad contra nuestro mapa de torneos ITF y despues exige
   que LOS DOS jugadores esten en la entry list del torneo masculino: eso
   filtra a las mujeres y de paso valida el emparejamiento, igual que
   haciamos con los PDF contra el cuadro.

   El precio es la ultima cotizacion ACTIVA de la linea de tiempo (para un
   partido pendiente, eso es la cuota vigente). Se cachea igual que la
   cosecha, en datos/itf/historico/, asi que no se paga dos veces.

   Uso:
     ODDSPAPI_KEY=... node vigia/itf-cuotas-bet365.mjs --max 40
     node vigia/itf-informe.mjs --bet365
   ============================================================ */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NORM, mismoJugador } from './itf-reglas.mjs';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const DATOS = path.join(DIR, 'datos', 'itf');
const CACHE = path.join(DATOS, 'historico');
const INDICE = path.join(DATOS, 'historico-indice.json');
const SALIDA = path.join(DIR, 'itf-cuotas-bet365.json');
const KEY = process.env.ODDSPAPI_KEY;
const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i > 0 ? process.argv[i + 1] : d };
const MAX = +arg('max', 40);
const PAUSA = +arg('pausa', 2600);
const leer = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')) } catch { return null } };

/* ---------- ciudad → torneo masculino nuestro ---------- */
const mapa = leer(path.join(DATOS, 'torneos.json')) || {};
const TORNEOS = {};   /* nombre nuestro → clave, solo m-itf */
for (const sem of Object.values(mapa.semanas || {})) for (const [k, t] of Object.entries(sem))
  if (k.startsWith('m-itf')) TORNEOS[t.nombre] = k;
const ciudad = s => NORM(String(s).replace(/^[MW]\d+\+?H?\s*/i, ''));
function torneoDe(ciudadOdds) {
  const c = NORM(ciudadOdds);
  for (const [nom, clave] of Object.entries(TORNEOS))
    if (ciudad(nom) === c || ciudad(nom).startsWith(c) || c.startsWith(ciudad(nom)))
      return { nombre: nom, clave };
  return null;
}
/* entry list del torneo, para validar que el partido es del cuadro masculino */
const FICHAS = new Map();
function nombresDe(clave) {
  if (FICHAS.has(clave)) return FICHAS.get(clave);
  const j = leer(path.join(DATOS, clave + '.aceptacion.json'));
  const s = j?.secciones ? Object.values(j.secciones).flat().map(p => p.nombre) : [];
  FICHAS.set(clave, s);
  return s;
}
const estaEn = (clave, nombre) => nombresDe(clave).some(n => mismoJugador(n, nombre));

/* ---------- API (mismo pacing que itf-historico) ---------- */
let REQ = 0, ULT = 0;
const espera = ms => new Promise(r => setTimeout(r, ms));
async function api(ruta, params) {
  if (!KEY) throw new Error('falta ODDSPAPI_KEY');
  const u = new URL('https://api.oddspapi.io/v4/' + ruta);
  Object.entries({ ...params, apiKey: KEY }).forEach(([k, v]) => u.searchParams.set(k, v));
  for (let i = 0; ; i++) {
    const f = ULT + PAUSA - Date.now(); if (f > 0) await espera(f);
    ULT = Date.now();
    let r = null, err = null;
    try { r = await fetch(u, { signal: AbortSignal.timeout(30000) }) } catch (e) { err = e }
    if ((err || r.status === 429 || r.status >= 500) && i < 4) { await espera(2500 * 2 ** i); continue }
    if (err) throw new Error('red: ' + err.message);
    const j = await r.json().catch(() => null);
    if (j?.error) throw new Error(`${j.error.code || ''}`.trim());
    if (!r.ok) throw new Error('HTTP ' + r.status);
    REQ++;
    return j;
  }
}
/* Última cotización activa de cada lado ANTES del inicio del partido.
   El corte en startTime es obligatorio: cuando el partido arranca, la
   línea de tiempo sigue con precios EN VIVO (movidos por el marcador) y
   termina en 1.00/1.01 de liquidación — nada de eso sirve para decidir
   una apuesta pre-partido. Para un pendiente el corte no quita nada
   (todas sus cuotas son anteriores al inicio). */
function vigente(hist, inicio) {
  const corte = Date.parse(inicio) || Infinity;
  const casa = Object.values(hist?.bookmakers || {})[0];
  for (const m of Object.values(casa?.markets || {})) {
    const outs = Object.values(m.outcomes || {});
    if (outs.length !== 2) continue;
    const L = outs.map(o => {
      const s = (o.players || {})['0'];
      if (!Array.isArray(s)) return null;
      const act = s.filter(x => x.price != null && x.active !== false
        && (Date.parse(x.createdAt) || 0) < corte);
      return act.length ? +act[act.length - 1].price : null;
    });
    if (L[0] != null && L[1] != null) return L;
  }
  return null;
}

/* ---------- la tanda ---------- */
const idx = leer(INDICE);
if (!idx) { console.error('no hay índice: corre itf-historico.mjs --capturar'); process.exit(1) }
const ahora = Date.now();
/* SOLO partidos por jugar, y con 10 minutos de colchón. El colchón no es
   adorno: el 2026-08-27 el feed le corrió el startTime a un partido que ya
   iba un set arriba (decía 12:12, se jugaba desde las 09:00) y la "cuota
   vigente" capturada 7 minutos antes de ese inicio falso era un 1.004 EN
   VIVO. Un partido que "empieza" en menos de 10 minutos no se cotiza: su
   cuota ya no es apostable y puede venir contaminada. */
const candidatos = Object.values(idx.partidos)
  .filter(p => Date.parse(p.startTime) > ahora + 10 * 60e3)
  .map(p => ({ ...p, t: torneoDe(p.torneo) }))
  .filter(p => p.t && estaEn(p.t.clave, p.p1) && estaEn(p.t.clave, p.p2))
  .sort((a, b) => String(a.startTime).localeCompare(String(b.startTime)));
console.log(`${Object.keys(idx.partidos).length} en el índice · ${candidatos.length} pendientes de torneos masculinos con los dos en la entry list`);

/* bet365 manda, pero Betano suele cotizar ANTES (medido el 2026-08-27:
   la madrugada asiática del día siguiente estaba en Betano horas antes
   de aparecer en bet365). Se prueba en orden y se anota la fuente. */
const CASAS = ['bet365', 'betano'];
const cuotas = [];
let deCache = 0;
for (const p of candidatos) {
  if (cuotas.length >= MAX) break;
  const fCache = path.join(CACHE, p.fixtureId + '.json');
  const cacheado = leer(fCache);
  let hist = null, casa = null;
  for (const c of CASAS) if (cacheado?.casas?.[c]) { hist = cacheado.casas[c]; casa = c; deCache++; break }
  if (!hist && KEY) for (const c of CASAS) {
    try {
      hist = await api('historical-odds', { fixtureId: p.fixtureId, bookmaker: c });
      casa = c;
      fs.mkdirSync(CACHE, { recursive: true });
      fs.writeFileSync(fCache, JSON.stringify({ fixture: p, casas: { [c]: hist }, hist }));
      break;
    } catch (e) { hist = null; if (!/NOT_FOUND/.test(e.message)) console.log(`  ✗ ${p.p1} vs ${p.p2} (${c}): ${e.message || 'error sin mensaje'}`) }
  }
  if (!hist) { console.log(`  · ${p.p1} vs ${p.p2}: sin cuota todavía en ${CASAS.join('/')}`); continue }
  const v = vigente(hist, p.startTime);
  if (!v) continue;
  cuotas.push({ torneo: p.t.nombre, p1: p.p1, p2: p.p2, g1: v[0], g2: v[1],
    visto: new Date().toISOString().slice(0, 16) + 'Z', fuente: casa, fixtureId: p.fixtureId,
    inicio: p.startTime });
  console.log(`  + ${p.t.nombre.padEnd(22)} ${p.p1} ${v[0]} / ${p.p2} ${v[1]}  [${casa}]`);
}
fs.writeFileSync(SALIDA, JSON.stringify({ generado: new Date().toISOString(), casa: 'bet365', cuotas }, null, 1));
console.log(`\n${cuotas.length} cuotas (${deCache} de caché, ${REQ} requests) → vigia/itf-cuotas-bet365.json`);
console.log('ahora: node vigia/itf-informe.mjs --bet365');
