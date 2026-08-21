#!/usr/bin/env node
/* ============================================================
   ITF-MESA — genera vigia/itf-mesa.html: UNA tabla con todo.

   Manda ITF: la base es el ORDER OF PLAY (la programación oficial:
   día, cancha, turno y hora local). Betano solo acompaña — si hay
   cuota se muestra, si no, la fila igual está (la cuota puede
   aparecer en cualquier momento).

   Cada fila = un partido, con dos líneas (una por jugador):
     día y hora (Chile + local) · cancha y turno · torneo (país) ·
     cuadro y ronda · jugador con seed/entrada · ranking ·
     cómo llega (con la marca del rival) · Ganador · 1er set · link

   Uso:
     node vigia/itf-mesa.mjs vivo   baja order of play + cuadros y genera
     node vigia/itf-mesa.mjs        genera con lo que hay en disco
   ============================================================ */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pareceElMismo, normalizar } from './itf-cruce.mjs';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const DATOS = path.join(DIR, 'datos', 'itf');
const VIVO = path.join(DATOS, 'vivo');
const OOP = path.join(DATOS, 'oop');
const SALIDA = path.join(DIR, 'itf-mesa.html');

const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const leer = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')) } catch { return null; } };
const hoyISO = () => new Date().toISOString().slice(0, 10);

const cal = leer(path.join(DIR, 'itf-calendario.json')) || { torneos: [] };
const tablero = leer(path.join(DIR, 'itf.json')) || { partidos: {} };

/* Torneos en curso según el calendario (el que manda para saber qué mirar). */
const activos = cal.torneos.filter(t => t.desde <= hoyISO() && t.hasta >= hoyISO());

/* ---------- huso horario por país (para dar la hora de Chile) ---------- */
const TZ = {
  'Argentina': 'America/Argentina/Buenos_Aires', 'Australia': 'Australia/Sydney',
  'Austria': 'Europe/Vienna', 'Belgium': 'Europe/Brussels', 'Brazil': 'America/Sao_Paulo',
  'China, P.R.': 'Asia/Shanghai', 'Chinese Taipei': 'Asia/Taipei', 'Denmark': 'Europe/Copenhagen',
  'Egypt': 'Africa/Cairo', 'Finland': 'Europe/Helsinki', 'France': 'Europe/Paris',
  'Germany': 'Europe/Berlin', 'Great Britain': 'Europe/London', 'Hungary': 'Europe/Budapest',
  'Indonesia': 'Asia/Jakarta', 'Ireland': 'Europe/Dublin', 'Italy': 'Europe/Rome',
  'Japan': 'Asia/Tokyo', 'Kazakhstan': 'Asia/Almaty', 'Mexico': 'America/Mexico_City',
  'Morocco': 'Africa/Casablanca', 'Netherlands': 'Europe/Amsterdam', 'Paraguay': 'America/Asuncion',
  'Poland': 'Europe/Warsaw', 'Portugal': 'Europe/Lisbon', 'Romania': 'Europe/Bucharest',
  'Serbia': 'Europe/Belgrade', 'Slovakia': 'Europe/Bratislava', 'Slovenia': 'Europe/Ljubljana',
  'Spain': 'Europe/Madrid', 'Sweden': 'Europe/Stockholm', 'Switzerland': 'Europe/Zurich',
  'Thailand': 'Asia/Bangkok', 'Tunisia': 'Africa/Tunis', 'USA': 'America/New_York',
};

/* Offset de una zona en un instante dado (ms). */
function offsetDe(ts, tz) {
  const p = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour12: false, year: 'numeric', month: '2-digit',
    day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(ts)).reduce((o, x) => (o[x.type] = x.value, o), {});
  return Date.UTC(p.year, p.month - 1, p.day, p.hour % 24, p.minute, p.second) - ts;
}

/* "2026-08-22" + "10:00" en Europe/Rome → instante UTC real. */
function instante(fecha, hhmm, tz) {
  if (!tz || !fecha || !hhmm) return null;
  const [Y, M, D] = fecha.split('-').map(Number);
  const [h, m] = hhmm.split(':').map(Number);
  const base = Date.UTC(Y, M - 1, D, h, m);
  let ts = base;
  for (let i = 0; i < 2; i++) ts = base - offsetDe(ts, tz);
  return new Date(ts);
}

const fmtCl = new Intl.DateTimeFormat('es-CL', { timeZone: 'America/Santiago', weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
const fmtClHora = new Intl.DateTimeFormat('es-CL', { timeZone: 'America/Santiago', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

/* ---------- modo vivo: bajar order of play y cuadros ---------- */
if (process.argv[2] === 'vivo') {
  const { diasOop, ordenDeJuego, eventos, cuadro } = await import('./itf.mjs');
  fs.mkdirSync(OOP, { recursive: true });
  fs.mkdirSync(VIVO, { recursive: true });
  const desde = hoyISO();
  let waf = 0;
  for (const t of activos) {
    if (waf >= 2) { console.log('  WAF en serie: sigo con lo que hay'); break; }
    try {
      const dias = (await diasOop(t.clave)).filter(d => d.fecha >= desde);
      for (const d of dias) {
        const partidos = await ordenDeJuego(d.id);
        fs.writeFileSync(path.join(OOP, `${t.clave}-${d.fecha}.json`),
          JSON.stringify({ clave: t.clave, fecha: d.fecha, fechaTxt: d.fechaTxt, bajado: new Date().toISOString(), partidos }));
        console.log(`  ✓ oop ${t.clave} ${d.fecha}: ${partidos.length} partidos`);
      }
      waf = 0;
    } catch (e) { console.log(`  ✗ oop ${t.clave}: ${e.message.split(':')[0]}`); if (e.waf) waf++; }
    /* cuadro: para seed, entrada y trayectoria (se refresca si está viejo) */
    const fv = path.join(VIVO, t.clave + '.json');
    const edad = (() => { const v = leer(fv); return v ? Date.now() - new Date(v.bajado).getTime() : Infinity; })();
    if (edad < 4 * 3600e3 || waf >= 2) continue;
    try {
      const ev = await eventos(t.clave);
      const cuadros = {};
      for (const c of ev.cuadros.filter(c => c.tipo === 'S')) {
        cuadros[c.evento] = await cuadro({ tournamentId: ev.tournamentId, tourType: ev.tourType, evento: c.evento, tipo: 'S' });
      }
      fs.writeFileSync(fv, JSON.stringify({ clave: t.clave, bajado: new Date().toISOString(), cuadros }));
      console.log(`  ✓ cuadro ${t.clave}`);
      waf = 0;
    } catch (e) { console.log(`  ✗ cuadro ${t.clave}: ${e.message.split(':')[0]}`); if (e.waf) waf++; }
  }
}

/* ---------- contexto del cuadro: seed, entrada, trayectoria ---------- */
const RONDA_CORTA = { '1st Round': 'R1', '2nd Round': 'R2', '3rd Round': 'R3', 'Quarter-finals': 'QF', 'Semi-finals': 'SF', 'Final': 'F' };
const RONDA_NUM = { 1: 'R1', 2: 'R2', 3: 'QF', 4: 'SF', 5: 'F' };
const marcaDe = l => [l?.seed ? `[${l.seed}]` : null, l?.entrada && l.entrada !== 'DA' ? l.entrada : null].filter(Boolean).join(' ');

function trayectoria(nombre, cuadros) {
  const pasos = [];
  const orden = Object.entries(cuadros).sort(([a], [b]) => (a === 'Q' ? 0 : 1) - (b === 'Q' ? 0 : 1));
  for (const [evento, c] of orden) {
    for (const r of c.rondas) {
      for (const p of r.partidos) {
        if (p.estado !== 'jugado') continue;
        const idx = p.lados.findIndex(l => pareceElMismo(nombre, l));
        if (idx < 0) continue;
        const yo = p.lados[idx], rival = p.lados[1 - idx];
        const ronda = evento === 'Q' ? 'Q' + r.numero : (RONDA_NUM[r.numero] || 'R' + r.numero);
        const sets = yo.sets.map((s, i) => s + '-' + (rival.sets[i] ?? '?')).join(' ');
        const vs = marcaDe(rival).replace(' ', '');
        pasos.push(`<i class="${yo.ganador ? 'g' : 'p'}">${ronda}${yo.ganador ? '✓' : '✗'}</i> ${esc(sets)}`
          + (vs ? ` <i class="vs">v${esc(vs)}</i>` : '')
          + (/retired/i.test(p.nota || '') && !yo.ganador ? ' <i class="p">RET</i>' : ''));
      }
    }
  }
  return pasos.join(' · ');
}

/* Índice por torneo: cuadros, entry list y lados por matchId. */
const ctxCache = new Map();
function contextoTorneo(clave) {
  if (ctxCache.has(clave)) return ctxCache.get(clave);
  const vivo = leer(path.join(VIVO, clave + '.json'));
  const acc = leer(path.join(DATOS, clave + '.aceptacion.json'));
  const porMatch = new Map();
  if (vivo) for (const c of Object.values(vivo.cuadros)) {
    for (const r of c.rondas) for (const p of r.partidos) porMatch.set(p.matchId, p.lados);
  }
  const ctx = { cuadros: vivo?.cuadros || null, listado: acc ? Object.values(acc.secciones).flat() : [], porMatch };
  ctxCache.set(clave, ctx);
  return ctx;
}

/* ---------- cuotas de Betano (acompaña; puede no estar) ---------- */
const cuotasIdx = Object.values(tablero.partidos).filter(e => e.p1 && e.p2 && e.g);
function cuotasDe(l0, l1) {
  for (const e of cuotasIdx) {
    let orden = null;
    if (pareceElMismo(e.p1, l0) && pareceElMismo(e.p2, l1)) orden = [1, 2];
    else if (pareceElMismo(e.p1, l1) && pareceElMismo(e.p2, l0)) orden = [2, 1];
    if (!orden) continue;
    return {
      bFix: e.bFix || null,
      lados: orden.map(k => ({ gana: e.g?.['p' + k] ?? null, set1: e.s1?.['p' + k] ?? null })),
    };
  }
  return null;
}

/* ---------- armar las filas desde el order of play ---------- */
const ahora = Date.now();
const partidos = [];
for (const t of activos) {
  const tz = TZ[t.pais] || null;
  for (const f of fs.existsSync(OOP) ? fs.readdirSync(OOP) : []) {
    if (!f.startsWith(t.clave + '-')) continue;
    const dia = leer(path.join(OOP, f));
    if (!dia || dia.fecha < hoyISO()) continue;
    const ctx = contextoTorneo(t.clave);
    /* hora base por cancha: el "Starting at HH:MM" de su primer partido */
    const baseCancha = new Map();
    for (const p of dia.partidos) {
      const m = /(\d{1,2}):(\d{2})/.exec(p.horario || '');
      if (m && !baseCancha.has(p.cancha)) baseCancha.set(p.cancha, m[1].padStart(2, '0') + ':' + m[2]);
    }
    for (const p of dia.partidos) {
      if (p.estado === 'jugado' || !p.lados.every(l => l?.nombre)) continue;
      if (!/S$/.test(p.tipo || '')) continue;               /* singles: MS / WS */
      const propia = /(\d{1,2}):(\d{2})/.exec(p.horario || '');
      const hhmm = propia ? propia[1].padStart(2, '0') + ':' + propia[2] : baseCancha.get(p.cancha) || null;
      const inicio = instante(dia.fecha, hhmm, tz);
      /* estimación de orden en cancha para ordenar la tabla */
      const ordenTs = (inicio ? inicio.getTime() : new Date(dia.fecha + 'T12:00:00Z').getTime()) + (propia ? 0 : (p.orden - 1) * 75 * 60e3);
      if (inicio && inicio.getTime() < ahora - 4 * 3600e3) continue;   /* pasó hace rato y no está marcado jugado */
      const lados = p.lados.map(l => {
        const delCuadro = (ctx.porMatch.get(p.matchId) || []).find(x => pareceElMismo(l.nombre, x));
        const en = ctx.listado.find(x => pareceElMismo(l.nombre, { nombre: x.nombre }));
        return {
          nombre: l.nombre,
          pais: l.jugadores?.[0]?.pais || '',
          marca: marcaDe(delCuadro) || marcaDe(l),
          rank: en?.atp ? 'ATP ' + en.atp : (en?.wtn ? 'WTN ' + en.wtn : null),
          llega: ctx.cuadros ? trayectoria(l.nombre, ctx.cuadros) : '',
        };
      });
      partidos.push({
        t, fecha: dia.fecha, hhmm, inicio, orden: ordenTs,
        cancha: p.cancha, turno: p.orden, horarioTxt: p.horario,
        evento: p.evento, ronda: RONDA_CORTA[p.ronda] || p.ronda,
        lados, cuotas: cuotasDe(lados[0], lados[1]),
      });
    }
  }
}
partidos.sort((a, b) => a.orden - b.orden);

/* ---------- render ---------- */
const dias = [...new Set(partidos.map(p => p.fecha))].sort();
const fmtDia = f => new Intl.DateTimeFormat('es-CL', { timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'long' }).format(new Date(f + 'T12:00:00Z'));
const num = v => v == null ? '<span class="sin">·</span>' : (+v).toFixed(2);

function filas(p, i) {
  const horaCl = p.inicio ? fmtClHora.format(p.inicio) : '—';
  const local = p.hhmm ? (p.horarioTxt && /not before/i.test(p.horarioTxt) ? 'no antes ' : '') + p.hhmm : '—';
  const turno = p.turno > 1 && !/\d/.test(p.horarioTxt || '') ? `${p.turno}º turno` : (p.turno > 1 ? `${p.turno}º` : '1º');
  const cq = p.cuotas;
  const linea = (l, k) => `<tr class="${k ? 'b' : 'a'}${cq ? '' : ' sin-cuota'}">
    ${k ? '' : `<td rowspan="2" class="c-hora"><b class="mono">${esc(horaCl)}</b><span class="loc mono">${esc(local)} local</span></td>
    <td rowspan="2" class="c-cancha"><span class="mono">${esc(p.cancha || '—')}</span><span class="loc">${esc(turno)}</span></td>
    <td rowspan="2" class="c-torneo">${esc(p.t.nombre)}<span class="loc">${esc(p.t.pais)} · ${esc(p.t.superficie || '')}</span></td>
    <td rowspan="2" class="c-ronda"><span class="mono">${p.evento === 'Q' ? 'Q·' : ''}${esc(p.ronda)}</span></td>`}
    <td class="c-jug">${esc(l.nombre)}${l.marca ? ` <b>${esc(l.marca)}</b>` : ''}<span class="pais">${esc(l.pais)}</span></td>
    <td class="c-rank mono">${esc(l.rank || '')}</td>
    <td class="c-od mono">${num(cq?.lados[k].gana)}</td>
    <td class="c-od mono">${num(cq?.lados[k].set1)}</td>
    <td class="c-llega">${l.llega || '<span class="sin">debuta</span>'}</td>
    ${k ? '' : `<td rowspan="2" class="c-link">${cq?.bFix
      ? `<a href="https://lat.betano.com/cuotas-de-partido/e-e/${esc(cq.bFix)}/" target="_blank" rel="noopener">Betano ↗</a>`
      : '<span class="sin">sin cuota</span>'}</td>`}
  </tr>`;
  return linea(p.lados[0], 0) + linea(p.lados[1], 1);
}

const generado = new Date().toISOString();
const conCuota = partidos.filter(p => p.cuotas).length;
const html = `<title>Mesa ITF</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@600;700&family=IBM+Plex+Sans:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500;600&display=swap">
<style>
:root{--papel:#F3F5F7;--carta:#FFF;--tinta:#1A2732;--tinta2:#5A6B7A;--linea:#D9E0E6;
  --acento:#0F6B5C;--acento-suave:#E3EFEB;--alerta:#A33B2A;--ambar:#8A6116;--franja:#FAFBFC}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--papel:#0F151B;--carta:#161F28;
  --tinta:#DAE4EC;--tinta2:#8FA1B0;--linea:#26313C;--acento:#3FB79E;--acento-suave:#15302B;
  --alerta:#E08A79;--ambar:#D9A94B;--franja:#131C24}}
:root[data-theme="dark"]{--papel:#0F151B;--carta:#161F28;--tinta:#DAE4EC;--tinta2:#8FA1B0;
  --linea:#26313C;--acento:#3FB79E;--acento-suave:#15302B;--alerta:#E08A79;--ambar:#D9A94B;--franja:#131C24}
*{box-sizing:border-box}
body{margin:0;background:var(--papel);color:var(--tinta);font:14px/1.45 "IBM Plex Sans",system-ui,sans-serif}
.envoltura{max-width:1500px;margin:0 auto;padding:20px 14px 50px}
.cabecera{display:flex;align-items:baseline;gap:14px;flex-wrap:wrap;margin-bottom:4px}
.cabecera h1{font-family:"Barlow Condensed",sans-serif;font-weight:700;font-size:32px;margin:0;letter-spacing:.5px}
.edad{font-size:13px;color:var(--tinta2)} .edad b{font-variant-numeric:tabular-nums}
.edad.vieja b{color:var(--ambar)} .edad.rancia b{color:var(--alerta)}
button.recargar{margin-left:auto;font:600 14px "IBM Plex Sans",sans-serif;color:var(--acento);
  background:var(--acento-suave);border:1px solid transparent;border-radius:6px;padding:8px 16px;cursor:pointer}
button.recargar:hover{border-color:var(--acento)}
button.recargar:focus-visible{outline:2px solid var(--acento);outline-offset:2px}
.nota{font-size:12.5px;color:var(--tinta2);margin:0 0 14px}
h2.dia{font-family:"Barlow Condensed",sans-serif;font-weight:600;font-size:19px;letter-spacing:1px;
  text-transform:uppercase;color:var(--acento);margin:22px 0 8px}
.tabla-env{overflow-x:auto;background:var(--carta);border:1px solid var(--linea);border-radius:6px}
table{border-collapse:collapse;width:100%;min-width:1180px}
th{font-family:"Barlow Condensed",sans-serif;font-weight:600;font-size:13px;letter-spacing:1px;
  text-transform:uppercase;color:var(--tinta2);text-align:left;padding:8px 10px;
  border-bottom:1px solid var(--linea);white-space:nowrap;background:var(--carta);position:sticky;top:0;z-index:1}
th.n{text-align:right}
td{padding:5px 10px;vertical-align:top;border-bottom:1px solid transparent}
tr.a td{padding-top:8px} tr.b td{padding-bottom:8px;border-bottom:1px solid var(--linea)}
tr.a td[rowspan]{border-bottom:1px solid var(--linea)}
tbody tr.a:nth-of-type(4n+1) td,tbody tr.b:nth-of-type(4n+2) td{background:var(--franja)}
.c-hora b{font-size:15px;font-weight:600;display:block;font-variant-numeric:tabular-nums}
.loc{display:block;font-size:11px;color:var(--tinta2);margin-top:1px}
.c-cancha .mono{font-size:12px}
.c-torneo{font-size:13px;min-width:150px}
.c-ronda .mono{font-size:12px;font-weight:600;color:var(--acento)}
.c-jug{font-weight:500;min-width:190px} .c-jug b{color:var(--acento);font-weight:600}
.c-jug .pais{color:var(--tinta2);font-size:11px;margin-left:5px;font-weight:400}
.c-rank{font-size:12px;color:var(--tinta2);white-space:nowrap}
.c-od{text-align:right;font-size:14.5px;font-weight:600;font-variant-numeric:tabular-nums;width:64px}
.c-llega{font-family:"IBM Plex Mono",monospace;font-size:11px;color:var(--tinta2);line-height:1.6}
.c-llega i{font-style:normal} .c-llega .g{color:var(--acento);font-weight:600}
.c-llega .p{color:var(--alerta);font-weight:600} .c-llega .vs{color:var(--tinta);font-weight:600}
.c-link{white-space:nowrap;font-size:12.5px}
.c-link a{color:var(--acento);text-decoration:none} .c-link a:hover{text-decoration:underline}
.sin{color:var(--tinta2);opacity:.45}
tr.sin-cuota .c-jug{opacity:.88}
.mono{font-family:"IBM Plex Mono",monospace;font-variant-numeric:tabular-nums}
.vacio{color:var(--tinta2);padding:34px;text-align:center;background:var(--carta);
  border:1px solid var(--linea);border-radius:6px}
footer{color:var(--tinta2);font-size:12px;border-top:1px solid var(--linea);padding-top:12px;margin-top:24px}
a:focus-visible{outline:2px solid var(--acento);outline-offset:2px}
</style>
<div class="envoltura">
<div class="cabecera">
  <h1>Mesa ITF</h1>
  <span class="edad" id="edad" data-generado="${generado}">datos de hace <b>—</b></span>
  <button class="recargar" onclick="location.reload(true)">↻ Recargar</button>
</div>
<p class="nota">Programación oficial ITF (order of play) de los ${activos.length} torneos en juego · hora de Chile y hora local · ${partidos.length} partidos por jugar, ${conCuota} con cuota de Betano. Las cuotas aparecen cuando Betano abre la línea; el partido está igual.</p>
${dias.map(f => {
  const delDia = partidos.filter(p => p.fecha === f);
  if (!delDia.length) return '';
  return `<h2 class="dia">${esc(fmtDia(f))}</h2>
  <div class="tabla-env"><table>
    <thead><tr><th>Hora CL</th><th>Cancha</th><th>Torneo</th><th>Ronda</th><th>Jugador</th><th>Ranking</th>
      <th class="n">Gana</th><th class="n">1er set</th><th>Cómo llega</th><th>Betano</th></tr></thead>
    <tbody>${delDia.map(filas).join('')}</tbody>
  </table></div>`;
}).join('') || '<p class="vacio">Sin programación publicada por ITF para hoy o mañana. Recarga más tarde o pide un refresco.</p>'}
<footer>Generado ${generado.slice(0, 16).replace('T', ' ')} UTC · ITF manda: order of play y cuadros oficiales de itftennis.com · Betano acompaña vía OddsPapi (Ganador y Ganador 1er set) · "Followed By" = turno estimado a partir del inicio de la cancha.</footer>
</div>
<script>
(function(){var el=document.getElementById('edad');function p(){var m=Math.round((Date.now()-new Date(el.dataset.generado).getTime())/60000);
el.innerHTML='datos de hace <b>'+(m<60?m+' min':(m/60).toFixed(1)+' h')+'</b>';
el.className='edad'+(m>360?' rancia':m>120?' vieja':'');}p();setInterval(p,60000);})();
</script>`;

fs.writeFileSync(SALIDA, html);
console.log(`✓ ${SALIDA} (${(html.length / 1024).toFixed(0)} KB) · ${partidos.length} partidos por jugar (${conCuota} con cuota) · ${dias.length} días · ${activos.length} torneos`);
