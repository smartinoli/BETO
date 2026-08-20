#!/usr/bin/env node
/* ============================================================
   ITF-CRUCE — une las dos fuentes:
     · OddsPapi (vía vigía): cuota de Betano y justo de bet365 → itf.json
     · itftennis.com (vía itf.mjs): cuadros con resultados y estado de entrada

   Qué hace sobre el tablero de favoritos (vigia/itf.json):
   1. LIQUIDA por el cuadro oficial ITF los partidos pendientes que tienen
      nombres: busca el torneo por ciudad en el caché del calendario, ubica
      el partido por apellidos y saca ganador + marcador en sets + retiro.
      No gasta requests de OddsPapi.
   2. ANOTA el contexto de entrada: ronda, entrada del favorito y del rival
      (DA/Q/LL/WC/SE), seed del favorito. Con eso el tablero puede separar
      "favorito contra qualifier en R1" de "favorito contra top seed en QF":
      entry list vs resultado final.

   Solo usa los endpoints ABIERTOS (GetEventFilters/GetDrawsheet): funciona
   con fetch pelado, sin navegador. Sin dependencias (Node 20+).

   Uso directo:  node vigia/itf-cruce.mjs liquidar   (lee y escribe itf.json)
   Desde vigía:  import { liquidarConItf } from './itf-cruce.mjs'
   ============================================================ */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { eventos, cuadro } from './itf.mjs';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const CACHE_CALENDARIO = path.join(DIR, 'itf-calendario.json');
const ITF_PATH = path.join(DIR, 'itf.json');

/* ---------- nombres ---------- */
const normalizar = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z\s]/g, ' ').replace(/\s+/g, ' ').trim();
const tokens = s => normalizar(s).split(' ').filter(t => t.length >= 3);

/* ¿"Semen Pankin" es el mismo que el lado cuyo nombre es "Semen Pankin"?
   Comparación por tokens compartidos: robusta a orden, iniciales y tildes. */
function pareceElMismo(nombreApi, lado) {
  if (!lado?.nombre) return false;
  const a = tokens(nombreApi), b = new Set(tokens(lado.nombre));
  if (!a.length || !b.size) return false;
  return a.filter(t => b.has(t)).length >= Math.min(2, a.length, b.size);
}

/* ---------- torneos por ciudad ---------- */
function torneosPorCiudad(ciudad) {
  let cache;
  try { cache = JSON.parse(fs.readFileSync(CACHE_CALENDARIO, 'utf8')) } catch { return []; }
  const c = normalizar(ciudad);
  if (!c) return [];
  return cache.torneos.filter(t =>
    normalizar(t.nombre).includes(c) || normalizar(t.sede || '').includes(c));
}

/* ---------- cuadros con caché por corrida ---------- */
const memoria = new Map();
async function cuadrosDe(clave) {
  if (memoria.has(clave)) return memoria.get(clave);
  const prom = (async () => {
    const ev = await eventos(clave);
    const out = {};
    for (const c of ev.cuadros.filter(c => c.tipo === 'S')) {
      out[c.evento] = await cuadro({ tournamentId: ev.tournamentId, tourType: ev.tourType, evento: c.evento, tipo: 'S' });
    }
    return out;
  })();
  memoria.set(clave, prom);
  return prom;
}

const RONDAS_CORTAS = { '1st Round': 'R1', '2nd Round': 'R2', '3rd Round': 'R3', 'Quarter-finals': 'QF', 'Semi-finals': 'SF', 'Final': 'F' };

/* Busca el partido de p1 vs p2 en los cuadros de las claves dadas. */
async function ubicarPartido(claves, p1, p2, log = () => {}) {
  for (const clave of claves) {
    let cuadros;
    try { cuadros = await cuadrosDe(clave); }
    catch (e) { log(`itf-cruce: cuadros de ${clave} fallaron (${e.message.split(':')[0]})`); continue; }
    for (const [evento, c] of Object.entries(cuadros)) {
      for (const r of c.rondas) {
        for (const p of r.partidos) {
          const [A, B] = p.lados;
          let idx1 = null;
          if (pareceElMismo(p1, A) && pareceElMismo(p2, B)) idx1 = 0;
          else if (pareceElMismo(p1, B) && pareceElMismo(p2, A)) idx1 = 1;
          if (idx1 === null) continue;
          const ronda = (evento === 'Q' ? 'Q·' : '') + (RONDAS_CORTAS[r.nombre] || r.nombre);
          return { clave, evento, ronda, partido: p, idx1 };
        }
      }
    }
  }
  return null;
}

/* Marcador en sets a partir de los games por set de cada lado. */
function marcadorSets(lados, idxGanador) {
  const g = lados[idxGanador].sets.map(s => parseInt(s)), p = lados[1 - idxGanador].sets.map(s => parseInt(s));
  let sg = 0, sp = 0;
  for (let i = 0; i < Math.max(g.length, p.length); i++) {
    if (!Number.isFinite(g[i]) || !Number.isFinite(p[i])) continue;
    if (g[i] > p[i]) sg++; else if (p[i] > g[i]) sp++;
  }
  return sg + '-' + sp;
}

/* ---------- liquidación + anotación sobre itf.json ---------- */
export async function liquidarConItf(db, { maxTorneos = 12, log = () => {} } = {}) {
  const pend = Object.entries(db.partidos).filter(([, e]) =>
    e.estado === 'pendiente' && e.p1 && e.p2
    && Date.now() - new Date(e.t || e.visto).getTime() > 4 * 3600e3);
  let liq = 0, anot = 0, wafSeguidos = 0;
  const sinTorneo = new Set();
  for (const [fix, e] of pend) {
    /* Si el WAF está desafiando en serie, insistir solo lo empeora:
       abandonar la pasada y que la próxima corrida (IP fría) recoja. */
    if (wafSeguidos >= 2) { log('itf-cruce: WAF en serie, corto la pasada'); break; }
    if (sinTorneo.has(e.torneo)) continue;
    const claves = torneosPorCiudad(e.torneo).map(t => t.clave);
    if (!claves.length) { sinTorneo.add(e.torneo); log(`itf-cruce: sin torneo en caché para "${e.torneo}"`); continue; }
    if (memoria.size >= maxTorneos && claves.some(c => !memoria.has(c))) continue;
    let huboWaf = false;
    const logW = m => { if (/Incapsula/.test(m)) huboWaf = true; log(m); };
    let u;
    try { u = await ubicarPartido(claves, e.p1, e.p2, logW); } catch (err) { log('itf-cruce: ' + err.message); continue; }
    wafSeguidos = huboWaf && !u ? wafSeguidos + 1 : 0;
    if (!u) { log(`itf-cruce: no ubico ${e.p1} vs ${e.p2} en ${claves.join(',')}`); continue; }
    const { partido, idx1, ronda, clave } = u;
    /* Contexto de entrada: siempre que ubicamos el partido, aunque no esté jugado. */
    const ladoFav = partido.lados[e.fav === 1 ? idx1 : 1 - idx1];
    const ladoRival = partido.lados[e.fav === 1 ? 1 - idx1 : idx1];
    e.clave = clave; e.ronda = ronda;
    e.entFav = ladoFav?.entrada || null; e.entRival = ladoRival?.entrada || null;
    e.seedFav = ladoFav?.seed ?? null; e.seedRival = ladoRival?.seed ?? null;
    anot++;
    if (partido.estado === 'jugado') {
      const idxG = partido.lados.findIndex(l => l.ganador);
      if (idxG >= 0) {
        const ganador = idxG === idx1 ? 1 : 2;
        e.estado = ganador === e.fav ? 'F' : 'D';
        e.marcador = marcadorSets(partido.lados, idxG) + (/retired|walkover/i.test(partido.nota || '') ? '-ret' : '');
        if (partido.nota) e.nota = partido.nota;
        e.fuente = 'itf';
        liq++;
      }
    }
  }
  return { liquidados: liq, anotados: anot };
}

/* Resumen entry-vs-resultado sobre lo ya liquidado y anotado. */
export function resumenEntradas(db) {
  const cer = Object.values(db.partidos).filter(e => (e.estado === 'F' || e.estado === 'D') && e.entRival !== undefined);
  if (!cer.length) return [];
  const grupos = [
    ['fav vs qualifier/LL', e => e.entRival === 'Q' || e.entRival === 'LL'],
    ['fav vs entrada directa', e => e.entRival === 'DA'],
    ['fav vs wild card', e => e.entRival === 'WC'],
    ['fav DESDE qualis', e => e.entFav === 'Q' || e.entFav === 'LL'],
    ['en R1', e => e.ronda === 'R1'],
    ['R2 en adelante', e => e.ronda && e.ronda !== 'R1' && !e.ronda.startsWith('Q·')],
  ];
  const filas = [];
  for (const [nom, fil] of grupos) {
    const a = cer.filter(fil);
    if (a.length < 2) continue;
    const gano = a.filter(e => e.estado === 'F').length;
    const impl = a.reduce((x, e) => x + 1 / e.cB, 0) / a.length;
    filas.push(`${nom} · n${a.length} · gana ${(gano / a.length * 100).toFixed(0)}% (cuota implica ${(impl * 100).toFixed(0)}%)`);
  }
  return filas;
}

/* ---------- CLI ---------- */
const esCli = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (esCli) {
  const cmd = process.argv[2];
  if (cmd === 'liquidar') {
    const db = JSON.parse(fs.readFileSync(ITF_PATH, 'utf8'));
    const r = await liquidarConItf(db, { log: console.log });
    fs.writeFileSync(ITF_PATH, JSON.stringify(db));
    console.log(`✓ ${r.liquidados} liquidados por cuadro ITF, ${r.anotados} anotados con contexto de entrada`);
    for (const f of resumenEntradas(db)) console.log('  ' + f);
  } else {
    console.log('Uso: node vigia/itf-cruce.mjs liquidar');
  }
}
