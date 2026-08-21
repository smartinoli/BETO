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
const analisis = leer(path.join(DIR, 'itf-analisis.json')) || { veredictos: {}, destacados: [] };
const saber = leer(path.join(DIR, 'itf-saber.json')) || {};

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

/* Índice GLOBAL de entry lists: el WTN (World Tennis Number) es el rating
   de nivel real de ITF — mide cómo juega, no puntos acumulados — y resulta
   mejor predictor que el ranking ATP en este circuito. Se busca en todas
   las listas porque un jugador puede faltar en la de su propio torneo. */
const listaGlobal = [];
for (const f of fs.existsSync(DATOS) ? fs.readdirSync(DATOS) : []) {
  if (!f.endsWith('.aceptacion.json')) continue;
  const a = leer(path.join(DATOS, f));
  if (a) for (const sec of Object.values(a.secciones)) listaGlobal.push(...sec);
}
function fichaDe(nombre) {
  return listaGlobal.find(x => pareceElMismo(nombre, { nombre: x.nombre })) || null;
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
      cuotasAl: e.cuotasAl || null,
      lados: orden.map(k => ({ gana: e.g?.['p' + k] ?? null, set1: e.s1?.['p' + k] ?? null })),
    };
  }
  return null;
}

/* ---------- armar las filas desde el order of play ----------
   El ORDER OF PLAY manda y es el que está al día: marca "jugado" o
   "In Progress" mientras el cuadro todavía dice pendiente. Solo entra
   a la mesa lo que ITF marca como TO BE PLAYED. */
const partidos = [];
for (const t of activos) {
  const tz = TZ[t.pais] || null;
  for (const f of fs.existsSync(OOP) ? fs.readdirSync(OOP) : []) {
    if (!f.startsWith(t.clave + '-')) continue;
    const dia = leer(path.join(OOP, f));
    if (!dia || dia.fecha < hoyISO()) continue;
    const ctx = contextoTorneo(t.clave);
    const baseCancha = new Map();
    for (const p of dia.partidos) {
      const m = /(\d{1,2}):(\d{2})/.exec(p.horario || '');
      if (m && !baseCancha.has(p.cancha)) baseCancha.set(p.cancha, m[1].padStart(2, '0') + ':' + m[2]);
    }
    for (const p of dia.partidos) {
      if (p.estado !== 'pendiente') continue;                 /* jugado / en curso: fuera */
      if (!/S$/.test(p.tipo || '')) continue;                 /* solo singles */
      if (!p.lados.every(l => l?.nombre)) continue;
      const propia = /(\d{1,2}):(\d{2})/.exec(p.horario || '');
      const hhmm = propia ? propia[1].padStart(2, '0') + ':' + propia[2] : baseCancha.get(p.cancha) || null;
      const inicio = instante(dia.fecha, hhmm, tz);
      const ordenTs = (inicio ? inicio.getTime() : new Date(dia.fecha + 'T12:00:00Z').getTime())
        + (propia ? 0 : (p.orden - 1) * 75 * 60e3);
      const lados = p.lados.map(l => {
        const delCuadro = (ctx.porMatch.get(p.matchId) || []).find(x => pareceElMismo(l.nombre, x));
        const en = ctx.listado.find(x => pareceElMismo(l.nombre, { nombre: x.nombre })) || fichaDe(l.nombre);
        return {
          nombre: l.nombre,
          pais: l.jugadores?.[0]?.pais || '',
          marca: marcaDe(delCuadro) || marcaDe(l),
          atp: en?.atp ?? null,
          wtn: en?.wtn ?? null,
          llega: ctx.cuadros ? trayectoria(l.nombre, ctx.cuadros) : '',
        };
      });
      partidos.push({
        matchId: p.matchId,
        t, fecha: dia.fecha, hhmm, inicio, ordenTs,
        cancha: p.cancha, turno: p.orden, horarioTxt: p.horario,
        evento: p.evento, ronda: RONDA_CORTA[p.ronda] || p.ronda,
        lados, cuotas: cuotasDe(lados[0], lados[1]),
      });
    }
  }
}
/* Orden por defecto: campeonato, luego hora. */
partidos.sort((a, b) => a.t.nombre.localeCompare(b.t.nombre) || a.ordenTs - b.ordenTs);

/* Dossier para el agente: los mismos partidos en JSON plano, sin HTML.
   Es lo que se lee al analizar (junto con itf-saber.json). */
fs.writeFileSync(path.join(DIR, 'itf-mesa-datos.json'), JSON.stringify({
  generado: new Date().toISOString(),
  partidos: partidos.map(p => ({
    id: p.matchId,
    torneo: p.t.nombre, pais: p.t.pais, categoria: p.t.categoria,
    superficie: p.t.superficie, bolsa: p.t.bolsa,
    cuando: p.inicio ? p.inicio.toISOString() : null,
    local: p.hhmm, horarioTxt: p.horarioTxt, cancha: p.cancha, turno: p.turno,
    ronda: p.ronda, evento: p.evento,
    lados: p.lados.map((l, k) => ({
      nombre: l.nombre, pais: l.pais, marca: l.marca, atp: l.atp, wtn: l.wtn,
      llega: l.llega.replace(/<[^>]+>/g, ''),
      gana: p.cuotas?.lados[k].gana ?? null,
      set1: p.cuotas?.lados[k].set1 ?? null,
    })),
    betano: p.cuotas?.bFix ? 'https://lat.betano.com/cuotas-de-partido/e-e/' + p.cuotas.bFix + '/' : null,
  })),
}, null, 1));

/* ---------- render: UNA sola lista ---------- */
const fmtDiaCorto = new Intl.DateTimeFormat('es-CL', { timeZone: 'America/Santiago', weekday: 'short', day: '2-digit', month: '2-digit' });
const num = v => v == null ? '<span class="sin">·</span>' : (+v).toFixed(2);

function filas(p) {
  const dia = p.inicio ? fmtDiaCorto.format(p.inicio).replace('.', '') : '—';
  const horaCl = p.inicio ? fmtClHora.format(p.inicio) : '—';
  const local = p.hhmm ? (/not before/i.test(p.horarioTxt || '') ? 'no antes ' : '') + p.hhmm : '—';
  const turno = /\d/.test(p.horarioTxt || '') ? `${p.turno}º` : `${p.turno}º turno`;
  const cq = p.cuotas;
  const v = analisis.veredictos[String(p.matchId)] || null;
  const top = analisis.destacados?.includes(p.matchId);
  const clave = `${p.t.nombre}|${p.ordenTs}`;
  const marcaVer = l => v && v.favorito && pareceElMismo(v.favorito.replace(/\s*\[\d+\]|\s*\(Q\)|\s*\(JR\)|\s*\(WC\)/g, ''), { nombre: l.nombre });
  const w0 = p.lados[0].wtn, w1 = p.lados[1].wtn;
  const mejorWtn = (w0 && w1) ? (w0 < w1 ? 0 : 1) : -1;
  const linea = (l, k) => `<tr class="${k ? 'b' : 'a'}" data-torneo="${esc(p.t.nombre)}" data-ts="${p.ordenTs}" data-par="${esc(clave)}">
    ${k ? '' : `<td rowspan="2" class="c-cuando"><b class="mono">${esc(dia)}</b><span class="loc mono">${esc(local)} loc · <b>${esc(horaCl)}</b> CL</span></td>
    <td rowspan="2" class="c-torneo">${esc(p.t.nombre)}<span class="loc">${esc(p.t.pais)} · ${esc(p.t.superficie || '')}</span></td>
    <td rowspan="2" class="c-ronda"><span class="mono">${p.evento === 'Q' ? 'Q·' : ''}${esc(p.ronda)}</span><span class="loc">${esc(p.cancha || '')} ${esc(turno)}</span></td>`}
    <td class="c-jug${marcaVer(l) ? ' elegido' : ''}">${marcaVer(l) ? '<span class="tick" title="elegido por el análisis">▸</span>' : ''}${esc(l.nombre)}${l.marca ? ` <b>${esc(l.marca)}</b>` : ''}<span class="pais">${esc(l.pais)}</span></td>
    <td class="c-rank mono">${l.atp ? 'ATP ' + l.atp : '<span class="sin">sin ATP</span>'}<span class="wtn${mejorWtn === k ? ' mejor' : ''}">${l.wtn != null ? 'WTN ' + (+l.wtn).toFixed(2) : ''}</span></td>
    <td class="c-od mono">${num(cq?.lados[k].gana)}</td>
    <td class="c-od mono">${num(cq?.lados[k].set1)}</td>
    <td class="c-llega">${l.llega || '<span class="sin">debuta</span>'}</td>
    ${k ? '' : `<td rowspan="2" class="c-link">${cq
      ? (cq.bFix ? `<a href="https://lat.betano.com/cuotas-de-partido/e-e/${esc(cq.bFix)}/" target="_blank" rel="noopener">Betano ↗</a>` : '<span class="sin">sin link</span>')
        + (cq.cuotasAl ? `<span class="loc">cuota ${esc(fmtClHora.format(new Date(cq.cuotasAl)))}</span>` : '')
      : '<span class="sin">aún sin línea</span>'}</td>`}
  </tr>`;
  const filaAn = v ? `<tr class="analisis${top ? ' top' : ''}" data-par="${esc(clave)}">
    <td colspan="9">
      <span class="conf c-${esc(v.confianza)}">${esc(v.confianza)}</span>
      ${v.mercado === 'pasar' ? '<b class="pasar">Pasar</b>' : `<b>${esc(v.favorito)}</b> <span class="mkt">${esc(v.mercado === '1er set' ? 'gana 1er set' : 'gana')}</span>`}
      ${top ? '<span class="chip-top">mejor opción</span>' : ''}
      <span class="razon">${esc(v.razon)}</span>
      ${(v.banderas || []).map(b => `<span class="bandera">${esc(b)}</span>`).join('')}
    </td>
  </tr>` : '';
  return linea(p.lados[0], 0) + linea(p.lados[1], 1) + filaAn;
}

const generado = new Date().toISOString();
const conCuota = partidos.filter(p => p.cuotas).length;
const html = `<title>Mesa ITF</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@600;700&family=IBM+Plex+Sans:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500;600&display=swap">
<style>
:root{--papel:#F3F5F7;--carta:#FFF;--tinta:#1A2732;--tinta2:#5A6B7A;--linea:#D9E0E6;
  --acento:#0F6B5C;--acento-suave:#E3EFEB;--alerta:#A33B2A;--ambar:#8A6116;--franja:#F7F9FA}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--papel:#0F151B;--carta:#161F28;
  --tinta:#DAE4EC;--tinta2:#8FA1B0;--linea:#26313C;--acento:#3FB79E;--acento-suave:#15302B;
  --alerta:#E08A79;--ambar:#D9A94B;--franja:#131C24}}
:root[data-theme="dark"]{--papel:#0F151B;--carta:#161F28;--tinta:#DAE4EC;--tinta2:#8FA1B0;
  --linea:#26313C;--acento:#3FB79E;--acento-suave:#15302B;--alerta:#E08A79;--ambar:#D9A94B;--franja:#131C24}
*{box-sizing:border-box}
body{margin:0;background:var(--papel);color:var(--tinta);font:14px/1.45 "IBM Plex Sans",system-ui,sans-serif}
.envoltura{max-width:1500px;margin:0 auto;padding:18px 14px 50px}
.cabecera{display:flex;align-items:baseline;gap:12px;flex-wrap:wrap;margin-bottom:4px}
.cabecera h1{font-family:"Barlow Condensed",sans-serif;font-weight:700;font-size:31px;margin:0;letter-spacing:.5px}
.edad{font-size:13px;color:var(--tinta2)} .edad b{font-variant-numeric:tabular-nums}
.edad.vieja b{color:var(--ambar)} .edad.rancia b{color:var(--alerta)}
.controles{margin-left:auto;display:flex;gap:8px;align-items:center}
.orden{font-size:12.5px;color:var(--tinta2)}
button{font:600 13px "IBM Plex Sans",sans-serif;color:var(--acento);background:var(--acento-suave);
  border:1px solid transparent;border-radius:6px;padding:7px 13px;cursor:pointer}
button:hover{border-color:var(--acento)} button:focus-visible{outline:2px solid var(--acento);outline-offset:2px}
button.on{background:var(--acento);color:var(--carta)}
.nota{font-size:12.5px;color:var(--tinta2);margin:0 0 12px}
.tabla-env{overflow-x:auto;background:var(--carta);border:1px solid var(--linea);border-radius:6px}
table{border-collapse:collapse;width:100%;min-width:1150px}
th{font-family:"Barlow Condensed",sans-serif;font-weight:600;font-size:13px;letter-spacing:1px;
  text-transform:uppercase;color:var(--tinta2);text-align:left;padding:9px 10px;
  border-bottom:1px solid var(--linea);white-space:nowrap;background:var(--carta);position:sticky;top:0;z-index:1}
th.n{text-align:right}
td{padding:5px 10px;vertical-align:top}
tr.a td{padding-top:8px} tr.b td{padding-bottom:8px;border-bottom:1px solid var(--linea)}
tr.a td[rowspan]{border-bottom:1px solid var(--linea)}
tr.par td{background:var(--franja)}
.c-cuando b{font-size:14px;font-weight:600;display:block;font-variant-numeric:tabular-nums;text-transform:capitalize}
.c-cuando .loc b{display:inline;font-size:12px;color:var(--tinta)}
.loc{display:block;font-size:11px;color:var(--tinta2);margin-top:1px;font-weight:400}
.c-torneo{font-size:13px;min-width:145px}
.c-ronda .mono{font-size:12px;font-weight:600;color:var(--acento)}
.c-jug{font-weight:500;min-width:185px} .c-jug b{color:var(--acento);font-weight:600}
.c-jug .pais{color:var(--tinta2);font-size:11px;margin-left:5px;font-weight:400}
.c-rank{font-size:12px;color:var(--tinta2);white-space:nowrap}
.wtn{display:block;font-size:11.5px;color:var(--tinta2);margin-top:1px}
.wtn.mejor{color:var(--acento);font-weight:600}
.c-od{text-align:right;font-size:14.5px;font-weight:600;font-variant-numeric:tabular-nums;width:62px}
.c-llega{font-family:"IBM Plex Mono",monospace;font-size:11px;color:var(--tinta2);line-height:1.6}
.c-llega i{font-style:normal} .c-llega .g{color:var(--acento);font-weight:600}
.c-llega .p{color:var(--alerta);font-weight:600} .c-llega .vs{color:var(--tinta);font-weight:600}
.c-link{white-space:nowrap;font-size:12.5px}
.c-link a{color:var(--acento);text-decoration:none} .c-link a:hover{text-decoration:underline}
.sin{color:var(--tinta2);opacity:.45}
.mono{font-family:"IBM Plex Mono",monospace;font-variant-numeric:tabular-nums}
.vacio{color:var(--tinta2);padding:34px;text-align:center;background:var(--carta);
  border:1px solid var(--linea);border-radius:6px}
footer{color:var(--tinta2);font-size:12px;border-top:1px solid var(--linea);padding-top:12px;margin-top:20px}
tr.analisis{display:none} body.an tr.analisis{display:table-row}
tr.analisis td{background:var(--acento-suave);font-size:12.5px;padding:7px 10px 9px;border-bottom:1px solid var(--linea)}
tr.analisis.top td{box-shadow:inset 3px 0 0 var(--acento)}
.conf{font-family:"IBM Plex Mono",monospace;font-size:10.5px;text-transform:uppercase;letter-spacing:.8px;
  padding:2px 7px;border-radius:99px;margin-right:8px;border:1px solid var(--linea);color:var(--tinta2)}
.conf.c-alta{background:var(--acento);color:var(--carta);border-color:transparent}
.conf.c-media{color:var(--acento);border-color:var(--acento)}
tr.analisis b{color:var(--tinta)} .pasar{color:var(--tinta2)!important;font-weight:600}
.mkt{color:var(--tinta2);font-size:11.5px}
.chip-top{background:var(--acento);color:var(--carta);font-size:10.5px;padding:2px 8px;border-radius:99px;margin-left:8px;font-weight:600}
.razon{display:block;color:var(--tinta2);margin-top:3px;line-height:1.5}
.bandera{display:inline-block;font-size:10.5px;color:var(--tinta2);border:1px solid var(--linea);
  padding:1px 7px;border-radius:99px;margin:5px 5px 0 0;background:var(--carta)}
.c-jug.elegido{color:var(--tinta)} .tick{color:var(--acento);font-weight:700;margin-right:3px}
.resumen{background:var(--carta);border:1px solid var(--linea);border-left:3px solid var(--acento);
  border-radius:6px;padding:16px 20px;margin-bottom:14px}
.resumen h2{font-family:"Barlow Condensed",sans-serif;font-weight:600;font-size:21px;margin:0 0 6px;letter-spacing:.5px}
.titular{font-size:14px;color:var(--tinta);margin:0 0 8px;font-weight:500}
.resumen-nota{font-size:12.5px;color:var(--tinta2);margin:0}
.mejores{margin:10px 0;padding-left:20px;display:flex;flex-direction:column;gap:9px;font-size:13.5px}
.mejores .ctx{color:var(--tinta2);font-size:11.5px;margin-left:8px}
a:focus-visible{outline:2px solid var(--acento);outline-offset:2px}
</style>
<div class="envoltura">
<div class="cabecera">
  <h1>Mesa ITF</h1>
  <span class="edad" id="edad" data-generado="${generado}">datos de hace <b>—</b></span>
  <div class="controles">
    <span class="orden">Ordenar:</span>
    <button id="b-torneo" class="on" onclick="ordenar('torneo')">Campeonato</button>
    <button id="b-hora" onclick="ordenar('hora')">Hora</button>
    <button id="b-an" onclick="verAnalisis()">🧠 Analizar</button>
    <button onclick="location.reload(true)">↻ Recargar</button>
  </div>
</div>
<p class="nota">Solo lo que ITF marca <b>por jugar</b> en su order of play (los jugados y en curso quedan fuera) · ${partidos.length} partidos, <b>${conCuota} con cuota</b> de Betano y ${partidos.length - conCuota} que Betano todavía no cotiza (abre la línea horas antes) · hora local del torneo y hora de Chile.</p>
<div id="resumen" class="resumen" hidden>
  <h2>Lo que ve el análisis</h2>
  ${analisis.titular ? `<p class="titular">${esc(analisis.titular)}</p>` : ''}
  <p class="resumen-nota">Sobre ${partidos.length} partidos por jugar, con las reglas medidas en ${saber.reglasMedidas?.length || 0} patrones de nuestros propios datos (${(saber.reglasMedidas || []).reduce((n, r) => n + (r.n || 0), 0).toLocaleString('es-CL')} partidos históricos). Análisis del ${analisis.generado ? analisis.generado.slice(0, 16).replace('T', ' ') + ' UTC' : '—'}.</p>
  <ol class="mejores">${(analisis.destacados || []).map(id => {
    const p = partidos.find(x => x.matchId === id); const v = analisis.veredictos[String(id)];
    if (!p || !v) return '';
    return `<li><b>${esc(v.favorito)}</b> <span class="mkt">${esc(v.mercado === '1er set' ? 'gana 1er set' : 'gana')}</span>
      <span class="ctx">${esc(p.t.nombre)} · ${esc(p.ronda)}</span><span class="razon">${esc(v.razon)}</span></li>`;
  }).join('')}</ol>
  <p class="resumen-nota">${Object.values(analisis.veredictos).filter(v => v.mercado === 'pasar').length} partidos marcados para pasar (parejos o en la banda de cuota donde el favorito rinde menos de lo que promete).</p>
</div>
${partidos.length ? `<div class="tabla-env"><table>
  <thead><tr><th>Cuándo</th><th>Campeonato</th><th>Ronda</th><th>Jugador</th><th>ATP / WTN</th>
    <th class="n">Gana</th><th class="n">1er set</th><th>Cómo llega</th><th>Betano</th></tr></thead>
  <tbody id="cuerpo">${partidos.map(filas).join('')}</tbody>
</table></div>` : '<p class="vacio">Nada por jugar en la programación de ITF ahora mismo. Recarga más tarde.</p>'}
<footer>Generado ${generado.slice(0, 16).replace('T', ' ')} UTC · manda el order of play oficial de itftennis.com; Betano acompaña vía OddsPapi (Ganador y Ganador 1er set) y su cuota puede abrir en cualquier momento · turno estimado cuando ITF dice "Followed By".</footer>
</div>
<script>
(function(){
  var el=document.getElementById('edad');
  function p(){var m=Math.round((Date.now()-new Date(el.dataset.generado).getTime())/60000);
    el.innerHTML='datos de hace <b>'+(m<60?m+' min':(m/60).toFixed(1)+' h')+'</b>';
    el.className='edad'+(m>360?' rancia':m>120?' vieja':'');}
  p();setInterval(p,60000);
  var cuerpo=document.getElementById('cuerpo');
  if(!cuerpo)return;
  window.ordenar=function(modo){
    var pares=[],vistos={};
    Array.prototype.forEach.call(cuerpo.querySelectorAll('tr.a'),function(tr){
      var b=tr.nextElementSibling, an=b&&b.nextElementSibling;
      if(an&&!an.classList.contains('analisis'))an=null;
      pares.push({a:tr,b:b,an:an,torneo:tr.dataset.torneo,ts:+tr.dataset.ts});});
    pares.sort(function(x,y){return modo==='hora'
      ? x.ts-y.ts || x.torneo.localeCompare(y.torneo)
      : x.torneo.localeCompare(y.torneo) || x.ts-y.ts;});
    pares.forEach(function(par,i){
      par.a.classList.toggle('par',i%2===1); par.b.classList.toggle('par',i%2===1);
      cuerpo.appendChild(par.a); cuerpo.appendChild(par.b);
      if(par.an)cuerpo.appendChild(par.an);});
    document.getElementById('b-torneo').className=modo==='hora'?'':'on';
    document.getElementById('b-hora').className=modo==='hora'?'on':'';
  };
  window.ordenar('torneo');
  window.verAnalisis=function(){
    var on=document.body.classList.toggle('an');
    document.getElementById('resumen').hidden=!on;
    document.getElementById('b-an').className=on?'on':'';
    document.getElementById('b-an').textContent=on?'🧠 Ocultar análisis':'🧠 Analizar';
  };
})();
</script>`;

fs.writeFileSync(SALIDA, html);
console.log(`✓ ${SALIDA} (${(html.length / 1024).toFixed(0)} KB) · ${partidos.length} por jugar (${conCuota} con cuota) · ${activos.length} torneos`);
