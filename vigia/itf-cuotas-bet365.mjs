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
/* SIN TOPE NUMÉRICO (2026-09-02, pedido de Sebastián: 'porque le pones
   límite a los partidos válidos, así cortas opciones'). Lo que acota es
   la VENTANA DE HORAS: los partidos de hoy, no los de pasado mañana. Un
   tope por cantidad cortaba a ciegas; uno por horas corta lo que todavía
   no importa. --max sigue existiendo solo para pruebas. */
const MAX = +arg('max', Infinity);
const HORAS = +arg('horas', 14);
/* --casa <slug>: cotiza SOLO esa casa, sin fallback. Pedido por Sebastián
   el 2026-09-01 para Betano, que es donde él apuesta: la cuota de otra
   casa le sirve de referencia pero no es la que va a pagar. Sin este
   flag manda la prioridad de siempre (bet365 > betano > pinnacle > la
   que haya), que es lo mejor para MEDIR el mercado. */
const SOLO = arg('casa', null);
/* 3.2s entre llamadas = ~18/min. Con 2.6s (~23/min) la API empezó a
   devolver RATE_LIMITED en cuanto dejamos de reusar caché viejo y el
   volumen de pedidos subió: se perdían partidos. */
const PAUSA = +arg('pausa', 3200);
const leer = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')) } catch { return null } };

/* ---------- ciudad → torneo masculino nuestro ---------- */
const mapa = leer(path.join(DATOS, 'torneos.json')) || {};
/* nombre nuestro → TODAS sus ediciones (claves), solo m-itf, la edición
   en juego primero. El mismo nombre vive en varias semanas, y el fin de
   semana de traslape hay DOS en juego a la vez (la final de esta semana y
   la quali de la próxima, medido 2026-08-30): el partido valida contra la
   entry list de CUALQUIERA de ellas. */
const TORNEOS = {};
const HOY_F = new Date().toISOString().slice(0, 10);
const prioridadEd = t => {
  const ini = t.fechas?.quali || t.fechas?.main, fin = t.fechas?.final;
  if (!ini) return 0;
  if (ini <= HOY_F && (!fin || fin >= HOY_F)) return 3;
  if (ini > HOY_F) return 2;
  return 1;
};
for (const sem of Object.values(mapa.semanas || {})) for (const [k, t] of Object.entries(sem)) {
  if (!k.startsWith('m-itf')) continue;
  const eds = (TORNEOS[t.nombre] ||= []);
  if (!eds.some(e => e.clave === k)) eds.push({ clave: k, prio: prioridadEd(t) });
}
for (const eds of Object.values(TORNEOS)) eds.sort((a, b) => b.prio - a.prio);
const ciudad = s => NORM(String(s).replace(/^[MW]\d+\+?H?\s*/i, ''));
function torneoDe(ciudadOdds) {
  const c = NORM(ciudadOdds);
  for (const [nom, eds] of Object.entries(TORNEOS))
    if (ciudad(nom) === c || ciudad(nom).startsWith(c) || c.startsWith(ciudad(nom)))
      return { nombre: nom, claves: eds.map(e => e.clave) };
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
    /* el RATE_LIMITED viene como 200 con error en el json: se espera y reintenta */
    /* el RATE_LIMITED aguanta más reintentos que un error normal: no es
       un fallo, es la API pidiendo que esperemos */
    if (j?.error?.code === 'RATE_LIMITED' && i < 7) { await espera(4000 * 1.7 ** i); continue }
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
   (todas sus cuotas son anteriores al inicio). Recibe UNA casa. */
function vigente(casa, inicio) {
  const corte = Date.parse(inicio) || Infinity;
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
  .filter(p => Date.parse(p.startTime) > ahora + 10 * 60e3 && Date.parse(p.startTime) < ahora + HORAS * 36e5)
  .map(p => ({ ...p, t: torneoDe(p.torneo) }))
  /* vale si los DOS están en la entry list de alguna edición del nombre */
  .map(p => { if (!p.t) return p;
    const clave = p.t.claves.find(c => estaEn(c, p.p1) && estaEn(c, p.p2));
    return { ...p, t: clave ? { nombre: p.t.nombre, clave } : null } })
  .filter(p => p.t)
  .sort((a, b) => String(a.startTime).localeCompare(String(b.startTime)));
console.log(`${Object.keys(idx.partidos).length} en el índice · ${candidatos.length} pendientes en las próximas ${HORAS} h, de torneos masculinos y con los dos en la entry list`
  + ` · ~${Math.ceil(candidatos.length * PAUSA / 60000)} min si hay que pedirlos todos`);

/* UN request por partido, SIN filtrar casa: la API devuelve todas las que
   tengan precio (medido el 2026-08-27: pedir casa por casa duplicaba
   requests, chocaba con el rate limit y perdía partidos que sí estaban
   cotizados). Después se elige por prioridad: bet365 manda, Betano suele
   cotizar antes, y si solo hay otra casa, se usa esa anotando la fuente. */
const PRIORIDAD = SOLO ? [SOLO] : ['bet365', 'betano', 'pinnacle'];
const cuotas = [];
let deCache = 0, noPreguntados = 0;
for (const p of candidatos) {
  if (cuotas.length >= MAX) break;
  let fallo = null;
  const fCache = path.join(CACHE, p.fixtureId + '.json');
  const cacheado = leer(fCache);
  /* EL CACHÉ NO VALE PARA UN PARTIDO QUE TODAVÍA NO EMPIEZA (2026-09-02).
     Hasta hoy se reusaba siempre, y como estos fixtures se cachean días
     antes, la "cuota vigente" que mostrábamos tenía 25 horas de vieja:
     medido, los 42 cachés de partidos pendientes promediaban 25.3 h.
     Peor todavía para la vista de Betano — una casa que empieza a cotizar
     DESPUÉS de la primera consulta no aparecía nunca, porque ya había
     caché. Ahora el caché solo se aprovecha cuando ya no puede cambiar:
     el partido arrancó (su línea pre-partido quedó cerrada) o la foto es
     de hace menos de FRESCO minutos. */
  /* 30 minutos: si se aprieta el botón dos veces seguidas, la segunda
     no vuelve a pagar los 3 segundos por partido */
  const FRESCO = 30 * 60e3;
  const arrancado = Date.parse(p.startTime) <= Date.now();
  let edad = Infinity;
  try { edad = Date.now() - fs.statSync(fCache).mtimeMs } catch {}
  const sirve = arrancado || edad < FRESCO;
  let todas = sirve ? (cacheado?.todas?.bookmakers ?? cacheado?.casas ?? null) : null;
  if (todas && Object.keys(todas).length) deCache++;
  else if (KEY) {
    try {
      const j = await api('historical-odds', { fixtureId: p.fixtureId });
      todas = j?.bookmakers || {};
      fs.mkdirSync(CACHE, { recursive: true });
      fs.writeFileSync(fCache, JSON.stringify({ fixture: p, todas: j, casas: todas }));
    } catch (e) { todas = null; fallo = e.message || 'error sin mensaje';
      if (!/NOT_FOUND/.test(fallo)) console.log(`  ✗ ${p.p1} vs ${p.p2}: ${fallo}`) }
  }
  /* NO mentir: si la consulta falló, el partido no es "sin cuota", es
     "no pudimos preguntar". Antes los dos casos decían lo mismo y un
     rate limit se leía como que las casas no lo cotizaban. */
  if (!todas || !Object.keys(todas).length) {
    if (fallo) { noPreguntados++; console.log(`  ? ${p.p1} vs ${p.p2}: no se pudo consultar (${fallo})`) }
    else console.log(`  · ${p.p1} vs ${p.p2}: ninguna casa lo cotiza todavía`);
    continue;
  }
  /* la mejor casa disponible que tenga cotización pre-partido válida */
  const orden = SOLO ? (todas[SOLO] ? [SOLO] : [])
    : [...PRIORIDAD.filter(c => todas[c]), ...Object.keys(todas).filter(c => !PRIORIDAD.includes(c))];
  if (SOLO && !orden.length) { console.log(`  · ${p.p1} vs ${p.p2}: ${SOLO} no lo cotiza (sí ${Object.keys(todas).join(',')})`); continue }
  let v = null, casa = null;
  for (const c of orden) {
    /* caché viejo guardaba la respuesta completa por casa; el nuevo, la casa pelada */
    const obj = todas[c]?.markets ? todas[c] : Object.values(todas[c]?.bookmakers || {})[0];
    v = vigente(obj, p.startTime); if (v) { casa = c; break }
  }
  if (!v) { console.log(`  · ${p.p1} vs ${p.p2}: cotizado (${Object.keys(todas).join(',')}) pero sin línea válida pre-partido`); continue }
  cuotas.push({ torneo: p.t.nombre, p1: p.p1, p2: p.p2, g1: v[0], g2: v[1],
    visto: new Date().toISOString().slice(0, 16) + 'Z', fuente: casa, fixtureId: p.fixtureId,
    inicio: p.startTime });
  console.log(`  + ${p.t.nombre.padEnd(22)} ${p.p1} ${v[0]} / ${p.p2} ${v[1]}  [${casa}]`);
}
fs.writeFileSync(SALIDA, JSON.stringify({ generado: new Date().toISOString(), casa: SOLO || 'bet365', soloCasa: SOLO || null, cuotas }, null, 1));
console.log(`\n${cuotas.length} cuotas (${deCache} de caché, ${REQ} requests)`
  + (noPreguntados ? ` · ${noPreguntados} quedaron sin consultar por límite de la API` : '')
  + ' → vigia/itf-cuotas-bet365.json');
console.log('ahora: node vigia/itf-informe.mjs --bet365');
