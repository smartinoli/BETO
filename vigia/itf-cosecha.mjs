#!/usr/bin/env node
/* ============================================================
   ITF-COSECHA — baja torneos terminados del World Tennis Tour y
   mide su comportamiento: qualifiers, lucky losers, retiros,
   walkovers, rendimiento de seeds y resultados por ronda.

   La "entry list" original (acceptance list previa al torneo) NO está
   en la API abierta: lo que queda como registro fósil de los cambios
   son los estados de entrada del cuadro — LL (lucky loser) = alguien
   se bajó después de las qualis; A (alternate) = entró por retiro
   previo; WO/Retired = bajas durante el torneo. Para medir "qué cambió
   en la entry list" hacia adelante hay que fotografiar los cuadros a
   diario, no existe historia hacia atrás.

   Uso:
     node vigia/itf-cosecha.mjs cosechar [N]        baja los últimos N torneos
                                                    terminados del caché (def. 20)
     node vigia/itf-cosecha.mjs cosechar <claves…>  baja torneos puntuales
     node vigia/itf-cosecha.mjs resumen             estadísticas sobre lo cosechado

   Guarda un JSON por torneo en vigia/datos/itf/. Ritmo: ~1 request
   cada 1.5 s (3 por torneo) para no despertar al WAF.
   ============================================================ */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { eventos, cuadro } from './itf.mjs';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const DATOS = path.join(DIR, 'datos', 'itf');
const CACHE_CALENDARIO = path.join(DIR, 'itf-calendario.json');

/* ---------- cosecha ---------- */
async function cosecharUno(clave, meta = {}) {
  const ev = await eventos(clave);
  const out = { clave: ev.clave, tournamentId: ev.tournamentId, ...meta, cuadros: {} };
  for (const c of ev.cuadros.filter(c => c.tipo === 'S')) {
    out.cuadros[c.evento] = await cuadro({ tournamentId: ev.tournamentId, tourType: ev.tourType, evento: c.evento, tipo: 'S' });
  }
  return out;
}

async function cosechar(args) {
  fs.mkdirSync(DATOS, { recursive: true });
  let lista;
  if (args.length && isNaN(+args[0])) {
    lista = args.map(clave => ({ clave: clave.toLowerCase() }));
  } else {
    const n = +args[0] || 20;
    const hoy = new Date().toISOString().slice(0, 10);
    let cache;
    try { cache = JSON.parse(fs.readFileSync(CACHE_CALENDARIO, 'utf8')) } catch {
      console.error('No hay caché de calendario (vigia/itf-calendario.json). Corre antes: node vigia/itf.mjs calendario');
      process.exit(1);
    }
    lista = cache.torneos.filter(t => t.hasta < hoy).sort((a, b) => b.hasta.localeCompare(a.hasta)).slice(0, n);
  }
  console.log(`Cosechando ${lista.length} torneos (≈${lista.length * 3} requests pausados)…`);
  let ok = 0, mal = 0;
  for (const t of lista) {
    const destino = path.join(DATOS, t.clave + '.json');
    if (fs.existsSync(destino)) { console.log(`  = ${t.clave} ya estaba`); ok++; continue; }
    try {
      const d = await cosecharUno(t.clave, t);
      fs.writeFileSync(destino, JSON.stringify(d));
      const nM = (d.cuadros.M?.rondas || []).reduce((s, r) => s + r.partidos.filter(p => p.estado === 'jugado').length, 0);
      const nQ = (d.cuadros.Q?.rondas || []).reduce((s, r) => s + r.partidos.filter(p => p.estado === 'jugado').length, 0);
      console.log(`  ✓ ${t.clave}  ${t.nombre || ''}  main:${nM} qualis:${nQ}`);
      ok++;
    } catch (e) { console.log(`  ✗ ${t.clave}: ${e.message}`); mal++; }
  }
  console.log(`Listo: ${ok} torneos, ${mal} fallos. Datos en vigia/datos/itf/`);
}

/* ---------- resumen ---------- */
const cargar = () => fs.readdirSync(DATOS).filter(f => f.endsWith('.json') && !f.endsWith('.aceptacion.json'))
  .map(f => JSON.parse(fs.readFileSync(path.join(DATOS, f), 'utf8')));

const pct = (a, b) => b ? (100 * a / b).toFixed(1) + '%' : '—';

function resumen() {
  const ts = cargar();
  if (!ts.length) { console.log('Nada cosechado aún.'); return; }

  const acc = {
    torneos: ts.length, partidosM: 0, partidosQ: 0,
    r1: 0, r1ConQ: 0, r1ConLL: 0, r1ConWC: 0,
    qVsNoQ: 0, qGana: 0, llVsNoLL: 0, llGana: 0,
    retirosM: 0, woM: 0, retirosQ: 0, woQ: 0,
    retirosPorRonda: {}, seedsR1: 0, seedsR1Ganan: 0,
    campeones: { seed: 0, top4: 0, q: 0, sinSeed: 0 },
    llPorTorneo: [],
  };

  for (const t of ts) {
    const M = t.cuadros.M, Q = t.cuadros.Q;
    let lls = new Set();
    for (const r of M?.rondas || []) {
      for (const p of r.partidos) {
        if (p.estado !== 'jugado') continue;
        acc.partidosM++;
        if (/retired/i.test(p.nota || '')) { acc.retirosM++; acc.retirosPorRonda[r.nombre] = (acc.retirosPorRonda[r.nombre] || 0) + 1; }
        if (/walkover/i.test(p.nota || '')) acc.woM++;
        const [a, b] = p.lados;
        for (const l of p.lados) if (l.entrada === 'LL') l.jugadores.forEach(j => lls.add(j.id));
        if (r.numero === 1) {
          acc.r1++;
          if (p.lados.some(l => l.entrada === 'Q')) acc.r1ConQ++;
          if (p.lados.some(l => l.entrada === 'LL')) acc.r1ConLL++;
          if (p.lados.some(l => l.entrada === 'WC')) acc.r1ConWC++;
          /* qualifier contra no-qualifier: ¿quién gana? */
          const q = p.lados.find(l => l.entrada === 'Q'), noQ = p.lados.find(l => l.entrada !== 'Q');
          if (q && noQ && noQ.entrada !== 'Q') { acc.qVsNoQ++; if (q.ganador) acc.qGana++; }
          const ll = p.lados.find(l => l.entrada === 'LL'), noLL = p.lados.find(l => l.entrada !== 'LL');
          if (ll && noLL && noLL.entrada !== 'LL') { acc.llVsNoLL++; if (ll.ganador) acc.llGana++; }
          const s = p.lados.find(l => l.seed), noS = p.lados.find(l => !l.seed);
          if (s && noS) { acc.seedsR1++; if (s.ganador) acc.seedsR1Ganan++; }
        }
      }
    }
    acc.llPorTorneo.push(lls.size);
    /* campeón */
    const final = (M?.rondas || []).find(r => /final/i.test(r.nombre) && !/semi|quarter/i.test(r.nombre));
    const ganador = final?.partidos?.[0]?.lados?.find(l => l.ganador);
    if (ganador) {
      if (ganador.seed) { acc.campeones.seed++; if (ganador.seed <= 4) acc.campeones.top4++; }
      else acc.campeones.sinSeed++;
      if (ganador.entrada === 'Q' || ganador.entrada === 'LL') acc.campeones.q++;
    }
    for (const r of Q?.rondas || []) {
      for (const p of r.partidos) {
        if (p.estado !== 'jugado') continue;
        acc.partidosQ++;
        if (/retired/i.test(p.nota || '')) acc.retirosQ++;
        if (/walkover/i.test(p.nota || '')) acc.woQ++;
      }
    }
  }

  const llTot = acc.llPorTorneo.reduce((a, b) => a + b, 0);
  console.log(`\n════ Comportamiento de ${acc.torneos} torneos ITF cosechados ════

Partidos jugados: ${acc.partidosM} main draw · ${acc.partidosQ} qualis

— Primera ronda del main draw (${acc.r1} partidos) —
Con al menos un qualifier:   ${acc.r1ConQ} (${pct(acc.r1ConQ, acc.r1)})
Con un lucky loser:          ${acc.r1ConLL} (${pct(acc.r1ConLL, acc.r1)})
Con un wild card:            ${acc.r1ConWC} (${pct(acc.r1ConWC, acc.r1)})
Qualifier vs no-qualifier:   ${acc.qVsNoQ} partidos → qualifier gana ${acc.qGana} (${pct(acc.qGana, acc.qVsNoQ)})
Lucky loser vs resto:        ${acc.llVsNoLL} partidos → LL gana ${acc.llGana} (${pct(acc.llGana, acc.llVsNoLL)})
Seed vs no-seed:             ${acc.seedsR1} partidos → seed gana ${acc.seedsR1Ganan} (${pct(acc.seedsR1Ganan, acc.seedsR1)})

— Bajas (la huella de los cambios de entry list) —
Lucky losers que entraron al main: ${llTot} (${(llTot / acc.torneos).toFixed(1)} por torneo = retiros post-qualis)
Retiros en cancha (main):    ${acc.retirosM} (${pct(acc.retirosM, acc.partidosM)} de los partidos)
Walkovers (main):            ${acc.woM} (${pct(acc.woM, acc.partidosM)})
Retiros en qualis:           ${acc.retirosQ} (${pct(acc.retirosQ, acc.partidosQ)})
Walkovers en qualis:         ${acc.woQ} (${pct(acc.woQ, acc.partidosQ)})
Retiros main por ronda:      ${Object.entries(acc.retirosPorRonda).map(([r, n]) => `${r}: ${n}`).join(' · ') || '—'}

— Campeones —
Con seed: ${acc.campeones.seed}/${acc.torneos} (top-4: ${acc.campeones.top4}) · sin seed: ${acc.campeones.sinSeed} · venidos de qualis/LL: ${acc.campeones.q}
`);
  resumenAceptacion();
}

/* Entry lists fotografiadas (solo existen para torneos en curso/futuros:
   ITF las borra al terminar — ver itf-navegador.mjs). */
function resumenAceptacion() {
  const fs2 = fs.readdirSync(DATOS).filter(f => f.endsWith('.aceptacion.json'));
  if (!fs2.length) return;
  console.log(`— Entry lists fotografiadas (${fs2.length} torneos vivos/futuros) —`);
  for (const f of fs2.sort()) {
    const a = JSON.parse(fs.readFileSync(path.join(DATOS, f), 'utf8'));
    const s = a.secciones, mda = s.MDA || [];
    const rankeados = mda.map(e => e.atp).filter(Boolean);
    const corte = rankeados.length ? Math.max(...rankeados) : null;
    const mejor = rankeados.length ? Math.min(...rankeados) : null;
    console.log(`  ${a.clave}  MDA:${mda.length} (ATP ${mejor ?? '—'}–${corte ?? '—'}, ${mda.length - rankeados.length} sin rank) · Q:${(s.Q || []).length} · alt:${(s.A || []).length} · retiros pre-torneo:${(s.W || []).length}`);
  }
  console.log();
}

const [cmd, ...args] = process.argv.slice(2);
if (cmd === 'cosechar') await cosechar(args);
else if (cmd === 'resumen') resumen();
else console.log('Uso: node vigia/itf-cosecha.mjs cosechar [N|claves…] | resumen');
