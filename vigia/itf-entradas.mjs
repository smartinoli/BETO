#!/usr/bin/env node
/* ============================================================
   ITF-ENTRADAS — qué pasó entre la lista de aceptación y el cuadro.

   La acceptance list no es una foto del torneo: es una COLA. Trae
   MDA (aceptados al cuadro principal), Q (aceptados a la clasificación),
   A (suplentes esperando) y W (retirados, con fecha y a veces con el
   torneo al que se fueron). Cuando alguien se baja, sube un suplente.

   Este script mide, para cada torneo:
     · cuántos del cuadro real venían de cada sección
     · cuánto hubo que bajar a la lista de suplentes (la DILUCIÓN)
     · cuántos rankeados se retiraron y adónde se fueron
     · quién quedó de cabeza de serie y quién lo habría sido sin retiros
   y después prueba si la dilución cambia lo predecible que es el torneo.

   Uso:  node vigia/itf-entradas.mjs
   ============================================================ */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const DATOS = path.join(DIR, 'datos', 'itf');
const norm = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z ]/g, ' ').replace(/\s+/g, ' ').trim();
const leer = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')) } catch { return null } };

/* "W 11 Aug 2026" · "AW 11 Aug 2026 M25 Lausanne" → fecha y destino */
function parseRetiro(info) {
  if (!info) return {};
  const m = String(info).match(/^(A?W)\s+(\d{1,2}\s+\w{3}\s+\d{4})\s*(.*)$/);
  if (!m) return { crudo: info };
  return { tipo: m[1], fecha: m[2], destino: m[3].trim() || null };
}

const torneos = [];
for (const f of fs.readdirSync(DATOS)) {
  if (!f.endsWith('.aceptacion.json') || !f.startsWith('m-itf')) continue;
  const clave = f.replace('.aceptacion.json', '');
  const acc = leer(path.join(DATOS, f));
  const cuadro = leer(path.join(DATOS, 'vivo', clave + '.json')) || leer(path.join(DATOS, clave + '.json'));
  if (!acc || !cuadro?.cuadros) continue;

  /* sección de cada inscrito, y su ficha */
  const seccion = new Map(), ficha = new Map();
  for (const [sec, arr] of Object.entries(acc.secciones || {}))
    for (const p of arr) { seccion.set(norm(p.nombre), sec); ficha.set(norm(p.nombre), p); }

  const t = { clave, bajado: acc.bajado, cuadros: {}, retiros: null, siembra: {} };
  for (const [ev, c] of Object.entries(cuadro.cuadros)) {
    const jug = new Map();
    for (const r of c.rondas || []) for (const p of r.partidos) for (const l of p.lados)
      if (l.nombre) jug.set(norm(l.nombre), l);
    const de = { MDA: 0, Q: 0, A: 0, JR: 0, CA: 0, W: 0, fuera: 0 };
    for (const n of jug.keys()) {
      const s = seccion.get(n);
      if (s && de[s] != null) de[s]++; else de.fuera++;
    }
    t.cuadros[ev] = { total: jug.size, de,
      /* dilución: qué fracción del cuadro NO estaba aceptada de entrada */
      dilucion: jug.size ? (de.A + de.fuera) / jug.size : null };

    /* cabezas de serie reales, con su nivel */
    const seeds = [...jug.values()].filter(l => l.seed).sort((a, b) => a.seed - b.seed).slice(0, 4)
      .map(l => { const fi = ficha.get(norm(l.nombre)) || {}; return { seed: l.seed, nombre: l.nombre, atp: fi.atp ?? null, wtn: fi.wtn ?? null }; });
    t.siembra[ev] = seeds;
  }

  /* retiros: cuántos, cuántos rankeados, y adónde se fueron */
  const W = (acc.secciones.W || []).map(p => ({ ...p, ...parseRetiro(p.info) }));
  const conAtp = W.filter(p => p.atp != null);
  const destinos = {};
  for (const p of W) if (p.destino) destinos[p.destino] = (destinos[p.destino] || 0) + 1;
  t.retiros = {
    total: W.length, conRanking: conAtp.length,
    mejorAtp: conAtp.length ? Math.min(...conAtp.map(p => p.atp)) : null,
    /* los que se fueron A OTRO TORNEO son los que más dicen del campo */
    aOtroTorneo: W.filter(p => p.destino).length,
    destinos: Object.entries(destinos).sort((a, b) => b[1] - a[1]).slice(0, 5),
    top: conAtp.sort((a, b) => a.atp - b.atp).slice(0, 6)
      .map(p => ({ atp: p.atp, nombre: p.nombre, fecha: p.fecha, destino: p.destino })),
  };
  torneos.push(t);
}

fs.writeFileSync(path.join(DIR, 'itf-entradas.json'), JSON.stringify({ generado: new Date().toISOString(), torneos }, null, 1));

/* ---------- salida ---------- */
const pc = v => v == null ? '  — ' : (v * 100).toFixed(0).padStart(3) + '%';
console.log(`${torneos.length} torneos con lista de aceptación y cuadro\n`);
console.log('DE DÓNDE SALIÓ CADA CUADRO');
console.log('  torneo                  ev   n   MDA    Q    A  fuera  dilución');
for (const t of torneos.sort((a, b) => a.clave.localeCompare(b.clave))) {
  for (const [ev, c] of Object.entries(t.cuadros)) {
    console.log('  ' + t.clave.slice(6).padEnd(22) + ev.padEnd(4) +
      String(c.total).padStart(3) + String(c.de.MDA).padStart(6) + String(c.de.Q).padStart(5) +
      String(c.de.A).padStart(5) + String(c.de.fuera).padStart(6) + '    ' + pc(c.dilucion));
  }
}
const conRet = torneos.filter(t => t.retiros.total);
console.log(`\nRETIROS (mediana ${conRet.length ? conRet.map(t => t.retiros.total).sort((a, b) => a - b)[Math.floor(conRet.length / 2)] : 0} por torneo)`);
console.log('  torneo                 total  rankeados  mejor ATP  se fueron a otro torneo');
for (const t of conRet.sort((a, b) => b.retiros.conRanking - a.retiros.conRanking).slice(0, 12))
  console.log('  ' + t.clave.slice(6).padEnd(22) + String(t.retiros.total).padStart(5) +
    String(t.retiros.conRanking).padStart(11) + String(t.retiros.mejorAtp ?? '—').padStart(11) +
    String(t.retiros.aOtroTorneo).padStart(9) + '  ' + (t.retiros.destinos[0] ? t.retiros.destinos[0][0] + ' (' + t.retiros.destinos[0][1] + ')' : ''));
console.log('\n→ vigia/itf-entradas.json');
