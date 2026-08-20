#!/usr/bin/env node
/* ============================================================
   ITF-AGENDA — qué se viene, con el pasado cercano de cada jugador.

   La vuelta de tuerca: en vez de partir por las cuotas, partir por el
   circuito. Para cada torneo en juego muestra los partidos POR JUGARSE
   con todo el contexto que el scraper sabe de cada lado:
     · seed y estado de entrada (DA/Q/LL/WC/SE)
     · ranking ATP y WTN si la entry list fue fotografiada (datos/itf/)
     · cómo llega: sus resultados EN ESTE torneo (qualis incluidas),
       set a set, con marca de retiro si la hay
   Con eso decides qué mirar en las cuotas — no al revés.

   Solo endpoints abiertos (fetch pelado, sin navegador). Sin dependencias.

   Uso:
     node vigia/itf-agenda.mjs                   torneos en juego / por venir (caché)
     node vigia/itf-agenda.mjs semana [N]        agenda de hasta N torneos en juego (def 6)
     node vigia/itf-agenda.mjs <clave|url>…      agenda de torneos puntuales
   ============================================================ */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { eventos, cuadro, parseClave } from './itf.mjs';
import { pareceElMismo, normalizar } from './itf-cruce.mjs';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const DATOS = path.join(DIR, 'datos', 'itf');
const CACHE_CALENDARIO = path.join(DIR, 'itf-calendario.json');

const hoy = () => new Date().toISOString().slice(0, 10);

function calendario() {
  try { return JSON.parse(fs.readFileSync(CACHE_CALENDARIO, 'utf8')).torneos } catch { return []; }
}

/* ---------- ranking desde la entry list fotografiada ---------- */
function rankingsDe(clave) {
  try {
    const a = JSON.parse(fs.readFileSync(path.join(DATOS, clave + '.aceptacion.json'), 'utf8'));
    const todos = [];
    for (const seccion of Object.values(a.secciones)) todos.push(...seccion);
    return todos;
  } catch { return []; }
}

function rankDe(nombre, listado) {
  const e = listado.find(x => pareceElMismo(nombre, { nombre: x.nombre }));
  return e ? { atp: e.atp, wtn: e.wtn } : null;
}

/* ---------- cómo llega: trayectoria dentro del torneo ---------- */
function trayectoria(nombre, cuadros) {
  const pasos = [];
  /* Qualis primero y luego main, en orden de ronda: así se lee la campaña. */
  const ordenado = Object.entries(cuadros).sort(([a], [b]) => (a === 'Q' ? 0 : 1) - (b === 'Q' ? 0 : 1));
  for (const [evento, c] of ordenado) {
    for (const r of c.rondas) {
      for (const p of r.partidos) {
        if (p.estado !== 'jugado') continue;
        const idx = p.lados.findIndex(l => pareceElMismo(nombre, l));
        if (idx < 0) continue;
        const yo = p.lados[idx], rival = p.lados[1 - idx];
        const ronda = (evento === 'Q' ? 'Q' + r.numero : ({ 1: 'R1', 2: 'R2', 3: 'QF', 4: 'SF', 5: 'F' }[r.numero] || 'R' + r.numero));
        const marcador = (yo.ganador ? yo : rival).sets.join(' ');
        pasos.push(ronda + (yo.ganador ? '✓' : '✗') + ' ' + marcador
          + (/retired/i.test(p.nota || '') ? (yo.ganador ? ' (rival ret.)' : ' ⚠RET') : '')
          + (/walkover/i.test(p.nota || '') ? ' wo' : ''));
      }
    }
  }
  return pasos;
}

/* ---------- agenda de un torneo ---------- */
const etiqueta = l => {
  if (!l?.nombre) return '—';
  const extras = [l.seed ? `[${l.seed}]` : null, l.entrada && l.entrada !== 'DA' ? l.entrada : null].filter(Boolean);
  return l.nombre + (extras.length ? ' (' + extras.join(', ') + ')' : '');
};

async function agendaDe(clave, meta = {}) {
  const ev = await eventos(clave);
  const cuadros = {};
  for (const c of ev.cuadros.filter(c => c.tipo === 'S')) {
    cuadros[c.evento] = await cuadro({ tournamentId: ev.tournamentId, tourType: ev.tourType, evento: c.evento, tipo: 'S' });
  }
  const listado = rankingsDe(clave);
  const cab = [meta.categoria, meta.bolsa, meta.superficie, meta.techo].filter(Boolean).join(' · ');
  console.log(`\n════ ${meta.nombre || clave} ${cab ? '(' + cab + ')' : ''} ${meta.desde ? meta.desde + '→' + meta.hasta : ''} ════`);
  let alguno = false;
  for (const [evento, c] of Object.entries(cuadros)) {
    for (const r of c.rondas) {
      const pendientes = r.partidos.filter(p => p.estado === 'pendiente' && p.lados.every(l => l.nombre));
      if (!pendientes.length) continue;
      alguno = true;
      console.log(`\n  ${evento === 'Q' ? 'QUALIS ' : ''}${r.nombre} — ${pendientes.length} por jugar`);
      for (const p of pendientes) {
        console.log(`   ${etiqueta(p.lados[0])}  vs  ${etiqueta(p.lados[1])}`);
        for (const l of p.lados) {
          const rk = rankDe(l.nombre, listado);
          const tray = trayectoria(l.nombre, cuadros);
          const partes = [
            rk?.atp ? `ATP ${rk.atp}` : (rk?.wtn ? `WTN ${rk.wtn}` : 'sin rank en entry'),
            tray.length ? 'llega: ' + tray.join(' · ') : 'debuta en el torneo',
          ];
          console.log(`     · ${l.nombre}: ${partes.join(' | ')}`);
        }
      }
    }
  }
  if (!alguno) console.log('  (sin partidos pendientes con ambos jugadores definidos)');
}

/* ---------- CLI ---------- */
const args = process.argv.slice(2);
const cal = calendario();
const activos = cal.filter(t => t.desde <= hoy() && t.hasta >= hoy());
const porVenir = cal.filter(t => t.desde > hoy());

if (!args.length) {
  console.log(`Torneos EN JUEGO (${activos.length}) según caché del ${hoy()}:`);
  for (const t of activos) console.log(`  ${t.clave}  ${t.categoria} ${String(t.bolsa || '?').padEnd(8)} ${t.nombre} (${t.pais}, ${t.superficie}) ${t.desde}→${t.hasta}`);
  console.log(`\nPor venir (${porVenir.length}):`);
  for (const t of porVenir.slice(0, 40)) console.log(`  ${t.clave}  ${t.categoria} ${String(t.bolsa || '?').padEnd(8)} ${t.nombre} (${t.pais}, ${t.superficie}) ${t.desde}→${t.hasta}`);
  console.log('\nAgenda detallada: node vigia/itf-agenda.mjs semana [N]  |  node vigia/itf-agenda.mjs <clave…>');
} else if (args[0] === 'semana') {
  const n = +args[1] || 6;
  const lista = activos.slice(0, n);
  console.log(`Agenda de ${lista.length} torneos en juego (de ${activos.length}; sube el límite con "semana ${activos.length}")`);
  for (const t of lista) {
    try { await agendaDe(t.clave, t); }
    catch (e) { console.log(`\n✗ ${t.clave}: ${e.message}`); if (e.waf) { console.log('  (WAF activo: corto acá; reintenta en un rato)'); break; } }
  }
} else {
  for (const arg of args) {
    const clave = parseClave(arg);
    const meta = cal.find(t => t.clave === clave) || {};
    try { await agendaDe(clave, meta); }
    catch (e) { console.log(`\n✗ ${clave}: ${e.message}`); if (e.waf) break; }
  }
}
