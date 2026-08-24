#!/usr/bin/env node
/* ============================================================
   ITF-PROXIMOS — la mesa de decisión: qué se puede jugar ahora.

   Una tarjeta POR TORNEO con su cuadro propio (Q1→Q2→R1→R2→QF→SF→F),
   las etapas cerradas resumidas y las que tienen partidos por jugar
   abiertas en detalle. Solo HOMBRES SINGLES: el order of play trae el
   campo tipo (MS/MSQ contra MD/WS/WSQ/WD) y se filtra por ahí, sin
   adivinar por nombre.

   NO SCRAPEA NADA: lee lo que dejó en disco itf-scrap.mjs y las cuotas
   que dejó el barrido de vigía. Si un dato está viejo, lo muestra con su
   hora en vez de disimularlo.

   Manda ITF: entra a la mesa lo que el order of play marca "pendiente",
   nunca lo que diga el reloj (los horarios son referenciales: "Followed
   By", "Not Before 15:30"). Betano acompaña, y cuando no abre línea se
   muestra la de bet365 marcada con ᴶ, que igual sirve para comparar
   mercado con realidad.

   Uso:  node vigia/itf-proximos.mjs
   ============================================================ */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pareceElMismo } from './itf-cruce.mjs';
import { analizar } from './itf-reglas.mjs';
import { torneosDelMapa, estadoDe, cargarMapa } from './itf-mapa.mjs';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const DATOS = path.join(DIR, 'datos', 'itf');
const OOP = path.join(DATOS, 'oop');
const VIVO = path.join(DATOS, 'vivo');
const SALIDA = path.join(DIR, 'itf-proximos.html');
const leer = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')) } catch { return null } };
const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const hoy = new Date().toISOString().slice(0, 10);

/* ---------- huso horario por país → hora de Chile ---------- */
const TZ = {
  'Argentina': 'America/Argentina/Buenos_Aires', 'Australia': 'Australia/Sydney', 'Austria': 'Europe/Vienna',
  'Belgium': 'Europe/Brussels', 'Brazil': 'America/Sao_Paulo', 'Bulgaria': 'Europe/Sofia',
  'Canada': 'America/Toronto', 'Chile': 'America/Santiago', 'China, P.R.': 'Asia/Shanghai',
  'Chinese Taipei': 'Asia/Taipei', 'Croatia': 'Europe/Zagreb', 'Czechia': 'Europe/Prague',
  'Denmark': 'Europe/Copenhagen', 'Egypt': 'Africa/Cairo', 'Finland': 'Europe/Helsinki',
  'France': 'Europe/Paris', 'Germany': 'Europe/Berlin', 'Great Britain': 'Europe/London',
  'Greece': 'Europe/Athens', 'Hungary': 'Europe/Budapest', 'India': 'Asia/Kolkata',
  'Indonesia': 'Asia/Jakarta', 'Ireland': 'Europe/Dublin', 'Italy': 'Europe/Rome',
  'Japan': 'Asia/Tokyo', 'Kazakhstan': 'Asia/Almaty', 'Korea, Republic of': 'Asia/Seoul',
  'Mexico': 'America/Mexico_City', 'Morocco': 'Africa/Casablanca', 'Netherlands': 'Europe/Amsterdam',
  'Norway': 'Europe/Oslo', 'Paraguay': 'America/Asuncion', 'Peru': 'America/Lima',
  'Poland': 'Europe/Warsaw', 'Portugal': 'Europe/Lisbon', 'Romania': 'Europe/Bucharest',
  'Serbia': 'Europe/Belgrade', 'Slovakia': 'Europe/Bratislava', 'Slovenia': 'Europe/Ljubljana',
  'Spain': 'Europe/Madrid', 'Sweden': 'Europe/Stockholm', 'Switzerland': 'Europe/Zurich',
  'Thailand': 'Asia/Bangkok', 'Tunisia': 'Africa/Tunis', 'Turkiye': 'Europe/Istanbul',
  'USA': 'America/New_York', 'Uruguay': 'America/Montevideo',
};
function offsetDe(ts, tz) {
  const p = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
    .formatToParts(new Date(ts)).reduce((o, x) => (o[x.type] = x.value, o), {});
  return Date.UTC(p.year, p.month - 1, p.day, p.hour % 24, p.minute, p.second) - ts;
}
function instante(fecha, hhmm, tz) {
  if (!tz || !fecha || !hhmm) return null;
  const [Y, M, D] = fecha.split('-').map(Number), [h, m] = hhmm.split(':').map(Number);
  const base = Date.UTC(Y, M - 1, D, h, m);
  let ts = base;
  for (let i = 0; i < 2; i++) ts = base - offsetDe(ts, tz);
  return new Date(ts);
}
const fmtDia = new Intl.DateTimeFormat('es-CL', { timeZone: 'America/Santiago', weekday: 'short', day: '2-digit', month: '2-digit' });
const fmtHora = new Intl.DateTimeFormat('es-CL', { timeZone: 'America/Santiago', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

/* ---------- contexto por torneo: entry list, cuadros, trayectorias ---------- */
const RONDA_NUM = { 1: 'R1', 2: 'R2', 3: 'QF', 4: 'SF', 5: 'F' };
const marcaDe = l => [l?.seed ? `[${l.seed}]` : null, l?.entrada && l.entrada !== 'DA' ? l.entrada : null].filter(Boolean).join(' ');

function contexto(clave) {
  const acc = leer(path.join(DATOS, clave + '.aceptacion.json'));
  const vivo = leer(path.join(VIVO, clave + '.json'));
  /* se conserva la seccion (MDA/Q/A/W/JR): la JR es la que manda para el
     veto por junior, medido en 31% de acierto contra 80% del resto */
  const lista = acc ? Object.entries(acc.secciones).flatMap(([sec, arr]) => arr.map(p => ({ ...p, seccion: sec }))) : [];
  return { lista, cuadros: vivo?.cuadros || {}, bajadoCuadro: vivo?.bajado || null };
}
/* ficha SIEMPRE de la entry list del propio torneo: el índice global
   produce falsos positivos con homónimos (pasó con Madaras y Noce) */
const fichaDe = (lista, nombre) => lista.find(x => pareceElMismo(nombre, { nombre: x.nombre })) || null;

function trayectoria(nombre, cuadros) {
  const pasos = [];
  for (const [ev, c] of Object.entries(cuadros).sort(([a], [b]) => (a === 'Q' ? 0 : 1) - (b === 'Q' ? 0 : 1))) {
    for (const r of c.rondas || []) for (const p of r.partidos) {
      if (p.estado !== 'jugado') continue;
      const idx = p.lados.findIndex(l => pareceElMismo(nombre, l));
      if (idx < 0) continue;
      const yo = p.lados[idx], rival = p.lados[1 - idx];
      const ronda = ev === 'Q' ? 'Q' + r.numero : (RONDA_NUM[r.numero] || 'R' + r.numero);
      const sets = yo.sets.map((s, i) => s + '-' + (rival.sets[i] ?? '?')).join(' ');
      const vs = marcaDe(rival).replace(' ', '');
      pasos.push(`<i class="${yo.ganador ? 'g' : 'p'}">${ronda}${yo.ganador ? '✓' : '✗'}</i> ${esc(sets)}`
        + (vs ? ` <i class="vs">v${esc(vs)}</i>` : '')
        + (/retired/i.test(p.nota || '') && !yo.ganador ? ' <i class="p">RET</i>' : ''));
    }
  }
  return pasos.join(' · ');
}
const trayTexto = h => String(h).replace(/<[^>]+>/g, '');

/* ---------- cuotas ----------
   Tres fuentes, en este orden: Betano vía OddsPapi, bet365 vía OddsPapi
   como respaldo, y cuotas leídas A MANO de betano.com.

   Las manuales existen por necesidad, no por gusto: OddsPapi indexa el
   fixture pero no entrega el precio hasta que el partido empieza (las
   cinco finales del 2026-08-23 estaban indexadas y sin cuotas mientras
   Betano las pagaba), y betano.com nos bloquea con 403 de Cloudflare
   porque salimos desde un datacenter en EE.UU. Se marcan aparte para no
   confundirlas nunca con las del feed. */
const manuales = leer(path.join(DIR, 'itf-cuotas-manuales.json'))?.cuotas || [];
const tablero = leer(path.join(DIR, 'itf.json')) || { partidos: {} };
const idxCuotas = Object.values(tablero.partidos).filter(e => e.p1 && e.p2 && (e.g || e.jg));
function cuotasDe(n0, n1) {
  for (const e of idxCuotas) {
    let ord = null;
    if (pareceElMismo(e.p1, { nombre: n0 }) && pareceElMismo(e.p2, { nombre: n1 })) ord = ['p1', 'p2'];
    else if (pareceElMismo(e.p1, { nombre: n1 }) && pareceElMismo(e.p2, { nombre: n0 })) ord = ['p2', 'p1'];
    if (!ord) continue;
    const casa = e.g ? 'betano' : 'bet365';
    const G = e.g || e.jg, S = e.g ? e.s1 : e.js1;
    /* si ambas casas tienen línea y discrepan en quién es favorito, la
       cuota deja de ser fiable: se muestra pero marcada (visto 1 de 4) */
    let discrepan = false;
    if (e.g && e.jg) discrepan = ((e.g.p1 <= e.g.p2) !== (e.jg.p1 <= e.jg.p2));
    return {
      casa, discrepan, manual: false, bFix: e.bFix || null, cuotasAl: e.cuotasAl || null,
      lados: ord.map(k => ({ gana: G?.[k] ?? null, set1: S?.[k] ?? null })),
    };
  }
  /* nada en el feed: se busca en las leídas a mano */
  for (const m of manuales) {
    let inv = null;
    if (pareceElMismo(m.p1, { nombre: n0 }) && pareceElMismo(m.p2, { nombre: n1 })) inv = false;
    else if (pareceElMismo(m.p1, { nombre: n1 }) && pareceElMismo(m.p2, { nombre: n0 })) inv = true;
    if (inv === null) continue;
    const g = inv ? [m.g2, m.g1] : [m.g1, m.g2];
    const s1 = inv ? [m.s2, m.s1] : [m.s1, m.s2];
    return {
      casa: 'betano', discrepan: false, manual: true, bFix: null, cuotasAl: m.visto || null,
      lados: [0, 1].map(i => ({ gana: g[i] ?? null, set1: s1[i] ?? null })),
    };
  }
  return null;
}

/* ---------- armar los torneos ---------- */
const mapa = cargarMapa();
const activos = torneosDelMapa(mapa, hoy).filter(x => x.estado === 'QUALI' || x.estado === 'MAIN');
const ORDEN_ETAPA = ['Q1', 'Q2', 'Q3', 'R1', 'R2', 'R3', 'QF', 'SF', 'F'];
const nombreEtapa = (ev, ronda) => {
  const corto = { '1st Round': 'R1', '2nd Round': 'R2', '3rd Round': 'R3', 'Quarter-finals': 'QF', 'Quarter-final': 'QF', 'Semi-finals': 'SF', 'Semi-final': 'SF', 'Final': 'F' }[ronda] || ronda;
  return ev === 'Q' ? (corto === 'R1' ? 'Q1' : corto === 'R2' ? 'Q2' : corto === 'R3' ? 'Q3' : 'Q·' + corto) : corto;
};

const torneos = [];
let totalPend = 0, totalConCuota = 0;
for (const { clave, t, estado } of activos) {
  const ctx = contexto(clave);
  const tz = TZ[t.pais];
  /* progreso por etapa desde el cuadro oficial */
  const etapas = new Map();
  for (const [ev, c] of Object.entries(ctx.cuadros)) {
    for (const r of c.rondas || []) {
      const nom = nombreEtapa(ev, r.nombre);
      const jug = r.partidos.filter(p => p.estado === 'jugado').length;
      etapas.set(nom, { nombre: nom, total: r.partidos.length, jugados: jug, pendientes: [] });
    }
  }
  /* partidos por jugar, del order of play (la fuente al día) */
  let dias = [];
  try { dias = fs.readdirSync(OOP).filter(f => f.startsWith(clave + '-2')); } catch {}
  for (const f of dias.sort()) {
    const j = leer(path.join(OOP, f));
    if (!j || j.fecha < hoy) continue;
    for (const p of j.partidos || []) {
      if (p.tipo !== 'MS' && p.tipo !== 'MSQ') continue;      // solo hombres singles
      if (p.estado !== 'pendiente') continue;                 // manda ITF
      const nombres = (p.lados || []).map(l => l.nombre).filter(Boolean);
      if (nombres.length !== 2) continue;
      const hhmm = (String(p.horario).match(/(\d{1,2}:\d{2})/) || [])[1] || null;
      const inicio = instante(j.fecha, hhmm, tz);
      const cq = cuotasDe(nombres[0], nombres[1]);
      const lados = p.lados.map((l, i) => {
        const fi = fichaDe(ctx.lista, l.nombre) || {};
        const llegaHtml = trayectoria(l.nombre, ctx.cuadros);
        return {
          nombre: l.nombre, pais: (l.jugadores || [])[0]?.pais || fi.pais || '',
          marca: marcaDe(l) || (fi.seccion === 'JR' ? 'JR' : ''),
          atp: fi.atp ?? null, itf: fi.itf ?? null, wtn: fi.wtn ?? null,
          wtnVisible: fi.wtnVisible !== false, jr: fi.seccion === 'JR',
          gana: cq?.lados[i].gana ?? null, set1: cq?.lados[i].set1 ?? null,
          llegaHtml, llega: trayTexto(llegaHtml),
        };
      });
      const etapa = nombreEtapa(p.evento, p.ronda);
      const v = analizar({ lados, ronda: p.evento === 'Q' ? 'Q·' + p.ronda : p.ronda });
      const fila = { id: p.matchId, etapa, fecha: j.fecha, hhmm, horarioTxt: p.horario || '', inicio, cancha: p.cancha, turno: p.orden, lados, cq, v };
      if (!etapas.has(etapa)) etapas.set(etapa, { nombre: etapa, total: 0, jugados: 0, pendientes: [] });
      etapas.get(etapa).pendientes.push(fila);
      totalPend++; if (cq) totalConCuota++;
    }
  }
  const lista = [...etapas.values()].sort((a, b) => {
    const ia = ORDEN_ETAPA.indexOf(a.nombre), ib = ORDEN_ETAPA.indexOf(b.nombre);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  });
  const pend = lista.reduce((n, e) => n + e.pendientes.length, 0);
  if (!pend) continue;
  const prox = Math.min(...lista.flatMap(e => e.pendientes.map(p => p.inicio ? +p.inicio : Infinity)));
  torneos.push({ clave, t, estado, etapas: lista, pend, prox, bajadoCuadro: ctx.bajadoCuadro });
}
torneos.sort((a, b) => a.prox - b.prox || a.t.nombre.localeCompare(b.t.nombre));

/* ---------- render ---------- */
const num = v => v == null ? '<span class="sin">·</span>' : (+v).toFixed(2);
/* Las cinco etiquetas que puede llevar una fila. "sin precio" no es un
   veredicto: dice el nivel y se calla, porque sin cuota la pregunta de si
   conviene apostar no tiene respuesta. */
const ETIQUETA = { segura: '✓ SEGURA', anomalia: '⚡ ANOMALÍA', mirar: '· mirar', pasar: '— pasar', 'sin-precio': '· sin precio' };
function filaPartido(p, tClave) {
  /* Sin hora fija ("Followed By", "After Rest"): se muestra el texto de ITF
     tal cual, que es la unica verdad disponible, y el dia del order of play. */
  const dia = p.inicio ? fmtDia.format(p.inicio) : (p.fecha ? fmtDia.format(new Date(p.fecha + 'T12:00:00Z')) : '—');
  const horaCl = p.inicio ? fmtHora.format(p.inicio) + ' CL' : `<span class="sinhora">${esc(p.horarioTxt || 'sin hora')}</span>`;
  const cq = p.cq;
  const marcaCasa = cq?.manual ? '<abbr class="casaMan" title="cuota de Betano leída a mano: OddsPapi no la entrega hasta que el partido empieza">✋</abbr>'
    : cq?.casa === 'bet365' ? '<abbr class="casa365" title="cuota de bet365: Betano aún no abre línea">ᴶ</abbr>' : '';
  const jug = (l, k) => {
    const alerta = l.wtn == null ? '<abbr class="alerta" title="sin WTN en la entry list">⚠sinWTN</abbr>'
      : !l.wtnVisible ? '<abbr class="alerta" title="ITF marca este rating como no mostrable (insignia ProZone)">⚠PZ</abbr>'
      : l.atp == null ? '<abbr class="alerta" title="sin ranking ATP: su WTN mide partidos viejos">⚠sinATP</abbr>' : '';
    const elegido = /^(segura|anomalia|mirar)$/.test(p.v.tipo) && p.v.nivel && p.lados[k].nombre === p.v.nivel.favorito.replace(/\s*\[.*$/, '').trim();
    return `<div class="jug${elegido ? ' elegido' : ''}">
      <div class="j-nom">${elegido ? '<span class="tick">▸</span>' : ''}${esc(l.nombre)}${l.marca ? ` <b class="marca">${esc(l.marca)}</b>` : ''}<span class="pais">${esc(l.pais)}</span></div>
      <div class="j-niv mono">${l.atp ? 'ATP ' + l.atp : '<span class="sin">sin ATP</span>'} · ${l.wtn != null ? 'WTN ' + (+l.wtn).toFixed(2) : '<span class="sin">sin WTN</span>'} ${alerta}</div>
      <div class="j-od mono">${num(l.gana)}${marcaCasa}<span class="s1">1s ${l.set1 != null ? (+l.set1).toFixed(2) : '·'}</span></div>
      <div class="j-llega">${l.llegaHtml || '<span class="sin">debuta</span>'}</div>
    </div>`;
  };
  return `<article class="partido" data-etapa="${esc(p.etapa)}" data-cuota="${cq ? 1 : 0}" data-tipo="${esc(p.v.tipo)}">
    <header class="p-cab">
      <span class="mono cuando"><b>${esc(dia)}</b> ${horaCl}${p.hhmm ? `<span class="loc">${esc(p.hhmm)} loc</span>` : ''}</span>
      <span class="lugar">${esc(p.cancha || '')}${p.turno ? ` · ${p.turno}º turno` : ''}</span>
      ${cq?.bFix ? `<a class="link" href="https://lat.betano.com/cuotas-de-partido/e-e/${esc(cq.bFix)}/" target="_blank" rel="noopener">Betano ↗</a>` : ''}
      ${cq?.discrepan ? '<span class="disc" title="Betano y bet365 no coinciden en quién es favorito: cuota poco fiable">⚡ casas en desacuerdo</span>' : ''}
    </header>
    ${jug(p.lados[0], 0)}${jug(p.lados[1], 1)}
    <p class="veredicto t-${esc(p.v.tipo)}">
      <span class="etiq">${ETIQUETA[p.v.tipo] || p.v.tipo}</span>
      ${p.v.tipo === 'pasar' ? '' : `<b>${esc(p.v.favorito)}</b>`}
      ${p.v.nivel ? `<span class="niv">nivel ${esc(p.v.nivel.fuerza)} · ${Math.round(p.v.nivel.p * 100)}%${p.v.precio ? '' : ` · desde ${p.v.nivel.cMinima.toFixed(2)}`}</span>` : ''}
      <span class="razon">${esc(p.v.razon)}</span>
    </p>
  </article>`;
}

const secciones = torneos.map((T, iT) => {
  const etapasHtml = T.etapas.map(e => {
    const pct = e.total ? Math.round(e.jugados / e.total * 100) : 0;
    const abierta = e.pendientes.length > 0;
    /* En qualis el cuadro todavia no existe: sin total no hay barra que pintar. */
    const conCuadro = e.total > 0;
    const cab = `<summary class="e-cab"><span class="chev" aria-hidden="true"></span>
      <span class="e-nom mono">${esc(e.nombre)}</span>
      ${conCuadro ? `<span class="barra" style="--pct:${pct}%" title="${e.jugados} de ${e.total} jugados"></span>
      <span class="e-num mono">${e.jugados}/${e.total}</span>` : '<span class="e-sincuadro">cuadro aún sin publicar</span>'}
      ${abierta ? `<span class="e-pend">${e.pendientes.length} por jugar</span>` : '<span class="e-fin">completa</span>'}</summary>`;
    /* Las etapas ya jugadas no despliegan nada: no hay partido que mostrar. */
    if (!abierta) return `<div class="etapa cerrada">${cab.replace('<summary', '<div').replace('</summary>', '</div>')}</div>`;
    return `<details class="etapa abierta" open>${cab}
      <div class="e-cuerpo">${e.pendientes.sort((a, b) => (a.inicio || 0) - (b.inicio || 0)).map(p => filaPartido(p, T.clave)).join('')}</div>
    </details>`;
  }).join('');
  const prox = Number.isFinite(T.prox) ? new Date(T.prox) : null;
  /* Se abren solos los tres torneos que juegan antes: el resto, a un clic. */
  const abrir = iT < 3 ? ' open' : '';
  return `<details class="torneo"${abrir} data-torneo="${esc(T.t.nombre)}">
    <summary class="t-cab">
      <span class="chev" aria-hidden="true"></span>
      <h2>${esc(T.t.nombre)}</h2>
      <span class="pill p-${T.estado.toLowerCase()}">${T.estado === 'QUALI' ? 'qualis' : 'en juego'}</span>
      <span class="t-meta">${esc(T.t.pais)} · ${esc(T.t.superficie || '')} · ${esc(T.t.bolsa || '')}</span>
      <span class="t-cifras">
        <b>${T.pend}</b> por jugar${prox ? ` <span class="t-prox mono">· desde ${esc(fmtDia.format(prox))} ${esc(fmtHora.format(prox))}</span>` : ''}
      </span>
    </summary>
    <div class="etapas">${etapasHtml}</div>
  </details>`;
}).join('');

const generado = new Date().toISOString();
const html = `<title>Próximos ITF</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@600;700&family=IBM+Plex+Sans:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500;600&display=swap">
<style>
:root{--papel:#F3F5F7;--carta:#FFF;--tinta:#1A2732;--tinta2:#5A6B7A;--linea:#D9E0E6;
  --acento:#0F6B5C;--acento-suave:#E3EFEB;--alerta:#A33B2A;--ambar:#8A6116;--ambar-suave:#F6EEDC;--franja:#F7F9FA}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--papel:#0F151B;--carta:#161F28;
  --tinta:#DAE4EC;--tinta2:#8FA1B0;--linea:#26313C;--acento:#3FB79E;--acento-suave:#15302B;
  --alerta:#E08A79;--ambar:#D9A94B;--ambar-suave:#2A2415;--franja:#131C24}}
:root[data-theme="dark"]{--papel:#0F151B;--carta:#161F28;--tinta:#DAE4EC;--tinta2:#8FA1B0;
  --linea:#26313C;--acento:#3FB79E;--acento-suave:#15302B;--alerta:#E08A79;--ambar:#D9A94B;--ambar-suave:#2A2415;--franja:#131C24}
*{box-sizing:border-box}
body{margin:0;background:var(--papel);color:var(--tinta);font:14px/1.45 "IBM Plex Sans",system-ui,sans-serif}
.envoltura{max-width:1180px;margin:0 auto;padding:18px 14px 60px}
header.cab{display:flex;align-items:baseline;gap:12px;flex-wrap:wrap}
h1{font-family:"Barlow Condensed",sans-serif;font-weight:700;font-size:30px;margin:0;letter-spacing:.5px}
.gen{font-size:12.5px;color:var(--tinta2)} .gen b{font-variant-numeric:tabular-nums}
.filtros{display:flex;gap:8px;flex-wrap:wrap;margin:12px 0 6px}
button{font:600 12.5px "IBM Plex Sans",sans-serif;color:var(--tinta2);background:var(--carta);
  border:1px solid var(--linea);border-radius:999px;padding:6px 13px;cursor:pointer}
button:hover{border-color:var(--acento);color:var(--acento)}
button.on{background:var(--acento);color:var(--carta);border-color:var(--acento)}
button.fantasma{background:none;border-style:dashed}
.sep{flex:0 0 10px}
button:focus-visible{outline:2px solid var(--acento);outline-offset:2px}
.nota{font-size:12.5px;color:var(--tinta2);margin:2px 0 18px;max-width:74ch}
/* --- torneo y etapa: acordeones nativos (<details>) --- */
summary{cursor:pointer;list-style:none}
summary::-webkit-details-marker{display:none}
summary:focus-visible{outline:2px solid var(--acento);outline-offset:-2px}
.chev{flex:0 0 auto;width:9px;height:9px;border-right:2px solid var(--tinta2);border-bottom:2px solid var(--tinta2);
  transform:rotate(-45deg);transform-origin:60% 60%;margin-right:3px}
@media (prefers-reduced-motion:no-preference){.chev{transition:transform .16s ease}}
details[open]>summary>.chev{transform:rotate(45deg)}

.torneo{margin-top:12px;background:var(--carta);border:1px solid var(--linea);border-radius:8px;overflow:hidden}
.torneo[open]{box-shadow:0 1px 3px rgba(0,0,0,.05)}
.t-cab{display:flex;align-items:center;gap:9px;flex-wrap:wrap;padding:11px 14px;background:var(--franja)}
.torneo[open]>.t-cab{border-bottom:1px solid var(--linea)}
.t-cab:hover{background:var(--acento-suave)}
.t-cab h2{font-family:"Barlow Condensed",sans-serif;font-weight:700;font-size:20px;margin:0;letter-spacing:.3px}
.t-meta{font-size:12px;color:var(--tinta2)}
.t-cifras{margin-left:auto;font-size:12px;color:var(--tinta2);font-variant-numeric:tabular-nums}
.t-cifras b{color:var(--tinta)}
.t-prox{font-size:11.5px}
.pill{font-size:10.5px;font-weight:600;letter-spacing:.5px;text-transform:uppercase;padding:2px 8px;border-radius:999px}
.p-quali{background:var(--ambar-suave);color:var(--ambar)} .p-main{background:var(--acento-suave);color:var(--acento)}
.etapas{padding:4px 0}
.etapa{border-top:1px solid var(--linea)}
.etapa:first-child{border-top:none}
.e-cab{display:flex;align-items:center;gap:10px;padding:7px 14px}
details.etapa>.e-cab:hover{background:var(--franja)}
.e-nom{font-weight:600;min-width:30px;font-size:13px}
.barra{flex:0 0 120px;height:5px;border-radius:3px;background:var(--linea);position:relative;overflow:hidden}
.barra::before{content:"";position:absolute;inset:0;width:var(--pct);background:var(--acento);border-radius:3px}
.e-num{font-size:12px;color:var(--tinta2)}
.e-pend{font-size:11.5px;font-weight:600;color:var(--ambar);background:var(--ambar-suave);padding:2px 8px;border-radius:999px}
.e-fin{font-size:11.5px;color:var(--tinta2)}
.e-sincuadro{font-size:11.5px;color:var(--tinta2);font-style:italic}
.sinhora{color:var(--ambar);font-style:italic}
.etapa.cerrada{opacity:.5}
.etapa.cerrada .chev{visibility:hidden}
.e-cuerpo{padding-bottom:4px}
.partido{margin:2px 10px 12px;border:1px solid var(--linea);border-radius:6px;overflow:hidden}
.p-cab{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:6px 11px;background:var(--franja);font-size:12px}
.cuando b{font-weight:600} .cuando .loc{color:var(--tinta2);margin-left:6px;font-size:11px}
.lugar{color:var(--tinta2)}
.link{margin-left:auto;color:var(--acento);text-decoration:none;font-weight:600}
.link:hover{text-decoration:underline}
.disc{color:var(--alerta);font-weight:600;font-size:11.5px}
.jug{display:grid;grid-template-columns:minmax(150px,1.3fr) minmax(130px,1fr) 96px minmax(180px,1.6fr);
  gap:8px;padding:7px 11px;border-top:1px solid var(--linea);align-items:baseline}
.jug.elegido{background:var(--acento-suave)}
.j-nom{font-weight:600} .marca{color:var(--acento)} .pais{color:var(--tinta2);font-weight:400;font-size:11px;margin-left:5px}
.j-niv{font-size:12px;color:var(--tinta2)}
.j-od{font-size:13.5px;font-weight:600;font-variant-numeric:tabular-nums}
.j-od .s1{display:block;font-size:11px;font-weight:400;color:var(--tinta2)}
.casa365{font-size:11px;color:var(--ambar);text-decoration:none;border:none;margin-left:2px}
.casaMan{font-size:10px;text-decoration:none;border:none;margin-left:3px;opacity:.75}
.alerta{color:var(--alerta);font-size:10.5px;font-weight:600;text-decoration:none;border:none;white-space:nowrap}
.j-llega{font-size:11.5px;color:var(--tinta2);line-height:1.5}
.j-llega i{font-style:normal;font-family:"IBM Plex Mono",monospace}
.j-llega .g{color:var(--acento);font-weight:600} .j-llega .p{color:var(--alerta);font-weight:600}
.j-llega .vs{color:var(--tinta2);opacity:.8}
.tick{color:var(--acento);margin-right:3px}
.sin{color:var(--tinta2);opacity:.7}
.mono{font-family:"IBM Plex Mono",monospace;font-variant-numeric:tabular-nums}
.veredicto{margin:0;padding:7px 11px;border-top:1px solid var(--linea);font-size:12.5px;background:var(--carta)}
.etiq{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.6px;padding:2px 8px;
  border-radius:999px;margin-right:8px;background:var(--franja);color:var(--tinta2);white-space:nowrap}
.t-segura .etiq{background:var(--acento);color:var(--carta)}
.t-anomalia .etiq{background:var(--ambar);color:var(--carta)}
.t-mirar .etiq{background:var(--acento-suave);color:var(--acento)}
.t-segura{border-left:3px solid var(--acento)}
.t-anomalia{border-left:3px solid var(--ambar)}
.niv{font-size:11.5px;color:var(--tinta2);margin-left:7px;font-variant-numeric:tabular-nums}
.razon{color:var(--tinta2);margin-left:6px}
.vacio{padding:40px 0;text-align:center;color:var(--tinta2)}
footer{margin-top:30px;font-size:12px;color:var(--tinta2);max-width:80ch}
</style>
<div class="envoltura">
<header class="cab">
  <h1>Próximos ITF</h1>
  <span class="gen">generado <b>${esc(generado.slice(0, 16).replace('T', ' '))}</b> UTC · ${torneos.length} torneos · <b>${totalPend}</b> por jugar · <b>${totalConCuota}</b> con cuota</span>
</header>
<div class="filtros">
  <button id="f-etapa" class="on" data-modo="temprano">Solo qualis, R1 y R2</button>
  <button id="f-cuota" data-modo="todos">Solo con cuota</button>
  <button id="f-jugables" data-modo="todos">Solo seguras y anomalías</button>
  <span class="sep"></span>
  <button id="b-abrir" class="fantasma">Abrir todo</button>
  <button id="b-cerrar" class="fantasma">Cerrar todo</button>
</div>
<p class="nota">Manda el <b>order of play</b> de ITF: entra lo que marca “to be played”, nunca lo que diga el reloj. Solo hombres singles. Betano acompaña y, cuando no abre línea, se muestra la de bet365 marcada <span class="casa365">ᴶ</span>; las leídas a mano de betano.com van con <span class="casaMan">✋</span>, porque el feed no las entrega hasta que el partido empieza. El filtro por defecto deja las qualis y primeras rondas, que es donde el nivel predice 75-84%; de cuartos en adelante cae a 56%.</p>
${torneos.length ? secciones : '<p class="vacio">No hay partidos por jugar en la programación de ITF ahora mismo. Corre <span class="mono">node vigia/itf-scrap.mjs</span> y vuelve a generar.</p>'}
<footer>Datos en disco de <span class="mono">itf-scrap.mjs</span> (order of play, cuadros y entry lists) y del barrido de cuotas de vigía. Esta página no baja nada: si algo está viejo, la hora lo dice. Los veredictos salen de las reglas medidas en <span class="mono">itf-saber.json</span> vía <span class="mono">itf-reglas.mjs</span>.</footer>
</div>
<script>
(function(){
  var TEMPRANO = {Q1:1,Q2:1,Q3:1,R1:1,R2:1};
  var bE = document.getElementById('f-etapa'), bC = document.getElementById('f-cuota'), bJ = document.getElementById('f-jugables');
  function pinta(){
    var soloTemp = bE.classList.contains('on'), soloCuota = bC.classList.contains('on'), soloJug = bJ.classList.contains('on');
    document.querySelectorAll('.partido').forEach(function(p){
      var ok = (!soloTemp || TEMPRANO[p.dataset.etapa]) && (!soloCuota || p.dataset.cuota === '1')
        && (!soloJug || p.dataset.tipo === 'segura' || p.dataset.tipo === 'anomalia');
      p.hidden = !ok;
    });
    document.querySelectorAll('details.etapa').forEach(function(e){
      var vis = [].slice.call(e.querySelectorAll('.partido')).some(function(p){ return !p.hidden; });
      e.hidden = !vis;
    });
    /* una etapa ya jugada solo estorba si su torneo quedo sin nada por jugar */
    document.querySelectorAll('.torneo').forEach(function(t){
      var vis = [].slice.call(t.querySelectorAll('.partido')).some(function(p){ return !p.hidden; });
      t.hidden = !vis;
      t.querySelectorAll('.etapa.cerrada').forEach(function(e){ e.hidden = !vis; });
    });
  }
  [bE, bC, bJ].forEach(function(b){ b.onclick = function(){ b.classList.toggle('on'); pinta(); }; });
  function todos(abrir){
    document.querySelectorAll('.torneo').forEach(function(t){ if(!t.hidden) t.open = abrir; });
    if (abrir) document.querySelectorAll('details.etapa').forEach(function(e){ e.open = true; });
  }
  document.getElementById('b-abrir').onclick = function(){ todos(true); };
  document.getElementById('b-cerrar').onclick = function(){ todos(false); };
  pinta();
})();
</script>`;

fs.writeFileSync(SALIDA, html);

/* Dossier plano para la tabla esquemática (itf-tabla.mjs): mismos datos,
   sin decisiones tomadas. Sebastián quiere ver las variables crudas y
   filtrar por su cuenta, así que se guarda todo lo que entra al juicio. */
const dossier = [];
for (const T of torneos) for (const e of T.etapas) for (const p of e.pendientes) {
  const k = p.v.nivel ? p.lados.findIndex(l => l.nombre === p.v.nivel.favorito.replace(/\s*\[.*$/, '').trim()) : -1;
  const [yo, otro] = k >= 0 ? [p.lados[k], p.lados[1 - k]] : p.lados;
  dossier.push({
    id: p.id, torneo: T.t.nombre, pais: T.t.pais, superficie: T.t.superficie, categoria: T.t.categoria,
    etapa: p.etapa, fecha: p.fecha, hhmm: p.hhmm, horarioTxt: p.horarioTxt,
    inicio: p.inicio ? p.inicio.toISOString() : null, cancha: p.cancha, turno: p.turno,
    yo: { nombre: yo.nombre, pais: yo.pais, marca: yo.marca, atp: yo.atp, itf: yo.itf, wtn: yo.wtn,
      wtnVisible: yo.wtnVisible, jr: yo.jr, gana: yo.gana, llega: yo.llega, llegaHtml: yo.llegaHtml },
    otro: { nombre: otro.nombre, pais: otro.pais, marca: otro.marca, atp: otro.atp, itf: otro.itf, wtn: otro.wtn,
      wtnVisible: otro.wtnVisible, jr: otro.jr, gana: otro.gana, llega: otro.llega, llegaHtml: otro.llegaHtml },
    casa: p.cq?.manual ? 'mano' : p.cq?.casa || null,
    cuotasAl: p.cq?.cuotasAl || null, bFix: p.cq?.bFix || null,
    v: p.v,
  });
}
fs.writeFileSync(path.join(DIR, 'itf-proximos-datos.json'), JSON.stringify({ generado, partidos: dossier }));
console.log(`✓ ${SALIDA} (${(html.length / 1024).toFixed(0)} KB) · ${torneos.length} torneos · ${totalPend} por jugar (${totalConCuota} con cuota)`);
