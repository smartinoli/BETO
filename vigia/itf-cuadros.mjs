#!/usr/bin/env node
/* ============================================================
   ITF-CUADROS — baja SOLO los cuadros (drawsheet) de los torneos pedidos.

   Nació como rescate a mano el 2026-09-01 y el 02 fue lo que funcionó:
   ir directo al cuadro de tres o cuatro torneos, sin order of play (que
   a veces no publica días y aborta el pase normal) y sin recorrer los
   17 de la semana. Cada torneo que el WAF bloquea se reintenta UNA vez
   con sesión de navegador nueva, que es lo que suele destrabarlo.

   Uso:  node vigia/itf-cuadros.mjs --ahora 8          los que juegan en 8 h
         node vigia/itf-cuadros.mjs m-itf-chn-2026-025  claves sueltas
   ============================================================ */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { abrirNavegador, fetchDesdePagina, pausaHumana, DATOS } from './itf-navegador.mjs';
import { normalizarEventos, normalizarCuadro } from './itf.mjs';
import { torneosAhora } from './itf-ahora.mjs';

const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i > 0 ? process.argv[i + 1] : d };
const claves = arg('ahora', null) != null
  ? torneosAhora(+arg('ahora', 8)).map(x => x.clave)
  : process.argv.slice(2).filter(a => a.startsWith('m-itf'));
if (!claves.length) { console.log('nada que bajar'); process.exit(0) }

const mapa = JSON.parse(fs.readFileSync(path.join(DATOS, 'torneos.json'), 'utf8'));
const enlaceDe = k => { for (const s of Object.values(mapa.semanas || {})) if (s[k]?.enlace) return s[k].enlace; return mapa.torneos?.[k]?.enlace || null };
const api = 'https://www.itftennis.com/tennis/api/TournamentApi/';

async function bajar(page, clave) {
  const enlace = enlaceDe(clave); if (!enlace) throw new Error('sin enlace en el mapa');
  await page.goto(enlace + 'draws/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(6000);
  const ev = normalizarEventos(await fetchDesdePagina(page, `${api}GetEventFilters?tournamentKey=${clave}`), clave);
  const cuadros = {};
  for (const c of ev.cuadros.filter(c => c.tipo === 'S')) {
    await pausaHumana();
    cuadros[c.evento] = normalizarCuadro(await fetchDesdePagina(page,
      `${api}GetDrawsheet?eventClassificationCode=${c.evento}&matchTypeCode=S&tourType=${ev.tourType}&tournamentId=${ev.tournamentId}&weekNumber=0`));
  }
  fs.mkdirSync(path.join(DATOS, 'vivo'), { recursive: true });
  fs.writeFileSync(path.join(DATOS, 'vivo', clave + '.json'), JSON.stringify({ clave, bajado: new Date().toISOString(), cuadros }));
  return (cuadros.M?.rondas || []).reduce((s, r) => s + r.partidos.filter(p => p.estado === 'jugado').length, 0);
}

console.log(`Cuadros de ${claves.length} torneos: ${claves.join(' ')}`);
let pendientes = [...claves], ok = 0;
for (let vuelta = 1; vuelta <= 2 && pendientes.length; vuelta++) {
  if (vuelta === 2) console.log(`— reintento con sesión nueva: ${pendientes.join(' ')}`);
  const { browser, ctx } = await abrirNavegador();
  const fallidos = [];
  try {
    const page = await ctx.newPage();
    for (const k of pendientes) {
      try { const n = await bajar(page, k); ok++; console.log(`  ✓ ${k}: ${n} jugados en el main`); }
      catch (e) { fallidos.push(k); console.log(`  ✗ ${k}: ${String(e.message).split(' para ')[0].slice(0, 80)}`); }
    }
  } finally { await browser.close(); }
  pendientes = fallidos;
}
console.log(`Listo: ${ok}/${claves.length} cuadros al día` + (pendientes.length ? ` · sin poder bajar: ${pendientes.join(' ')}` : ''));
