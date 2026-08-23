#!/usr/bin/env node
/* ============================================================
   ITF-CONTROL — genera itf-control.html: la torre de control del
   scraping. Lee el mapa maestro (torneos.json) y el plan de la próxima
   corrida (itf-scrap planificar) y lo muestra por semana: qué torneo
   está en qué estado, qué tenemos en disco y de cuándo, y qué haría la
   próxima corrida y por qué. No baja nada: solo pinta.

   Uso:  node vigia/itf-control.mjs
   ============================================================ */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { torneosDelMapa, estadoDe } from './itf-mapa.mjs';
import { planificar } from './itf-scrap.mjs';

const DIR = path.dirname(fileURLToPathSafe());
function fileURLToPathSafe() { return fileURLToPath(import.meta.url); }
const SALIDA = path.join(DIR, 'itf-control.html');

const hoy = new Date().toISOString().slice(0, 10);
const { mapa, colaA, colaB, archivar } = planificar(hoy);
const filas = torneosDelMapa(mapa, hoy);
const razones = new Map();
for (const i of [...colaA, ...colaB]) if (i.clave) razones.set(i.clave, i.razon);

const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const hhmm = iso => iso && iso !== 'historico' ? iso.slice(11, 16) : null;
const celda = (iso, critico = false) => {
  if (!iso) return `<td class="c-dato ${critico ? 'falta' : 'sin'}">${critico ? '✗' : '·'}</td>`;
  if (iso === 'historico') return '<td class="c-dato ok">✓<span class="sub">arch</span></td>';
  const viejo = Date.now() - new Date(iso).getTime() > 3 * 3600e3;
  return `<td class="c-dato ${viejo ? 'viejo' : 'ok'}">✓<span class="sub">${hhmm(iso)}</span></td>`;
};

const ORDEN_SEM = Object.keys(mapa.semanas).sort();
const ETIQ = { PROXIMO: 'próximo', QUALI: 'qualis', MAIN: 'en juego', TERMINADO: 'terminado', ARCHIVADO: 'archivado' };
const resumen = {};
for (const f of filas) resumen[f.estado] = (resumen[f.estado] || 0) + 1;

const secciones = ORDEN_SEM.map(sem => {
  const ts = filas.filter(f => f.sem === sem);
  if (!ts.every(f => f.estado === 'ARCHIVADO') || sem >= semanaDe(hoy)) { /* siempre se muestran las vigentes */ }
  const todasArch = ts.every(f => f.estado === 'ARCHIVADO');
  const lunes = ts[0]?.t.fechas.main || '';
  const cuerpo = ts.map(({ clave, t, estado }) => {
    const fr = t.frescura;
    const oopHoy = fr.oop[hoy];
    const razon = razones.get(clave);
    return `<tr class="e-${estado.toLowerCase()}">
      <td class="c-nom">${esc(t.nombre)}<span class="sub">${esc(t.pais || '')} · ${esc(t.superficie || '')} · ${esc(t.bolsa || '')}</span></td>
      <td class="c-est"><span class="pill p-${estado.toLowerCase()}">${ETIQ[estado]}</span></td>
      <td class="c-fechas mono">${esc(t.fechas.quali.slice(5))}<span class="sub">q</span> ${esc(t.fechas.main.slice(5))}<span class="sub">→</span>${esc(t.fechas.final.slice(5))}</td>
      ${celda(fr.aceptacion, estado === 'PROXIMO' || estado === 'QUALI')}
      ${celda(fr.cuadroQ)}
      ${celda(fr.cuadroM)}
      ${estado === 'QUALI' || estado === 'MAIN'
        ? celda(oopHoy, true)
        : '<td class="c-dato sin">·</td>'}
      <td class="c-pend">${t.pendientesDeCierre ? `<b>${t.pendientesDeCierre}</b>` : '·'}</td>
      <td class="c-razon">${razon ? '⟳ ' + esc(razon) : (estado === 'ARCHIVADO' ? '' : '<span class="sub">al día</span>')}</td>
    </tr>`;
  }).join('');
  return `<section class="semana${todasArch ? ' plegada' : ''}">
    <h2>${esc(sem)} <span class="sub">lunes ${esc(lunes)}</span>${todasArch ? ' <span class="sub">· toda archivada</span>' : ''}</h2>
    <div class="tabla-env"><table>
      <thead><tr><th>Torneo</th><th>Estado</th><th>Fechas (q · main → final)</th>
        <th class="n">Entry list</th><th class="n">Cuadro Q</th><th class="n">Cuadro M</th><th class="n">OOP hoy</th>
        <th class="n">Sin cerrar</th><th>Próxima corrida</th></tr></thead>
      <tbody>${cuerpo}</tbody>
    </table></div>
  </section>`;
}).join('');

function semanaDe(f) { let d = new Date(f + 'T12:00:00Z'); const dia = (d.getUTCDay() + 6) % 7; d.setUTCDate(d.getUTCDate() - dia + 3); const e4 = new Date(Date.UTC(d.getUTCFullYear(), 0, 4)); const sem = 1 + Math.round(((d - e4) / 864e5 - 3 + ((e4.getUTCDay() + 6) % 7)) / 7); return d.getUTCFullYear() + '-W' + String(sem).padStart(2, '0'); }

const generado = new Date().toISOString();
const html = `<title>Torre ITF</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@600;700&family=IBM+Plex+Sans:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500&display=swap">
<style>
:root{--papel:#F3F5F7;--carta:#FFF;--tinta:#1A2732;--tinta2:#5A6B7A;--linea:#D9E0E6;
  --acento:#0F6B5C;--acento-suave:#E3EFEB;--alerta:#A33B2A;--ambar:#8A6116;--ambar-suave:#F4ECDD;--franja:#F7F9FA}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--papel:#0F151B;--carta:#161F28;
  --tinta:#DAE4EC;--tinta2:#8FA1B0;--linea:#26313C;--acento:#3FB79E;--acento-suave:#15302B;
  --alerta:#E08A79;--ambar:#D9A94B;--ambar-suave:#2A2415;--franja:#131C24}}
:root[data-theme="dark"]{--papel:#0F151B;--carta:#161F28;--tinta:#DAE4EC;--tinta2:#8FA1B0;
  --linea:#26313C;--acento:#3FB79E;--acento-suave:#15302B;--alerta:#E08A79;--ambar:#D9A94B;--ambar-suave:#2A2415;--franja:#131C24}
*{box-sizing:border-box}
body{margin:0;background:var(--papel);color:var(--tinta);font:14px/1.45 "IBM Plex Sans",system-ui,sans-serif}
.envoltura{max-width:1360px;margin:0 auto;padding:18px 14px 50px}
header.cab{display:flex;align-items:baseline;gap:14px;flex-wrap:wrap;margin-bottom:6px}
h1{font-family:"Barlow Condensed",sans-serif;font-weight:700;font-size:30px;margin:0;letter-spacing:.5px}
.gen{font-size:12.5px;color:var(--tinta2)} .gen b{font-variant-numeric:tabular-nums}
.chips{display:flex;gap:8px;flex-wrap:wrap;margin:8px 0 4px}
.chip{font-size:12.5px;padding:4px 10px;border-radius:999px;border:1px solid var(--linea);background:var(--carta)}
.chip b{font-family:"IBM Plex Mono",monospace}
.nota{font-size:12.5px;color:var(--tinta2);margin:2px 0 16px;max-width:72ch}
.semana{margin-top:26px}
.semana.plegada{opacity:.55}
h2{font-family:"Barlow Condensed",sans-serif;font-weight:600;font-size:21px;margin:0 0 6px;letter-spacing:.4px}
h2 .sub{font-size:13px}
.sub{color:var(--tinta2);font-weight:400;font-size:11.5px;display:inline-block;margin-left:4px}
.tabla-env{overflow-x:auto;background:var(--carta);border:1px solid var(--linea);border-radius:6px}
table{border-collapse:collapse;width:100%;min-width:1050px}
th{font-family:"Barlow Condensed",sans-serif;font-weight:600;font-size:12.5px;letter-spacing:1px;
  text-transform:uppercase;color:var(--tinta2);text-align:left;padding:8px 10px;border-bottom:1px solid var(--linea)}
th.n{text-align:center}
td{padding:7px 10px;border-top:1px solid var(--linea);vertical-align:top}
tbody tr:nth-child(even){background:var(--franja)}
.mono{font-family:"IBM Plex Mono",monospace;font-size:12.5px;font-variant-numeric:tabular-nums}
.c-nom{font-weight:600;min-width:180px} .c-nom .sub{display:block;margin:1px 0 0}
.c-dato{text-align:center;font-family:"IBM Plex Mono",monospace;font-size:13px;min-width:64px}
.c-dato .sub{display:block;margin:0;font-size:10.5px}
.c-dato.ok{color:var(--acento)} .c-dato.viejo{color:var(--ambar)}
.c-dato.falta{color:var(--alerta);font-weight:600} .c-dato.sin{color:var(--tinta2)}
.c-pend{text-align:center} .c-pend b{color:var(--ambar)}
.c-razon{font-size:12.5px;color:var(--tinta2);min-width:180px}
.pill{font-size:11.5px;font-weight:600;letter-spacing:.4px;text-transform:uppercase;
  padding:3px 9px;border-radius:999px;white-space:nowrap}
.p-proximo{background:var(--franja);color:var(--tinta2);border:1px solid var(--linea)}
.p-quali{background:var(--ambar-suave);color:var(--ambar)}
.p-main{background:var(--acento-suave);color:var(--acento)}
.p-terminado{background:var(--franja);color:var(--tinta2);border:1px dashed var(--linea)}
.p-archivado{background:none;color:var(--tinta2);border:1px solid transparent}
tr.e-archivado{opacity:.5}
footer{margin-top:26px;font-size:12px;color:var(--tinta2);max-width:80ch}
@media (prefers-reduced-motion:no-preference){ .chip{transition:border-color .15s} }
</style>
<div class="envoltura">
<header class="cab">
  <h1>Torre ITF</h1>
  <span class="gen">generado <b>${esc(generado.slice(0, 16).replace('T', ' '))}</b> UTC · solo hombres singles M15/M25</span>
</header>
<div class="chips">
  <span class="chip">en juego <b>${resumen.MAIN || 0}</b></span>
  <span class="chip">qualis <b>${resumen.QUALI || 0}</b></span>
  <span class="chip">próximos <b>${resumen.PROXIMO || 0}</b></span>
  <span class="chip">terminados <b>${resumen.TERMINADO || 0}</b></span>
  <span class="chip">archivados <b>${resumen.ARCHIVADO || 0}</b></span>
  <span class="chip">próxima corrida: <b>${colaA.length + colaB.length}</b> tareas</span>
</div>
<p class="nota">Cada fila dice qué hay en disco y de qué hora (✓ verde fresco, ámbar con más de 3 h, ✗ rojo faltante crítico) y qué haría la próxima corrida de <span class="mono">itf-scrap</span>. La entry list es lo urgente en torneos próximos: ITF la borra cuando el torneo termina.</p>
${secciones}
<footer>Mapa maestro: <span class="mono">vigia/datos/itf/torneos.json</span> · se actualiza con <span class="mono">node vigia/itf-scrap.mjs</span> (baja solo lo que falta; nada corre solo). El estado sale de las fechas oficiales del calendario ITF; "sin cerrar" son filas del registro de apuestas esperando resultado.</footer>
</div>`;

fs.writeFileSync(SALIDA, html);
console.log(`✓ ${SALIDA} (${(html.length / 1024).toFixed(0)} KB) · ${filas.length} torneos · ${ORDEN_SEM.length} semanas · cola próxima: ${colaA.length + colaB.length}`);
