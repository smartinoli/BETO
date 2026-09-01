#!/usr/bin/env node
/* ============================================================
   ITF-TABLA — la tabla plana, ordenable y filtrable.

   Pedida por Sebastián el 2026-09-01: "ya no me sirve ni visual ni de
   formato como lo tenemos ahora, mucho y muy confuso. Hagamos una nueva
   página donde esté la tabla simple, todos los jugadores encontrados en
   las cuotas, con su cuota, % modelo, rival, torneo, link a Betano,
   edad, WTN, ranking ITF, ranking ATP, si es jr, si es local — y cada
   una de esas columnas poder ordenarla y también filtrar."

   No calcula nada: lee itf-tabla.json, que sale del mismo análisis del
   informe. Una fila por JUGADOR (los dos lados de cada partido), así se
   puede ordenar por cuota o por probabilidad sin pensar en "lados".

   Uso:  node vigia/itf-tabla.mjs   → vigia/itf-tabla.html
   ============================================================ */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const datos = JSON.parse(fs.readFileSync(path.join(DIR, 'itf-tabla.json'), 'utf8'));
const J = datos.jugadores || [];
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
/* Búsqueda en Betano por el nombre del jugador: es un enlace, nada más
   — no se consulta ni se scrapea el sitio desde acá. */
const betano = n => 'https://www.betano.cl/search/?query=' + encodeURIComponent(n);
const hhmm = s => { if (!s) return ''; const d = new Date(s); return isNaN(d) ? '' : d.toISOString().slice(11, 16) };

const COLS = [
  { k: 'jugador', t: 'jugador', tipo: 'txt' },
  { k: 'cuota', t: 'cuota', tipo: 'num' },
  { k: 'prob', t: '% modelo', tipo: 'num' },
  { k: 'rival', t: 'rival', tipo: 'txt' },
  { k: 'torneo', t: 'torneo', tipo: 'txt' },
  { k: 'etapa', t: 'ronda', tipo: 'txt' },
  { k: 'edad', t: 'edad', tipo: 'num' },
  { k: 'wtn', t: 'WTN', tipo: 'num' },
  { k: 'itf', t: 'ITF', tipo: 'num' },
  { k: 'atp', t: 'ATP', tipo: 'num' },
  { k: 'jr', t: 'jr', tipo: 'bool' },
  { k: 'local', t: 'local', tipo: 'bool' },
];

const filas = J.map(j => `<tr${j.jugable ? ' class="ju"' : ''}
  data-jugador="${esc(j.jugador.toLowerCase())}" data-cuota="${j.cuota ?? ''}" data-prob="${j.prob ?? ''}"
  data-rival="${esc(String(j.rival).toLowerCase())}" data-torneo="${esc(j.torneo.toLowerCase())}"
  data-etapa="${esc(j.etapa || '')}" data-edad="${j.edad ?? ''}" data-wtn="${j.wtn ?? ''}"
  data-itf="${j.itf ?? ''}" data-atp="${j.atp ?? ''}" data-jr="${j.jr ? 1 : 0}" data-local="${j.local ? 1 : 0}">
  <td class="nom"><a href="${betano(j.jugador)}" target="_blank" rel="noopener">${esc(j.jugador)}</a>${j.jugable ? ' <b class="est" title="pisa la casilla del manual">★</b>' : ''}</td>
  <td class="n cuota">${j.cuota ?? '—'}</td>
  <td class="n">${(() => { const pc = j.prob != null ? Math.round(j.prob * 100) : null;
    return `<span class="pb ${pc >= 80 ? 'alta' : pc >= 70 ? 'media' : ''}">${pc != null ? pc + '%' : '—'}</span>` })()}</td>
  <td class="sec">${esc(j.rival)} <span class="cq">${j.cuotaRival ?? ''}</span></td>
  <td class="sec">${esc(j.torneo)}${j.pais ? ' <span class="cq">' + esc(j.pais) + '</span>' : ''}</td>
  <td class="sec">${esc(j.etapa || '')}<span class="cq"> ${hhmm(j.inicio)}</span></td>
  <td class="n">${j.edad ?? '—'}</td>
  <td class="n">${j.wtn ?? '—'}</td>
  <td class="n sec">${j.itf ?? '—'}</td>
  <td class="n sec">${j.atp ?? '—'}</td>
  <td class="n">${j.jr ? 'sí' : ''}</td>
  <td class="n">${j.local ? 'sí' : ''}</td>
</tr>`).join('\n');

const html = `<title>Tabla ITF</title>
<style>
:root{--ground:#F5F7F8;--panel:#FFF;--sunk:#EDF1F3;--ink:#141F28;--ink2:#54687A;--ink3:#8496A5;
  --rule:#DBE3E8;--accent:#1B5B70;--pos:#2C7A58;--pos-soft:#DEEDE5;--ojo:#856512;--ojo-soft:#F6EEDC}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--ground:#0D1319;--panel:#141C24;
  --sunk:#111920;--ink:#DDE6ED;--ink2:#93A5B4;--ink3:#647686;--rule:#222E39;--accent:#5BA9BF;
  --pos:#57B98A;--pos-soft:#142C22;--ojo:#CFA23F;--ojo-soft:#2A2415}}
:root[data-theme="dark"]{--ground:#0D1319;--panel:#141C24;--sunk:#111920;--ink:#DDE6ED;--ink2:#93A5B4;
  --ink3:#647686;--rule:#222E39;--accent:#5BA9BF;--pos:#57B98A;--pos-soft:#142C22;--ojo:#CFA23F;--ojo-soft:#2A2415}
*{box-sizing:border-box}
body{margin:0;background:var(--ground);color:var(--ink);font:400 15px/1.5 system-ui,-apple-system,sans-serif}
.env{max-width:1500px;margin:0 auto;padding:20px 16px 60px}
h1{font-size:21px;margin:0 0 2px} .sub{color:var(--ink3);font-size:13px;margin:0 0 16px}
.barra{display:flex;flex-wrap:wrap;gap:8px 14px;align-items:center;background:var(--panel);
  border:1px solid var(--rule);border-radius:10px;padding:10px 12px;margin-bottom:12px}
.barra label{font:600 11px system-ui;color:var(--ink3);text-transform:uppercase;letter-spacing:.04em}
.barra input[type=text]{font:400 13px system-ui;padding:5px 9px;border:1px solid var(--rule);
  border-radius:7px;background:var(--sunk);color:var(--ink);min-width:150px}
.barra input[type=number]{width:66px;font:400 13px system-ui;padding:5px 7px;border:1px solid var(--rule);
  border-radius:7px;background:var(--sunk);color:var(--ink)}
.barra button{font:500 12px system-ui;padding:4px 10px;border-radius:7px;border:1px solid var(--rule);
  background:transparent;color:var(--ink2);cursor:pointer}
.barra button.on{background:var(--accent);border-color:var(--accent);color:var(--panel)}
#cuenta{margin-left:auto;color:var(--ink3);font:500 12px system-ui}
.caja{background:var(--panel);border:1px solid var(--rule);border-radius:10px;overflow-x:auto}
table{border-collapse:collapse;width:100%;font-size:13.5px}
th{position:sticky;top:0;background:var(--sunk);text-align:left;font:600 11px system-ui;
  color:var(--ink2);text-transform:uppercase;letter-spacing:.04em;padding:9px 10px;
  border-bottom:1px solid var(--rule);cursor:pointer;white-space:nowrap;user-select:none}
th:hover{color:var(--ink)} th .fl{color:var(--accent);font-size:10px}
td{padding:8px 10px;border-bottom:1px solid var(--rule);vertical-align:top}
tr:hover td{background:var(--sunk)}
.n{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
.nom a{color:var(--ink);font-weight:600;text-decoration:none;border-bottom:1px dotted var(--ink3)}
.nom a:hover{color:var(--accent);border-color:var(--accent)}
.sec{color:var(--ink2)} .cq{color:var(--ink3);font-size:11.5px}
.cuota{font-weight:600}
.pb{padding:1px 6px;border-radius:8px;font-weight:600}
.pb.alta{background:var(--pos-soft);color:var(--pos)}
.pb.media{background:var(--ojo-soft);color:var(--ojo)}
tr.ju td:first-child{box-shadow:inset 3px 0 0 var(--pos)}
.est{color:var(--pos)}
tr[hidden]{display:none}
.pie{color:var(--ink3);font-size:12px;margin-top:14px;line-height:1.6}
</style>
<div class="env">
<h1>Tabla ITF — todos los jugadores cotizados</h1>
<p class="sub">${J.length} jugadores · ${new Set(J.map(j => j.torneo)).size} torneos · armada ${new Date().toISOString().slice(11, 16)} UTC.
  Clic en cualquier encabezado para ordenar; el nombre abre la búsqueda en Betano. La ★ y el borde verde marcan lo que pisa la casilla del manual.
  <a href="./index.html" style="color:var(--accent)">Ver el análisis completo →</a></p>

<div class="barra">
  <label>buscar</label><input type="text" id="q" placeholder="jugador, rival o torneo">
  <label>cuota</label><input type="number" id="cmin" step="0.01" placeholder="min"><input type="number" id="cmax" step="0.01" placeholder="max">
  <label>% modelo</label><input type="number" id="pmin" placeholder="min"><input type="number" id="pmax" placeholder="max">
  <label>edad</label><input type="number" id="emin" placeholder="min"><input type="number" id="emax" placeholder="max">
  <label>WTN</label><input type="number" id="wmin" step="0.1" placeholder="min"><input type="number" id="wmax" step="0.1" placeholder="max">
  <button data-f="jr">junior</button>
  <button data-f="local">local</button>
  <button data-f="ju">jugables ★</button>
  <button id="limpiar">limpiar</button>
  <span id="cuenta"></span>
</div>

<div class="caja"><table id="t">
<thead><tr>${COLS.map(c => `<th data-k="${c.k}" data-tipo="${c.tipo}">${c.t} <span class="fl"></span></th>`).join('')}</tr></thead>
<tbody>
${filas}
</tbody></table></div>

<p class="pie"><b>Qué es cada cosa.</b> <b>% modelo</b> es lo que nuestro modelo le da a ESE jugador (los dos lados suman 100).
  Verde desde 80%, ámbar entre 70 y 79 — y ojo, medido sobre 899 partidos jugados esa banda de 80 promete 85% y cumple 79%,
  así que a cuotas bajo 1.30 el margen se come solo. <b>WTN</b> es el rating de la ITF (más bajo es mejor);
  la ITF lo recalibró entre el 25 y el 28 de agosto, así que no se comparan números de torneos con listas de semanas distintas.
  <b>local</b> es que juega en su país, lo que vale ~0.5 puntos de WTN. Los rankings ITF y ATP van vacíos cuando el jugador no tiene.</p>
</div>
<script>
(() => {
  const tb = document.querySelector('#t tbody');
  const filas = [...tb.rows];
  const S = { jr:false, local:false, ju:false };
  const val = (tr,k) => tr.dataset[k];
  const num = v => { const x = parseFloat(v); return isNaN(x) ? null : x };
  const g = id => document.getElementById(id);
  const rango = (v,a,b) => { const x = num(v); if (a!=null && (x==null||x<a)) return false;
    if (b!=null && (x==null||x>b)) return false; return true };
  function aplica(){
    const q = g('q').value.trim().toLowerCase();
    const cmin=num(g('cmin').value), cmax=num(g('cmax').value);
    const pmin=num(g('pmin').value), pmax=num(g('pmax').value);
    const emin=num(g('emin').value), emax=num(g('emax').value);
    const wmin=num(g('wmin').value), wmax=num(g('wmax').value);
    let v=0;
    for (const tr of filas){
      const ok = (!q || val(tr,'jugador').includes(q) || val(tr,'rival').includes(q) || val(tr,'torneo').includes(q))
        && rango(val(tr,'cuota'),cmin,cmax)
        && rango(String(Math.round((num(val(tr,'prob'))||0)*100)),pmin,pmax)
        && rango(val(tr,'edad'),emin,emax)
        && rango(val(tr,'wtn'),wmin,wmax)
        && (!S.jr || val(tr,'jr')==='1')
        && (!S.local || val(tr,'local')==='1')
        && (!S.ju || tr.classList.contains('ju'));
      tr.hidden = !ok; if (ok) v++;
    }
    g('cuenta').textContent = v === filas.length ? filas.length+' jugadores' : 'mostrando '+v+' de '+filas.length;
  }
  /* ordenar: primer clic ascendente, segundo descendente. Los vacíos van
     siempre al final, en los dos sentidos: un jugador sin ranking ATP no
     es "el mejor" ni "el peor", simplemente no tiene. */
  let ultK=null, asc=true;
  for (const th of document.querySelectorAll('#t th')) th.addEventListener('click', () => {
    const k = th.dataset.k, tipo = th.dataset.tipo;
    asc = (k === ultK) ? !asc : true; ultK = k;
    for (const o of document.querySelectorAll('#t th .fl')) o.textContent='';
    th.querySelector('.fl').textContent = asc ? '▲' : '▼';
    const orden = [...filas].sort((x,y) => {
      const a = val(x,k) ?? '', b = val(y,k) ?? '';
      if (tipo === 'txt') return asc ? a.localeCompare(b) : b.localeCompare(a);
      const na = num(a), nb = num(b);
      if (na === null && nb === null) return 0;
      if (na === null) return 1;                 /* vacío al final siempre */
      if (nb === null) return -1;
      return asc ? na - nb : nb - na;
    });
    for (const tr of orden) tb.appendChild(tr);
  });
  for (const b of document.querySelectorAll('.barra button[data-f]')) b.addEventListener('click', () => {
    S[b.dataset.f] = !S[b.dataset.f]; b.classList.toggle('on', S[b.dataset.f]); aplica();
  });
  for (const id of ['q','cmin','cmax','pmin','pmax','emin','emax','wmin','wmax'])
    g(id).addEventListener('input', aplica);
  g('limpiar').addEventListener('click', () => {
    for (const id of ['q','cmin','cmax','pmin','pmax','emin','emax','wmin','wmax']) g(id).value='';
    for (const k in S) S[k]=false;
    for (const b of document.querySelectorAll('.barra button[data-f]')) b.classList.remove('on');
    aplica();
  });
  aplica();
})();
</script>`;

fs.writeFileSync(path.join(DIR, 'itf-tabla.html'), html);
console.log(`✓ vigia/itf-tabla.html (${J.length} jugadores)`);
