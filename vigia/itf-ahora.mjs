#!/usr/bin/env node
/* ============================================================
   ITF-AHORA — qué torneos nuestros tienen partidos por jugarse pronto.

   La idea que funcionó el 2026-09-02: mirar solo lo que está por
   jugarse, no la semana entera. Sale del índice de la API (un pedido,
   ya capturado en historico-indice.json): los torneos con partidos que
   empiezan en las próximas N horas, cruzados con nuestro mapa de
   torneos masculinos por ciudad — el mismo cruce que usa la tanda.

   Uso:  node vigia/itf-ahora.mjs [--horas 8]        lista claves y nombres
   Desde código: torneosAhora(horas) → [{clave, nombre, partidos}]
   ============================================================ */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NORM } from './itf-reglas.mjs';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const DATOS = path.join(DIR, 'datos', 'itf');
const leer = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')) } catch { return null } };

/* trozo del nombre que la tanda entiende con --torneos (la ciudad) */
export const ciudadCorta = n => String(n).replace(/^[MW]\d+\+?H?\s*/i, '').split(/[\s,]/)[0].toLowerCase();

export function torneosAhora(horas = 8) {
  const idx = leer(path.join(DATOS, 'historico-indice.json'));
  const mapa = leer(path.join(DATOS, 'torneos.json'));
  if (!idx || !mapa) return [];
  const HOY = new Date().toISOString().slice(0, 10);
  const prio = t => { const i = t.fechas?.quali || t.fechas?.main, f = t.fechas?.final;
    if (!i) return 0; if (i <= HOY && (!f || f >= HOY)) return 3; if (i > HOY) return 2; return 1 };
  const TOR = {};
  for (const sem of Object.values(mapa.semanas || {})) for (const [k, t] of Object.entries(sem)) {
    if (!k.startsWith('m-itf')) continue;
    (TOR[t.nombre] ||= []).push({ clave: k, prio: prio(t) });
  }
  for (const e of Object.values(TOR)) e.sort((a, b) => b.prio - a.prio);
  const ciudad = s => NORM(String(s).replace(/^[MW]\d+\+?H?\s*/i, ''));
  /* "Kursumlijska Banja" calza con el M25 de hace tres semanas Y con el
     M15 de esta: se mira TODO lo que calza y gana la edición en juego */
  const torneoDe = c0 => { const c = NORM(c0); let mejor = null;
    for (const [n, eds] of Object.entries(TOR))
      if (ciudad(n) === c || ciudad(n).startsWith(c) || c.startsWith(ciudad(n)))
        for (const e of eds) if (!mejor || e.prio > mejor.prio) mejor = { nombre: n, clave: e.clave, prio: e.prio };
    return mejor && mejor.prio >= 2 ? mejor : null };
  const ahora = Date.now(), hasta = ahora + horas * 36e5;
  const cuenta = new Map();
  for (const p of Object.values(idx.partidos || {})) {
    if (!/men/i.test(p.categoria || '') || /women/i.test(p.categoria || '')) continue;   /* solo ITF Men */
    const t = Date.parse(p.startTime);
    if (!(t > ahora + 10 * 60e3 && t < hasta)) continue;
    const tt = torneoDe(p.torneo); if (!tt) continue;
    const e = cuenta.get(tt.clave) || { ...tt, partidos: 0 };
    e.partidos++; cuenta.set(tt.clave, e);
  }
  return [...cuenta.values()].sort((a, b) => b.partidos - a.partidos);
}

const esCli = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (esCli) {
  const i = process.argv.indexOf('--horas'); const h = i > 0 ? +process.argv[i + 1] : 8;
  const L = torneosAhora(h);
  if (process.argv.includes('--claves')) console.log(L.map(x => x.clave).join(' '));
  else if (process.argv.includes('--nombres')) console.log(L.map(x => ciudadCorta(x.nombre)).join(','));
  else { console.log(`torneos con partidos en las próximas ${h} h:`);
    for (const x of L) console.log('  ' + x.nombre.padEnd(26) + x.clave.padEnd(20) + x.partidos + ' partidos'); }
}
