#!/usr/bin/env node
/* ============================================================
   ITF-MESA — genera vigia/itf-mesa.html: la mesa de decisión.

   Una sola lista, ordenada por hora, con TODO partido por jugar que
   tenga cuotas en el tablero de vigía (itf.json). Por partido:
     · torneo (país, categoría) y hora de Chile
     · cada jugador con seed/entrada, ranking de entry list y cómo
       llega (con la marca del rival de cada resultado)
     · los DOS mercados que Betano ofrece en ITF: Ganador y Ganador
       1er set, ambos lados, solo Betano
     · link directo al partido en Betano

   El botón "Recargar" trae la última versión publicada (la rutina
   regenera cada 6 h y a pedido); la página muestra la edad de los
   datos para que nunca apuestes sobre una foto vieja.

   El panel (itf-panel.html) queda como tablero de observación;
   esta mesa es solo lo apostable, ahora.

   Uso: node vigia/itf-mesa.mjs   → escribe vigia/itf-mesa.html
   ============================================================ */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pareceElMismo, normalizar } from './itf-cruce.mjs';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const DATOS = path.join(DIR, 'datos', 'itf');
const VIVO = path.join(DATOS, 'vivo');
const SALIDA = path.join(DIR, 'itf-mesa.html');

const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const leer = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')) } catch { return null; } };

const cal = leer(path.join(DIR, 'itf-calendario.json')) || { torneos: [] };
const tablero = leer(path.join(DIR, 'itf.json')) || { partidos: {} };

/* ---------- contexto de cuadro por ciudad ---------- */
const memoria = new Map();   /* ciudad normalizada → {torneos:[{meta, cuadros, listado}]} */
function contextoDe(ciudad) {
  const c = normalizar(ciudad);
  if (memoria.has(c)) return memoria.get(c);
  const out = [];
  for (const t of cal.torneos) {
    if (!normalizar(t.nombre).includes(c) && !normalizar(t.sede || '').includes(c)) continue;
    const vivo = leer(path.join(VIVO, t.clave + '.json'));
    if (!vivo) continue;
    const acc = leer(path.join(DATOS, t.clave + '.aceptacion.json'));
    out.push({ meta: t, cuadros: vivo.cuadros, listado: acc ? Object.values(acc.secciones).flat() : [] });
  }
  memoria.set(c, out);
  return out;
}

const RONDA_CORTA = { 1: 'R1', 2: 'R2', 3: 'QF', 4: 'SF', 5: 'F' };
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
        const ronda = evento === 'Q' ? 'Q' + r.numero : (RONDA_CORTA[r.numero] || 'R' + r.numero);
        const pares = yo.sets.map((s, i) => s + '-' + (rival.sets[i] ?? '?')).join(' ');
        const vs = marcaDe(rival);
        pasos.push(`<span class="${yo.ganador ? 'g' : 'p'}">${ronda}${yo.ganador ? '✓' : '✗'} ${esc(pares)}</span>`
          + (vs ? ` <span class="vs">v${esc(vs.replace(' ', ''))}</span>` : '')
          + (/retired/i.test(p.nota || '') && !yo.ganador ? ' <span class="p">RET</span>' : ''));
      }
    }
  }
  return pasos.join(' · ');
}

/* Busca el partido pendiente en los cuadros y arma el contexto por jugador. */
function contexto(e) {
  for (const ctx of contextoDe(e.torneo)) {
    for (const [evento, c] of Object.entries(ctx.cuadros)) {
      for (const r of c.rondas) {
        for (const p of r.partidos) {
          if (!p.lados.every(l => l.nombre)) continue;
          let orden = null;
          if (pareceElMismo(e.p1, p.lados[0]) && pareceElMismo(e.p2, p.lados[1])) orden = [0, 1];
          else if (pareceElMismo(e.p1, p.lados[1]) && pareceElMismo(e.p2, p.lados[0])) orden = [1, 0];
          if (!orden) continue;
          const ronda = evento === 'Q' ? 'Q·R' + r.numero : (RONDA_CORTA[r.numero] || 'R' + r.numero);
          const jug = orden.map(i => {
            const l = p.lados[i];
            const en = ctx.listado.find(x => pareceElMismo(l.nombre, { nombre: x.nombre }));
            return {
              marca: marcaDe(l),
              rank: en?.atp ? 'ATP ' + en.atp : (en?.wtn ? 'WTN ' + en.wtn : null),
              llega: trayectoria(l.nombre, ctx.cuadros),
            };
          });
          return { meta: ctx.meta, ronda, jug, yaJugado: p.estado === 'jugado' };
        }
      }
    }
  }
  return null;
}

/* ---------- filas de la mesa ---------- */
const ahora = Date.now();
/* Por jugar = cuota viva (refrescada en el último barrido: si Betano la
   tiene activa, el partido NO ha empezado — cubre los atrasados por lluvia
   cuya hora del feed ya pasó) o inicio futuro. */
const proximos = Object.values(tablero.partidos)
  .filter(e => e.estado === 'pendiente' && e.p1 && e.p2 && e.g
    && ((e.cuotasAl && ahora - new Date(e.cuotasAl).getTime() < 90 * 60e3)
      || (e.t && new Date(e.t).getTime() > ahora - 30 * 60e3)))
  .sort((a, b) => new Date(a.t || 0) - new Date(b.t || 0));

const horaCl = t => new Intl.DateTimeFormat('es-CL', { timeZone: 'America/Santiago', weekday: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(t));
const cuota = v => v == null ? '—' : (+v).toFixed(2);

let descartadosPorCuadro = 0;
const filasHtml = proximos.map(e => {
  const ctx = contexto(e);
  if (ctx?.yaJugado) { descartadosPorCuadro++; return ''; }
  const pais = ctx?.meta?.pais ? ` (${ctx.meta.pais})` : '';
  const catChip = ctx?.meta?.categoria ? `<span class="chip">${esc(ctx.meta.categoria)}</span> ` : '';
  const jug = [e.p1, e.p2].map((n, i) => {
    const c = ctx?.jug?.[i];
    return `<div class="linea-jug">
      <span class="nom">${esc(n)}${c?.marca ? ' <b>' + esc(c.marca) + '</b>' : ''}</span>
      <span class="rk mono">${c?.rank || (ctx ? 'sin rank' : '')}</span>
      <span class="od mono">${cuota(i === 0 ? e.g.p1 : e.g.p2)}</span>
      <span class="od mono">${e.s1 ? cuota(i === 0 ? e.s1.p1 : e.s1.p2) : '—'}</span>
      <span class="tray">${c?.llega || (ctx ? 'debuta' : '<span class="sin-ctx">sin cuadro (torneo no fotografiado)</span>')}</span>
    </div>`;
  }).join('');
  return `<article class="partido">
    <header>
      <span class="hora mono">${esc(horaCl(e.t))}</span>
      <span class="torneo">${catChip}${esc(e.torneo)}${esc(pais)}${ctx?.ronda ? ' · <span class="mono">' + esc(ctx.ronda) + '</span>' : ''}</span>
      ${e.bFix ? `<a class="abrir" href="https://lat.betano.com/cuotas-de-partido/e-e/${esc(e.bFix)}/" target="_blank" rel="noopener">Betano ↗</a>` : '<span class="abrir sin">sin link</span>'}
    </header>
    <div class="cab-cuotas"><span></span><span></span><span class="mono">Ganador</span><span class="mono">1er set</span><span></span></div>
    ${jug}
  </article>`;
}).filter(Boolean).join('\n');

const generado = new Date().toISOString();
const html = `<title>Mesa ITF</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@600;700&family=IBM+Plex+Sans:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500;600&display=swap">
<style>
:root{
  --papel:#F3F5F7; --carta:#FFFFFF; --tinta:#1A2732; --tinta2:#5A6B7A;
  --linea:#D9E0E6; --acento:#0F6B5C; --acento-suave:#E3EFEB; --alerta:#A33B2A; --ambar:#8A6116;
}
@media (prefers-color-scheme: dark){ :root:not([data-theme="light"]){
  --papel:#0F151B; --carta:#161F28; --tinta:#DAE4EC; --tinta2:#8FA1B0;
  --linea:#26313C; --acento:#3FB79E; --acento-suave:#15302B; --alerta:#E08A79; --ambar:#D9A94B;
}}
:root[data-theme="dark"]{
  --papel:#0F151B; --carta:#161F28; --tinta:#DAE4EC; --tinta2:#8FA1B0;
  --linea:#26313C; --acento:#3FB79E; --acento-suave:#15302B; --alerta:#E08A79; --ambar:#D9A94B;
}
*{box-sizing:border-box}
body{margin:0;background:var(--papel);color:var(--tinta);font:14.5px/1.5 "IBM Plex Sans",system-ui,sans-serif}
.envoltura{max-width:980px;margin:0 auto;padding:24px 16px 60px;display:flex;flex-direction:column;gap:14px}
.cabecera{display:flex;align-items:baseline;gap:14px;flex-wrap:wrap}
.cabecera h1{font-family:"Barlow Condensed",sans-serif;font-weight:700;font-size:34px;margin:0;letter-spacing:.5px}
.edad{font-size:13px;color:var(--tinta2)}
.edad b{font-variant-numeric:tabular-nums}
.edad.vieja b{color:var(--ambar)} .edad.rancia b{color:var(--alerta)}
button.recargar{margin-left:auto;font:600 14px "IBM Plex Sans",sans-serif;color:var(--acento);
  background:var(--acento-suave);border:1px solid transparent;border-radius:6px;padding:8px 16px;cursor:pointer}
button.recargar:hover{border-color:var(--acento)}
button.recargar:focus-visible{outline:2px solid var(--acento);outline-offset:2px}
.nota-cab{font-size:12.5px;color:var(--tinta2);margin:0}
.partido{background:var(--carta);border:1px solid var(--linea);border-radius:6px;padding:10px 14px 12px}
.partido header{display:flex;align-items:baseline;gap:12px;padding-bottom:6px;border-bottom:1px solid var(--linea)}
.hora{font-weight:600;font-size:13px;white-space:nowrap}
.torneo{font-size:13.5px;color:var(--tinta2)}
.chip{font-family:"IBM Plex Mono",monospace;font-size:11px;padding:1px 7px;border-radius:99px;
  background:var(--acento-suave);color:var(--acento)}
.abrir{margin-left:auto;color:var(--acento);font-size:13px;text-decoration:none;white-space:nowrap}
.abrir:hover,.abrir:focus-visible{text-decoration:underline}
.abrir.sin{color:var(--tinta2);opacity:.5}
.cab-cuotas,.linea-jug{display:grid;grid-template-columns:minmax(150px,220px) 82px 64px 64px 1fr;
  gap:10px;align-items:baseline}
.cab-cuotas{padding:6px 0 0;font-size:10.5px;color:var(--tinta2);text-transform:uppercase;letter-spacing:.8px}
.cab-cuotas .mono{text-align:right}
.linea-jug{padding:4px 0}
.nom{font-weight:500} .nom b{color:var(--acento);font-weight:600}
.rk{font-size:12px;color:var(--tinta2)}
.od{font-size:14px;font-weight:600;text-align:right;font-variant-numeric:tabular-nums}
.tray{font-family:"IBM Plex Mono",monospace;font-size:11.5px;color:var(--tinta2)}
.tray .g{color:var(--acento)} .tray .p{color:var(--alerta)} .tray .vs{color:var(--tinta);font-weight:600}
.sin-ctx{opacity:.55;font-style:italic}
.mono{font-family:"IBM Plex Mono",monospace;font-variant-numeric:tabular-nums}
.vacio{color:var(--tinta2);padding:30px;text-align:center}
footer{color:var(--tinta2);font-size:12px;border-top:1px solid var(--linea);padding-top:12px}
@media (max-width:640px){ .cab-cuotas,.linea-jug{grid-template-columns:1fr 58px 58px;grid-auto-flow:dense}
  .rk{grid-column:1} .tray{grid-column:1 / -1} .cab-cuotas span:first-child,.cab-cuotas span:nth-child(2){display:none} }
</style>
<div class="envoltura">
<div class="cabecera">
  <h1>Mesa ITF</h1>
  <span class="edad" id="edad" data-generado="${generado}">datos de hace <b>—</b></span>
  <button class="recargar" onclick="location.reload(true)">↻ Recargar</button>
</div>
<p class="nota-cab">Solo partidos por jugar con cuota de Betano (Ganador y Ganador 1er set). Hora de Chile. La rutina regenera cada 6 h; "Recargar" trae la última versión publicada. El panel completo queda en Vigía ITF.</p>
${filasHtml || '<p class="vacio">Sin partidos por jugar con cuotas ahora mismo. Recarga más tarde o pide un barrido.</p>'}
<footer>Generado ${generado.slice(0, 16).replace('T', ' ')} UTC · fuentes: Betano vía OddsPapi (cuotas y hora) + cuadros oficiales itftennis.com (contexto) · ${proximos.length} partidos listados${descartadosPorCuadro ? ` · ${descartadosPorCuadro} descartados por cuadro (ya jugados aunque el feed los tenía vivos)` : ''}.</footer>
</div>
<script>
(function(){
  var el = document.getElementById('edad');
  function pinta(){
    var min = Math.round((Date.now() - new Date(el.dataset.generado).getTime()) / 60000);
    el.innerHTML = 'datos de hace <b>' + (min < 60 ? min + ' min' : (min / 60).toFixed(1) + ' h') + '</b>';
    el.className = 'edad' + (min > 360 ? ' rancia' : min > 120 ? ' vieja' : '');
  }
  pinta(); setInterval(pinta, 60000);
})();
</script>`;

fs.writeFileSync(SALIDA, html);
console.log(`✓ ${SALIDA} (${(html.length / 1024).toFixed(0)} KB) · ${proximos.length} partidos por jugar · ${descartadosPorCuadro} descartados por cuadro`);
