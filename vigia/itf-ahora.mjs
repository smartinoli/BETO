#!/usr/bin/env node
/* ============================================================
   ITF-AHORA — qué torneos nuestros tienen partidos por jugarse pronto.

   La idea que funcionó el 2026-09-02: mirar solo lo que está por
   jugarse, no la semana entera. Hasta el 2026-10-11 salía del índice de
   OddsPapi; sin la API sale de las FECHAS de torneos.json: los torneos
   masculinos cuya semana (quali → final) cae en las próximas N horas.

   Uso:  node vigia/itf-ahora.mjs [--horas 8]        lista claves y nombres
   Desde código: torneosAhora(horas) → [{clave, nombre}]
   ============================================================ */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const DATOS = path.join(DIR, 'datos', 'itf');
const leer = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')) } catch { return null } };

/* trozo del nombre que la tanda entiende con --torneos (la ciudad) */
export const ciudadCorta = n => String(n).replace(/^[MW]\d+\+?H?\s*/i, '').split(/[\s,]/)[0].toLowerCase();

export function torneosAhora(horas = 8) {
  const mapa = leer(path.join(DATOS, 'torneos.json'));
  if (!mapa) return [];
  const desde = new Date().toISOString().slice(0, 10);
  const hasta = new Date(Date.now() + horas * 36e5).toISOString().slice(0, 10);
  const out = [];
  for (const sem of Object.values(mapa.semanas || {})) for (const [k, t] of Object.entries(sem)) {
    if (!k.startsWith('m-itf')) continue;
    const ini = t.fechas?.quali || t.fechas?.main, fin = t.fechas?.final || ini;
    if (ini && ini <= hasta && fin >= desde && !out.some(x => x.clave === k)) out.push({ clave: k, nombre: t.nombre });
  }
  return out;
}

const esCli = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (esCli) {
  const i = process.argv.indexOf('--horas'); const h = i > 0 ? +process.argv[i + 1] : 8;
  const L = torneosAhora(h);
  if (process.argv.includes('--claves')) console.log(L.map(x => x.clave).join(' '));
  else if (process.argv.includes('--nombres')) console.log(L.map(x => ciudadCorta(x.nombre)).join(','));
  else { console.log(`torneos con partidos en las próximas ${h} h:`);
    for (const x of L) console.log('  ' + x.nombre.padEnd(26) + x.clave); }
}
