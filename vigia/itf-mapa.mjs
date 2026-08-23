#!/usr/bin/env node
/* ============================================================
   ITF-MAPA — el registro maestro de torneos: datos/itf/torneos.json

   Solo HOMBRES SINGLES (claves m-itf-*): M15/M25. Mujeres y dobles
   quedan fuera desde el origen (decisión 2026-08-22).

   Una entrada por torneo, agrupadas por semana ISO del lunes del main
   draw. Cada entrada dice QUÉ tenemos en disco y de CUÁNDO (frescura),
   para que el scraper (itf-scrap.mjs) baje solo lo que falta y el panel
   (itf-control.mjs) muestre el estado de un vistazo.

   El ESTADO de un torneo se calcula por fechas, no se guarda:
     PROXIMO    hoy < quali          (quali estimada: desde − 2 días)
     QUALI      quali ≤ hoy < desde
     MAIN       desde ≤ hoy ≤ hasta
     TERMINADO  hoy > hasta
   Lo único persistente es "archivado": lo marca el orquestador cuando el
   torneo terminó y no quedan filas del registro por cerrar. Un torneo
   archivado no se vuelve a scrapear jamás.

   La frescura NO se fía de mtimes: lee el campo "bajado" que cada
   artefacto guarda adentro. Rutas actuales (sin migrar, para no romper
   la mesa): <clave>.aceptacion.json · vivo/<clave>.json · oop/<clave>-<fecha>.json

   Uso:  node vigia/itf-mapa.mjs           reconstruye y muestra resumen
         import { cargarMapa, refrescarMapa, guardarMapa, estadoDe } ...
   ============================================================ */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const DATOS = path.join(DIR, 'datos', 'itf');
const MAPA = path.join(DATOS, 'torneos.json');
const CAL = path.join(DIR, 'itf-calendario.json');
const REG = path.join(DIR, 'itf-registro.json');

const leer = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')) } catch { return null } };

/* Semana ISO del lunes de main draw: "2026-W35". */
export function semanaISO(fecha) {
  const d = new Date(fecha + 'T12:00:00Z');
  const dia = (d.getUTCDay() + 6) % 7;               // lunes=0
  d.setUTCDate(d.getUTCDate() - dia + 3);            // jueves de esa semana
  const enero4 = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  const sem = 1 + Math.round(((d - enero4) / 864e5 - 3 + ((enero4.getUTCDay() + 6) % 7)) / 7);
  return d.getUTCFullYear() + '-W' + String(sem).padStart(2, '0');
}

export function estadoDe(t, hoy = new Date().toISOString().slice(0, 10)) {
  if (t.archivado) return 'ARCHIVADO';
  const quali = t.fechas.quali;
  if (hoy < quali) return 'PROXIMO';
  if (hoy < t.fechas.main) return 'QUALI';
  if (hoy <= t.fechas.final) return 'MAIN';
  return 'TERMINADO';
}

/* frescura real de lo que hay en disco para una clave */
function frescuraDe(clave) {
  const f = { aceptacion: null, cuadroM: null, cuadroQ: null, oop: {} };
  const acc = leer(path.join(DATOS, clave + '.aceptacion.json'));
  if (acc?.bajado) f.aceptacion = acc.bajado;
  const vivo = leer(path.join(DATOS, 'vivo', clave + '.json'));
  if (vivo?.bajado) {
    if (vivo.cuadros?.M) f.cuadroM = vivo.bajado;
    if (vivo.cuadros?.Q) f.cuadroQ = vivo.bajado;
  }
  /* cuadros históricos (torneo ya cosechado post-final, otra ruta) */
  const hist = leer(path.join(DATOS, clave + '.json'));
  if (hist?.cuadros && !f.cuadroM) { f.cuadroM = 'historico'; f.cuadroQ = hist.cuadros.Q ? 'historico' : f.cuadroQ; }
  let dirOop = [];
  try { dirOop = fs.readdirSync(path.join(DATOS, 'oop')) } catch {}
  for (const a of dirOop) {
    if (!a.startsWith(clave + '-2')) continue;
    const fecha = a.slice(clave.length + 1, clave.length + 11);
    const j = leer(path.join(DATOS, 'oop', a));
    if (j?.bajado) f.oop[fecha] = j.bajado;
  }
  return f;
}

/* filas del registro de apuestas aún sin resultado, por nombre de torneo */
function pendientesPorTorneo() {
  const reg = leer(REG);
  const out = {};
  for (const e of Object.values(reg?.partidos || {}))
    if (!e.resultado) out[e.torneo] = (out[e.torneo] || 0) + 1;
  return out;
}

export function cargarMapa() { return leer(MAPA) || { actualizado: null, semanas: {} }; }
export function guardarMapa(m) { m.actualizado = new Date().toISOString(); fs.writeFileSync(MAPA, JSON.stringify(m, null, 1)); }

/* Reconstruye el mapa desde el calendario + disco, preservando "archivado". */
export function refrescarMapa() {
  const cal = leer(CAL);
  if (!cal?.torneos) throw new Error('falta itf-calendario.json: corre el navegador con "calendario"');
  const previo = cargarMapa();
  const archivados = new Set();
  for (const sem of Object.values(previo.semanas)) for (const [k, t] of Object.entries(sem)) if (t.archivado) archivados.add(k);
  const pend = pendientesPorTorneo();
  const m = { actualizado: null, nota: 'registro maestro de torneos ITF, solo hombres singles (M15/M25)', semanas: {} };
  for (const t of cal.torneos) {
    if (!t.clave.startsWith('m-itf')) continue;         // solo hombres
    if (!t.desde || !t.hasta) continue;
    const quali = new Date(new Date(t.desde + 'T12:00:00Z').getTime() - 2 * 864e5).toISOString().slice(0, 10);
    const sem = semanaISO(t.desde);
    (m.semanas[sem] = m.semanas[sem] || {})[t.clave] = {
      nombre: t.nombre, pais: t.pais, categoria: t.categoria, superficie: t.superficie,
      bolsa: t.bolsa, sede: t.sede || null, enlace: t.enlace,
      fechas: { quali, main: t.desde, final: t.hasta },
      archivado: archivados.has(t.clave),
      frescura: frescuraDe(t.clave),
      pendientesDeCierre: pend[t.nombre] || 0,
    };
  }
  guardarMapa(m);
  return m;
}

/* lista plana [clave, torneo, semana, estado] */
export function torneosDelMapa(m, hoy = new Date().toISOString().slice(0, 10)) {
  const out = [];
  for (const [sem, ts] of Object.entries(m.semanas))
    for (const [clave, t] of Object.entries(ts))
      out.push({ clave, sem, t, estado: estadoDe(t, hoy) });
  return out.sort((a, b) => a.t.fechas.main.localeCompare(b.t.fechas.main) || a.clave.localeCompare(b.clave));
}

/* ---------- CLI ---------- */
const esCli = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (esCli) {
  const m = refrescarMapa();
  const filas = torneosDelMapa(m);
  const porEstado = {};
  for (const f of filas) porEstado[f.estado] = (porEstado[f.estado] || 0) + 1;
  console.log(`✓ datos/itf/torneos.json · ${filas.length} torneos M15/M25 en ${Object.keys(m.semanas).length} semanas`);
  console.log('  ' + Object.entries(porEstado).map(([k, v]) => `${k}:${v}`).join(' · '));
  for (const f of filas.filter(x => x.estado !== 'ARCHIVADO' && x.estado !== 'TERMINADO')) {
    const fr = f.t.frescura;
    const hoy = new Date().toISOString().slice(0, 10);
    console.log(`  ${f.estado.padEnd(9)} ${f.t.nombre.padEnd(24)} acc:${fr.aceptacion ? '✓' : '✗'} M:${fr.cuadroM ? '✓' : '·'} Q:${fr.cuadroQ ? '✓' : '·'} oopHoy:${fr.oop[hoy] ? fr.oop[hoy].slice(11, 16) : '—'}`);
  }
}
