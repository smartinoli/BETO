#!/usr/bin/env node
/* ============================================================
   ITF-TABLA — los partidos CON CUOTA, en crudo y en una tabla.

   La mesa (itf-proximos) muestra un veredicto; esta página muestra las
   variables que lo producen, sin decidir nada. Es para comparar y filtrar
   a mano: ordenar por cualquier columna, cortar por etapa, torneo, tipo,
   Δ mínima o cuota mínima, y ver si el criterio cuadra o no.

   Cada fila es un partido, orientada a NUESTRO favorito por WTN (el lado
   izquierdo siempre es el que el nivel señala), para que las columnas
   comparen lo mismo en todas las filas.

   Lee vigia/itf-proximos-datos.json, que deja la mesa. No scrapea.
   Uso:  node vigia/itf-tabla.mjs
   ============================================================ */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gamesCedidos, pMercadoModelo } from './itf-reglas.mjs';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const SALIDA = path.join(DIR, 'itf-tabla.html');
const datos = JSON.parse(fs.readFileSync(path.join(DIR, 'itf-proximos-datos.json'), 'utf8'));
const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const fmtDia = new Intl.DateTimeFormat('es-CL', { timeZone: 'America/Santiago', weekday: 'short', day: '2-digit', month: '2-digit' });
const fmtHora = new Intl.DateTimeFormat('es-CL', { timeZone: 'America/Santiago', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

/* solo lo que tiene precio: sin cuota no hay nada que comparar */
const filas = datos.partidos.filter(p => p.yo.gana || p.otro.gana).map(p => {
  const d = (p.yo.wtn != null && p.otro.wtn != null) ? Math.abs(p.yo.wtn - p.otro.wtn) : null;
  /* Las tres diferencias con el mismo signo: POSITIVO = ese ranking coincide
     con el WTN en señalar a nuestro favorito; negativo = lo contradice.
     En ranking, mejor es número más chico, de ahí la resta al revés. */
  const dAtp = (p.yo.atp != null && p.otro.atp != null) ? p.otro.atp - p.yo.atp : null;
  const dItf = (p.yo.itf != null && p.otro.itf != null) ? p.otro.itf - p.yo.itf : null;
  const pe = p.v.nivel?.p ?? null;
  const cA = p.yo.gana, cB = p.otro.gana;
  const devig = (cA && cB) ? (1 / cA) / ((1 / cA) + (1 / cB)) : (cA ? 1 / cA : null);
  const val = (pe && cA) ? pe * cA - 1 : null;
  const residuo = (devig != null && d != null) ? devig - pMercadoModelo(d) : null;
  const gA = gamesCedidos(p.yo.llega), gB = gamesCedidos(p.otro.llega);
  const flags = [];
  if (p.otro.jr || /JR/i.test(p.otro.marca || '')) flags.push('JR');
  if (p.otro.wtnVisible === false || p.yo.wtnVisible === false) flags.push('PZ');
  if (p.otro.atp == null) flags.push('sinATP');
  if (p.yo.atp != null && p.otro.atp != null && p.otro.atp < p.yo.atp - 400) flags.push('ATP≠');
  if (gA != null && gB != null && gB < gA) flags.push('choque');
  if (residuo != null && residuo < -0.15) flags.push('resid');
  const ini = p.inicio ? new Date(p.inicio) : null;
  /* "viene de": para ordenar hace falta un número, no el nombre de la ronda */
  const ORD = ['Q1', 'Q2', 'Q3', 'R1', 'R2', 'R3', 'QF', 'SF', 'F'];
  const ordPrev = x => x ? (x.campeon ? 99 : ORD.indexOf(x.etapa)) : -1;
  const prevA = ordPrev(p.yo.previo), prevB = ordPrev(p.otro.previo);
  return { ...p, d, dAtp, dItf, pe, cA, cB, devig, val, residuo, gA, gB, flags, prevA, prevB,
    cMin: p.v.nivel?.cMinima ?? null, ini,
    cuando: ini ? fmtDia.format(ini) + ' ' + fmtHora.format(ini) : (p.fecha ? p.fecha.slice(5) + ' ' + (p.horarioTxt || '') : '—'),
    orden: ini ? +ini : Number.MAX_SAFE_INTEGER };
}).sort((a, b) => a.orden - b.orden);

/* La entry list trae solo el año de nacimiento, así que la edad es
   aproximada: puede errar un año según el cumpleaños. */
const ANIO = new Date().getUTCFullYear();
const edad = n => n ? ANIO - n : null;
/* Un rival marcado JR era una incógnita: ahora la marca lleva su puesto
   en el ranking junior de la ITF cuando lo hay. Sólo lo traen los
   nacidos 2008-2009, que es justo cuando importa. */
const marcaConJr = l => l.jr && l.jrRank != null ? l.marca.replace(/\bJR\b/, 'JR ' + l.jrRank) : l.marca;
/* De qué torneo viene y hasta dónde llegó ahí. "campeón" cuando ganó la
   final; si no, la ronda donde se quedó. */
function vieneDe(l) {
  const v = l.previo;
  if (!v) return '<i>—</i>';
  const t = String(v.torneo || '').replace(/^M\d+\s/, '').trim();
  return `<span class="prev"><b>${v.campeon ? 'campeón' : esc(v.etapa)}</b> ${esc(t)}` +
    `<i>${v.ganados}/${v.jugados}</i></span>`;
}
const pct = v => v == null ? '' : (v * 100).toFixed(0);
const n2 = v => v == null ? '' : (+v).toFixed(2);
const TIPO = { segura: 'segura', anomalia: 'anomalía', mirar: 'mirar', pasar: 'pasar', 'sin-precio': 'sin precio' };
const torneos = [...new Set(filas.map(f => f.torneo))].sort();
const etapas = [...new Set(filas.map(f => f.etapa))].sort();

const cuerpo = filas.map(f => `<tr data-tipo="${esc(f.v.tipo)}" data-etapa="${esc(f.etapa)}" data-torneo="${esc(f.torneo)}"
  data-d="${f.d ?? ''}" data-cuota="${f.cA ?? ''}" data-val="${f.val ?? ''}"
  data-datp="${f.dAtp ?? ''}" data-ditf="${f.dItf ?? ''}">
  <td class="c-txt">${esc(f.cuando)}</td>
  <td class="c-txt">${esc(f.torneo.replace(/^M\d+\s/, ''))}<i>${esc(f.categoria)}·${esc(f.superficie || '')}</i></td>
  <td class="c-et">${esc(f.etapa)}</td>
  <td class="c-nom">${esc(f.yo.nombre)}${f.yo.marca ? `<b>${esc(marcaConJr(f.yo))}</b>` : ''}
    <i class="tray">${f.yo.llegaHtml || 'debuta'}</i></td>
  <td class="n">${f.yo.atp ?? '<i>—</i>'}</td>
  <td class="n">${f.yo.itf ?? '<i>—</i>'}</td>
  <td class="n">${f.yo.nac ?? '<i>—</i>'}</td>
  <td class="n">${edad(f.yo.nacido) ?? '<i>—</i>'}</td>
  <td class="n">${f.yo.wtn ?? '<i>—</i>'}</td>
  <td class="n dst">${n2(f.cA)}</td>
  <td class="n">${f.gA == null ? '' : pct(f.gA)}</td>
  <td class="c-prev">${vieneDe(f.yo)}</td>
  <td class="c-nom sec">${esc(f.otro.nombre)}${f.otro.marca ? `<b>${esc(marcaConJr(f.otro))}</b>` : ''}
    <i class="tray">${f.otro.llegaHtml || 'debuta'}</i></td>
  <td class="n sec">${f.otro.atp ?? '<i>—</i>'}</td>
  <td class="n sec">${f.otro.itf ?? '<i>—</i>'}</td>
  <td class="n sec">${f.otro.nac ?? '<i>—</i>'}</td>
  <td class="n sec">${edad(f.otro.nacido) ?? '<i>—</i>'}</td>
  <td class="n sec">${f.otro.wtn ?? '<i>—</i>'}</td>
  <td class="n sec">${n2(f.cB)}</td>
  <td class="n sec">${f.gB == null ? '' : pct(f.gB)}</td>
  <td class="c-prev sec">${vieneDe(f.otro)}</td>
  <td class="n dst">${f.d == null ? '' : f.d.toFixed(2)}</td>
  <td class="n ${f.dAtp == null ? '' : f.dAtp > 0 ? 'pos' : 'neg'}">${f.dAtp == null ? '' : (f.dAtp > 0 ? '+' : '') + f.dAtp}</td>
  <td class="n ${f.dItf == null ? '' : f.dItf > 0 ? 'pos' : 'neg'}">${f.dItf == null ? '' : (f.dItf > 0 ? '+' : '') + f.dItf}</td>
  <td class="n">${pct(f.pe)}</td>
  <td class="n">${pct(f.devig)}</td>
  <td class="n">${n2(f.cMin)}</td>
  <td class="n ${f.val == null ? '' : f.val > 0.09 ? 'pos' : f.val > 0 ? 'tibio' : 'neg'}">${f.val == null ? '' : (f.val > 0 ? '+' : '') + pct(f.val)}</td>
  <td class="n ${f.residuo != null && f.residuo < -0.15 ? 'neg' : ''}">${f.residuo == null ? '' : (f.residuo > 0 ? '+' : '') + pct(f.residuo)}</td>
  <td class="c-fl">${f.flags.map(x => `<span class="fl">${esc(x)}</span>`).join('')}</td>
  <td class="c-tp t-${esc(f.v.tipo)}">${TIPO[f.v.tipo] || f.v.tipo}</td>
</tr>`).join('');

const html = `<title>Tabla ITF</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=IBM+Plex+Sans:wght@400;500;600&display=swap">
<style>
:root{--papel:#F3F5F7;--carta:#FFF;--tinta:#1A2732;--tinta2:#5A6B7A;--tinta3:#93A3B0;--linea:#DDE4EA;
  --acento:#0F6B5C;--acento-suave:#E3EFEB;--alerta:#A33B2A;--ambar:#8A6116;--ambar-suave:#F6EEDC;--franja:#F8FAFB;--realce:#EAF1F5}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--papel:#0F151B;--carta:#151E26;
  --tinta:#DAE4EC;--tinta2:#8FA1B0;--tinta3:#63737F;--linea:#26313C;--acento:#3FB79E;--acento-suave:#15302B;
  --alerta:#E08A79;--ambar:#D9A94B;--ambar-suave:#2A2415;--franja:#121A21;--realce:#1B252E}}
:root[data-theme="dark"]{--papel:#0F151B;--carta:#151E26;--tinta:#DAE4EC;--tinta2:#8FA1B0;--tinta3:#63737F;
  --linea:#26313C;--acento:#3FB79E;--acento-suave:#15302B;--alerta:#E08A79;--ambar:#D9A94B;--ambar-suave:#2A2415;--franja:#121A21;--realce:#1B252E}
*{box-sizing:border-box}
body{margin:0;background:var(--papel);color:var(--tinta);font:13px/1.35 "IBM Plex Sans",system-ui,sans-serif}
.env{padding:14px 12px 40px}
h1{font-size:17px;margin:0 0 2px;font-weight:600;letter-spacing:.2px}
.gen{font-size:11.5px;color:var(--tinta2)}
.barra{display:flex;gap:14px;flex-wrap:wrap;align-items:flex-end;margin:12px 0 8px;
  padding:10px 12px;background:var(--carta);border:1px solid var(--linea);border-radius:6px}
.grupo{display:flex;flex-direction:column;gap:3px}
.grupo label{font-size:10px;text-transform:uppercase;letter-spacing:.7px;color:var(--tinta2);font-weight:600}
select,input[type=number]{font:500 12px "IBM Plex Mono",monospace;color:var(--tinta);background:var(--papel);
  border:1px solid var(--linea);border-radius:4px;padding:4px 6px;min-width:110px}
input[type=number]{min-width:66px}
select:focus,input:focus{outline:2px solid var(--acento);outline-offset:1px}
.cuenta{margin-left:auto;font:600 12px "IBM Plex Mono",monospace;color:var(--tinta2)}
.cuenta b{color:var(--tinta);font-size:15px}
.env-tabla{overflow:auto;max-height:calc(100vh - 190px);background:var(--carta);border:1px solid var(--linea);border-radius:6px}
table{border-collapse:separate;border-spacing:0;width:100%;font-family:"IBM Plex Mono",monospace;font-size:12px}
thead th{position:sticky;top:0;z-index:2;background:var(--carta);border-bottom:2px solid var(--linea);
  font:600 10px "IBM Plex Sans",sans-serif;text-transform:uppercase;letter-spacing:.6px;color:var(--tinta2);
  padding:7px 6px;text-align:left;white-space:nowrap;cursor:pointer;user-select:none}
thead th:hover{color:var(--acento)}
thead th.n{text-align:right}
thead th .fl-ord{color:var(--acento);font-size:9px}
tbody td{padding:5px 6px;border-bottom:1px solid var(--linea);white-space:nowrap;vertical-align:baseline;
  font-variant-numeric:tabular-nums}
tbody tr:hover td{background:var(--realce)}
td.n{text-align:right}
.c-prev{white-space:nowrap;font-size:12px}
.c-prev .prev b{font-weight:600;color:var(--tinta)}
.c-prev .prev i{font-style:normal;color:var(--tinta3);margin-left:5px;font-family:"IBM Plex Mono",monospace;font-size:11px}
.c-prev.sec .prev b{color:var(--tinta2)}
td.sec{color:var(--tinta2)}
td.c-nom{font-family:"IBM Plex Sans",sans-serif;font-weight:500;max-width:190px;overflow:hidden;text-overflow:ellipsis}
td.c-nom b{color:var(--acento);font-weight:600;margin-left:4px}
td.c-nom .tray{display:block;font-family:"IBM Plex Mono",monospace;font-size:10px;font-style:normal;
  color:var(--tinta3);margin-top:2px;white-space:normal;line-height:1.35}
td.c-nom .tray .g{color:var(--acento);font-weight:600}
td.c-nom .tray .p{color:var(--alerta);font-weight:600}
td.c-nom .tray .vs{color:var(--tinta2)}
td.c-nom{max-width:250px;white-space:normal}
td.c-txt{font-family:"IBM Plex Sans",sans-serif;color:var(--tinta2);font-size:11.5px}
td.c-txt i{display:block;font-style:normal;color:var(--tinta3);font-size:10px}
td.c-et{color:var(--tinta2);font-weight:600}
td i{font-style:normal;color:var(--tinta3)}
td.dst{font-weight:600;color:var(--tinta)}
td.pos{color:var(--acento);font-weight:600} td.tibio{color:var(--ambar)} td.neg{color:var(--alerta)}
.fl{display:inline-block;font-size:9.5px;padding:1px 5px;border-radius:3px;margin-right:3px;
  background:var(--ambar-suave);color:var(--ambar);font-weight:600}
td.c-tp{font-family:"IBM Plex Sans",sans-serif;font-size:10.5px;font-weight:600;text-transform:uppercase;letter-spacing:.4px}
.t-segura{color:var(--acento)} .t-anomalia{color:var(--ambar)} .t-mirar{color:var(--tinta2)} .t-pasar{color:var(--tinta3)}
.grupos{border-left:2px solid var(--linea);padding-left:14px;margin-left:2px}
.pie{margin-top:10px;font-size:11px;color:var(--tinta2);line-height:1.6;max-width:130ch}
.pie code{font-family:"IBM Plex Mono",monospace;color:var(--tinta)}
.vacio{padding:30px;text-align:center;color:var(--tinta2)}
</style>
<div class="env">
<h1>Tabla ITF</h1>
<div class="gen">${filas.length} partidos con cuota · generado ${esc(datos.generado.slice(0, 16).replace('T', ' '))} UTC · cada fila orientada a nuestro favorito por WTN</div>

<div class="barra">
  <div class="grupo"><label>tipo</label><select id="f-tipo"><option value="">todos</option>
    ${Object.entries(TIPO).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select></div>
  <div class="grupo"><label>etapa</label><select id="f-etapa"><option value="">todas</option>
    ${etapas.map(e => `<option>${esc(e)}</option>`).join('')}</select></div>
  <div class="grupo"><label>torneo</label><select id="f-torneo"><option value="">todos</option>
    ${torneos.map(t => `<option>${esc(t)}</option>`).join('')}</select></div>
  <div class="grupos" style="display:flex;gap:12px">
    <div class="grupo"><label>Δ wtn mín</label><input type="number" id="f-d" step="0.5" placeholder="0"></div>
    <div class="grupo"><label>cuota mín</label><input type="number" id="f-cuota" step="0.1" placeholder="1.00"></div>
    <div class="grupo"><label>cuota máx</label><input type="number" id="f-cuotaMax" step="0.1" placeholder="99"></div>
    <div class="grupo"><label>valor mín %</label><input type="number" id="f-val" step="5" placeholder="—"></div>
    <div class="grupo"><label>rankings</label><select id="f-rank"><option value="">todos</option>
      <option value="acuerdo">ATP e ITF de acuerdo</option>
      <option value="atpContra">ATP en contra</option>
      <option value="itfContra">ITF en contra</option></select></div>
  </div>
  <div class="cuenta"><b id="visibles">${filas.length}</b> / ${filas.length}</div>
</div>

${filas.length ? `<div class="env-tabla"><table id="t">
  <thead><tr>
    <th data-k="orden">Cuándo</th><th data-k="torneo">Torneo</th><th data-k="etapa">Et</th>
    <th data-k="nomA">Favorito por WTN · cómo llega</th><th class="n" data-k="atpA">ATP</th><th class="n" data-k="itfA">ITF</th><th class="n" data-k="nacA">País</th><th class="n" data-k="edadA">Años</th><th class="n" data-k="wtnA">WTN</th>
    <th class="n" data-k="cuota">Cuota</th><th class="n" data-k="gA">Ced%</th><th data-k="prevA">Viene de</th>
    <th data-k="nomB">Rival · cómo llega</th><th class="n" data-k="atpB">ATP</th><th class="n" data-k="itfB">ITF</th><th class="n" data-k="nacB">País</th><th class="n" data-k="edadB">Años</th><th class="n" data-k="wtnB">WTN</th>
    <th class="n" data-k="cB">Cuota</th><th class="n" data-k="gB">Ced%</th><th data-k="prevB">Viene de</th>
    <th class="n" data-k="d">Δ WTN</th><th class="n" data-k="dAtp">Δ ATP</th><th class="n" data-k="dItf">Δ ITF</th><th class="n" data-k="pe">Curva</th><th class="n" data-k="devig">Mercado</th>
    <th class="n" data-k="cMin">Mín</th><th class="n" data-k="val">Valor</th><th class="n" data-k="residuo">Resid</th>
    <th data-k="flags">Señales</th><th data-k="tipo">Tipo</th>
  </tr></thead>
  <tbody>${cuerpo}</tbody>
</table></div>` : '<p class="vacio">Ningún partido por jugar tiene cuota todavía.</p>'}

<p class="pie">
<b>Ced%</b> = games cedidos en el torneo, la dominancia de la forma (menos es mejor) ·
<b>Curva</b> = nuestra probabilidad para el favorito: una logística en Δ WTN con un nivel propio por grupo de rondas
(<i>Q1</i> · <i>buenas</i> = Q2 y R1 · <i>medias</i> = Q3 y R2 · <i>finales</i> = QF, SF y F), ajustada sobre 902 partidos ·
<b>Mercado</b> = la que implica la cuota, sin el margen de la casa ·
<b>Mín</b> = cuota desde la que la apuesta deja +9% sobre ese margen ·
<b>Valor</b> = curva × cuota − 1 ·
<b>Resid</b> = cuánto se aparta el mercado de su propio modelo por Δ (logit p = −0.081 + 0.183·Δ). Muy negativo = ve algo que no vemos.<br>
<b>País</b> = ranking nacional · <b>Años</b> = edad aproximada, la entry list solo da el año de nacimiento.<br>
<b>Δ ATP</b> y <b>Δ ITF</b> = puestos de ventaja de nuestro favorito en cada ranking. <b>Positivo</b> = ese ranking coincide con el WTN; <b>negativo</b> = lo contradice.
<b>Viene de</b> = el torneo anterior de ese jugador y hasta qué ronda llegó ahí, con partidos ganados sobre jugados.
Sale de cruzar todos los cuadros en disco por identificador de jugador de la ITF, así que no depende de cómo se escriba el nombre;
cuando dice <i>—</i> es que ese jugador no aparece en ningún torneo que hayamos bajado, no que no haya jugado.<br>
<b>JR 93</b> junto al nombre = puesto en el ranking junior de la ITF. Sólo lo traen los nacidos 2008-2009.<br>
<b>Cómo llega</b>: cada tramo es <code>ronda ✓/✗ marcador v(marca del rival)</code> — verde ganó, rojo perdió, y la marca dice si el rival era sembrado <code>[4]</code>, clasificado <code>Q</code>, junior <code>JR</code> o invitado <code>WC</code>.<br>
Señales: <code>JR</code> rival junior (ahí el WTN se da vuelta: 31%) · <code>sinATP</code> rival sin ranking (buena señal: 81% contra 75%) ·
<code>ATP≠</code> el ATP contradice al WTN por +400 puestos · <code>choque</code> el rival llega con mejor forma ·
<code>resid</code> el mercado se aparta más de 15 puntos · <code>PZ</code> ITF no publica ese WTN.<br>
Clic en cualquier encabezado para ordenar. Los filtros se combinan.
</p>
</div>
<script>
(function(){
  var tb = document.querySelector('#t tbody'); if (!tb) return;
  var filas = [].slice.call(tb.rows);
  var F = { tipo:'f-tipo', etapa:'f-etapa', torneo:'f-torneo' };
  var N = { d:'f-d', cuota:'f-cuota', val:'f-val' };
  function pinta(){
    var vis = 0;
    var dMin = parseFloat(document.getElementById('f-d').value);
    var cMin = parseFloat(document.getElementById('f-cuota').value);
    var cMax = parseFloat(document.getElementById('f-cuotaMax').value);
    var vMin = parseFloat(document.getElementById('f-val').value);
    filas.forEach(function(r){
      var ok = true;
      for (var k in F) { var v = document.getElementById(F[k]).value; if (v && r.dataset[k] !== v) ok = false; }
      var d = parseFloat(r.dataset.d), c = parseFloat(r.dataset.cuota), val = parseFloat(r.dataset.val) * 100;
      if (!isNaN(dMin) && !(d >= dMin)) ok = false;
      if (!isNaN(cMin) && !(c >= cMin)) ok = false;
      if (!isNaN(cMax) && !(c <= cMax)) ok = false;
      if (!isNaN(vMin) && !(val >= vMin)) ok = false;
      var rk = document.getElementById('f-rank').value;
      if (rk) {
        var da = parseFloat(r.dataset.datp), di = parseFloat(r.dataset.ditf);
        if (rk === 'acuerdo' && !(da > 0 && di > 0)) ok = false;
        if (rk === 'atpContra' && !(da < 0)) ok = false;
        if (rk === 'itfContra' && !(di < 0)) ok = false;
      }
      r.hidden = !ok; if (ok) vis++;
    });
    document.getElementById('visibles').textContent = vis;
  }
  Object.keys(F).forEach(function(k){ document.getElementById(F[k]).onchange = pinta; });
  document.getElementById('f-rank').onchange = pinta;
  ['f-d','f-cuota','f-cuotaMax','f-val'].forEach(function(id){ document.getElementById(id).oninput = pinta; });

  /* orden: numérico si toda la columna lo es, texto si no */
  var ultimo = null, asc = true;
  [].forEach.call(document.querySelectorAll('#t thead th'), function(th, i){
    th.onclick = function(){
      asc = (ultimo === i) ? !asc : true; ultimo = i;
      [].forEach.call(document.querySelectorAll('#t thead th'), function(o){
        var f = o.querySelector('.fl-ord'); if (f) f.remove();
      });
      th.insertAdjacentHTML('beforeend', ' <span class="fl-ord">' + (asc ? '▲' : '▼') + '</span>');
      var val = function(r){
        var t = r.cells[i].textContent.trim().replace('%','').replace('+','');
        var n = parseFloat(t);
        return (t !== '' && !isNaN(n)) ? n : t.toLowerCase();
      };
      filas.sort(function(a, b){
        var x = val(a), y = val(b);
        if (x === '' && y !== '') return 1;
        if (y === '' && x !== '') return -1;
        return (x < y ? -1 : x > y ? 1 : 0) * (asc ? 1 : -1);
      });
      filas.forEach(function(r){ tb.appendChild(r); });
    };
  });
})();
</script>`;

fs.writeFileSync(SALIDA, html);
console.log(`✓ ${SALIDA} (${(html.length / 1024).toFixed(0)} KB) · ${filas.length} partidos con cuota`);
