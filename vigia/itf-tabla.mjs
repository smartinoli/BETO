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
const M = await import('./itf-modelo.mjs');
const O = M.MODELO_ORIGEN;
const J = datos.jugadores || [];
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
/* Búsqueda en Betano LatAm por el nombre del jugador. Es un enlace y
   nada más: no se consulta ni se scrapea el sitio desde acá. La API de
   cuotas NO devuelve la URL del partido en cada casa (revisado el
   2026-09-01: el caché no trae ningún campo de link), así que lo honesto
   es abrir su buscador con el nombre, no inventar una URL de evento. */
const betano = n => 'https://lat.betano.com/search/?query=' + encodeURIComponent(n);
const hhmm = s => { if (!s) return ''; const d = new Date(s); return isNaN(d) ? '' : d.toISOString().slice(11, 16) };
/* "(4)" sembrado cuarto · "(Q)" salió de la clasificación · "(WC)"
   invitación de la organización · LL lucky loser, PR ranking protegido,
   A alternate, SE exento. Se junta en un solo paréntesis: "(4, WC)". */
const MOTE = { Q: 'Q', WC: 'WC', LL: 'LL', PR: 'PR', A: 'Alt', SE: 'SE', JR: 'JR' };
const marca = (seed, entrada) => {
  const p = [seed != null ? seed : null, entrada ? (MOTE[entrada] || entrada) : null].filter(x => x != null);
  return p.length ? ` (${p.join(', ')})` : '';
};

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
  <td class="nom"><a href="${betano(j.jugador)}" target="_blank" rel="noopener">${esc(j.jugador)}</a><span class="mk">${esc(marca(j.seed, j.entrada))}</span>${j.jugable ? ' <b class="est" title="pisa la casilla del manual">★</b>' : ''}</td>
  <td class="n cuota">${j.cuota ?? '—'}</td>
  <td class="n">${(() => { const pc = j.prob != null ? Math.round(j.prob * 100) : null;
    return `<span class="pb ${pc >= 80 ? 'alta' : pc >= 70 ? 'media' : ''}">${pc != null ? pc + '%' : '—'}</span>` })()}</td>
  <td class="sec">${esc(j.rival)}<span class="mk">${esc(marca(j.seedRival, j.entradaRival))}</span> <span class="cq">${j.cuotaRival ?? ''}</span></td>
  <td class="sec">${esc(j.torneo)}${j.pais ? ' <span class="cq">' + esc(j.pais) + '</span>' : ''}</td>
  <td class="sec">${esc(j.etapa || '')}<span class="cq"> ${hhmm(j.inicio)}</span></td>
  <td class="n">${j.edad ?? '—'}<i class="rv">${j.edadRival ?? '—'}</i></td>
  <td class="n">${j.wtn ?? '—'}<i class="rv">${j.wtnRival ?? '—'}</i></td>
  <td class="n sec">${j.itf ?? '—'}<i class="rv">${j.itfRival ?? '—'}</i></td>
  <td class="n sec">${j.atp ?? '—'}<i class="rv">${j.atpRival ?? '—'}</i></td>
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
.act{display:flex;flex-wrap:wrap;gap:8px 12px;align-items:center;margin-bottom:10px}
.act button{font:600 13px system-ui;padding:7px 13px;border-radius:8px;border:1px solid var(--accent);
  background:var(--accent);color:var(--panel);cursor:pointer}
.act button.sec2{background:transparent;color:var(--accent)}
.act button:disabled{opacity:.5;cursor:default}
.act button small{font-weight:400;opacity:.75;margin-left:5px}
#act-estado{font:500 12.5px system-ui;color:var(--ink2)}
.act .mod{margin-left:auto;font:500 11.5px system-ui;color:var(--ink3)}
#act-token{flex-basis:100%;background:var(--panel);border:1px solid var(--rule);border-radius:9px;padding:11px 13px}
#act-token p{margin:0 0 8px;font-size:12.5px;color:var(--ink2);line-height:1.5}
#act-token input{font:400 13px system-ui;padding:6px 9px;border:1px solid var(--rule);border-radius:7px;
  background:var(--sunk);color:var(--ink);width:330px;max-width:100%}
.barra{display:flex;flex-wrap:wrap;gap:8px 14px;align-items:center;background:var(--panel);
  border:1px solid var(--rule);border-radius:10px;padding:10px 12px;margin-bottom:12px}
.barra label{font:600 11px system-ui;color:var(--ink3);text-transform:uppercase;letter-spacing:.04em}
.barra input[type=text]{font:400 13px system-ui;padding:5px 9px;border:1px solid var(--rule);
  border-radius:7px;background:var(--sunk);color:var(--ink);min-width:150px}
.barra select{font:400 13px system-ui;padding:5px 8px;border:1px solid var(--rule);
  border-radius:7px;background:var(--sunk);color:var(--ink);max-width:210px}
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
.mk{color:var(--ink3);font-weight:400;font-size:11.5px}
/* el mismo dato del rival, debajo y apagado: sirve para comparar de un
   vistazo sin competirle al del jugador de la fila */
.rv{display:block;font-style:normal;font-size:11px;color:var(--ink3);opacity:.75;margin-top:1px}
.pb{padding:1px 6px;border-radius:8px;font-weight:600}
.pb.alta{background:var(--pos-soft);color:var(--pos)}
.pb.media{background:var(--ojo-soft);color:var(--ojo)}
tr.ju td:first-child{box-shadow:inset 3px 0 0 var(--pos)}
.est{color:var(--pos)}
tr[hidden]{display:none}
.pie{color:var(--ink3);font-size:12px;margin-top:14px;line-height:1.6}
</style>
<div class="env">
<h1>Tabla ITF — lo apostable de ahora</h1>
<p class="sub">${J.length} jugadores · ${new Set(J.map(j => j.torneo)).size} torneos · armada ${new Date().toISOString().slice(11, 16)} UTC.
  Solo partidos que <b>todavía no empiezan</b> y tienen cuota de los dos lados: lo que ya arrancó no se puede apostar y sale de la tabla.
  Clic en cualquier encabezado para ordenar; el nombre abre la búsqueda en Betano. La ★ y el borde verde marcan lo que pisa la casilla del manual.
  <a href="./index.html" style="color:var(--accent)">Ver el análisis completo →</a></p>

<div class="act">
  <button id="b-cuotas" data-que="cuotas">⟳ Cuotas y partidos <small>2–3 min</small></button>
  <button id="b-todo" data-que="todo" class="sec2">⟳ Torneos y cuadros <small>10–15 min</small></button>
  <button id="b-modelo" data-que="modelo" class="sec2">🧠 Que aprenda el modelo <small>5–10 min</small></button>
  <span id="act-estado"></span>
  <span class="mod">modelo ${O.de === 'aprendido' ? 'aprendido' : 'de fábrica'} ·
    ${O.partidos} partidos · ${O.fecha ? String(O.fecha).slice(0, 10) : ''}</span>
  <div id="act-token" hidden>
    <p>Una sola vez: un token de GitHub que queda guardado solo en este navegador.
      Se crea en <b>github.com → Settings → Developer settings → Fine-grained tokens</b>,
      dándole acceso solo al repositorio <b>BETO</b> con permiso <b>Actions: Read and write</b>.</p>
    <input id="act-pat" type="password" placeholder="pega el token acá" autocomplete="off">
    <button id="act-guardar" type="button">Guardar</button>
  </div>
</div>

<div class="barra">
  <label>buscar</label><input type="text" id="q" placeholder="jugador o rival">
  <label>torneo</label><select id="tor"><option value="">todos</option>${
    [...new Set(J.map(j => j.torneo))].sort().map(t => `<option value="${esc(t.toLowerCase())}">${esc(t)}</option>`).join('')
  }</select>
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
  <b>local</b> es que juega en su país, lo que vale ~0.5 puntos de WTN. Los rankings ITF y ATP van vacíos cuando el jugador no tiene.
  En edad, WTN, ITF y ATP el <span style="color:var(--ink3)">número chico de abajo</span> es el mismo dato del RIVAL, para comparar sin cambiar de fila.
  El nombre abre el buscador de Betano: la API de cuotas no entrega la URL del partido, así que es búsqueda por nombre, no enlace directo.
  El paréntesis junto al nombre es cómo entró: un número es su siembra, <b>Q</b> salió de la clasificación, <b>WC</b> invitación de la
  organización, <b>LL</b> lucky loser, <b>PR</b> ranking protegido, <b>Alt</b> alternate, <b>SE</b> exento. Sin paréntesis entró directo por ranking.</p>
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
    const tor = g('tor').value;
    const cmin=num(g('cmin').value), cmax=num(g('cmax').value);
    const pmin=num(g('pmin').value), pmax=num(g('pmax').value);
    const emin=num(g('emin').value), emax=num(g('emax').value);
    const wmin=num(g('wmin').value), wmax=num(g('wmax').value);
    let v=0;
    for (const tr of filas){
      const ok = (!q || val(tr,'jugador').includes(q) || val(tr,'rival').includes(q))
        && (!tor || val(tr,'torneo') === tor)
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
  g('tor').addEventListener('change', aplica);
  g('limpiar').addEventListener('click', () => {
    for (const id of ['q','cmin','cmax','pmin','pmax','emin','emax','wmin','wmax']) g(id).value='';
    g('tor').value='';
    for (const k in S) S[k]=false;
    for (const b of document.querySelectorAll('.barra button[data-f]')) b.classList.remove('on');
    aplica();
  });
  aplica();
})();

/* Los tres botones disparan el mismo workflow con distinto "qué":
   cuotas (rápido), todo (cuadros por navegador) y modelo (reajusta las
   constantes con los resultados y las aplica solo si mejoran). El token
   vive únicamente en este navegador, nunca en el repo. */
(() => {
  var REPO='smartinoli/BETO', RAMA='claude/itf-scrapers-prize-money-7oy59k', WF='tabla.yml';
  var est=document.getElementById('act-estado'),
      caja=document.getElementById('act-token'), inp=document.getElementById('act-pat'),
      gu=document.getElementById('act-guardar');
  var botones=['b-cuotas','b-todo','b-modelo'].map(function(i){return document.getElementById(i)}).filter(Boolean);
  if(!botones.length) return;
  var AVISO={ cuotas:'corriendo: marcadores + cuotas + análisis (2–3 min)…',
              todo:'corriendo: cuadros ITF por navegador + cuotas (10–15 min)…',
              modelo:'corriendo: el modelo se reajusta con los resultados y se queda con lo mejor (5–10 min)…' };
  function traba(si){ botones.forEach(function(b){b.disabled=si}); }
  function lee(){ try{return localStorage.getItem('tabla-pat')||''}catch(e){return ''} }
  function guarda(t){ try{localStorage.setItem('tabla-pat',t)}catch(e){} }
  function borra(){ try{localStorage.removeItem('tabla-pat')}catch(e){} }
  function api(ruta,opts,tok){
    opts=opts||{};
    opts.headers={ 'Authorization':'Bearer '+tok, 'Accept':'application/vnd.github+json' };
    return fetch('https://api.github.com/repos/'+REPO+ruta,opts);
  }
  var desde=0, pedido='cuotas';
  gu.onclick=function(){ var t=inp.value.trim(); if(!t)return; guarda(t); caja.hidden=true; inp.value=''; correr(pedido); };
  botones.forEach(function(b){ b.onclick=function(){
    pedido=b.getAttribute('data-que')||'cuotas';
    if(!lee()){ caja.hidden=false; inp.focus(); return; }
    correr(pedido);
  }; });
  function correr(que){
    traba(true); est.textContent='pidiendo la corrida…'; desde=Date.now()-120000;
    api('/actions/workflows/'+WF+'/dispatches',{method:'POST',body:JSON.stringify({ref:RAMA,inputs:{que:que}})},lee())
      .then(function(r){
        if(r.status===204){ est.textContent=AVISO[que]||AVISO.cuotas; setTimeout(mirar,20000); }
        else if(r.status===401||r.status===403){ borra(); est.textContent='el token no sirvió — pega uno nuevo'; caja.hidden=false; traba(false); }
        else { est.textContent='GitHub respondió '+r.status; traba(false); }
      })
      .catch(function(){ est.textContent='desde esta copia no se puede — usa la página online: smartinoli.github.io/BETO/tabla.html'; traba(false); });
  }
  function mirar(){
    api('/actions/runs?branch='+encodeURIComponent(RAMA)+'&event=workflow_dispatch&per_page=1',{},lee())
      .then(function(r){return r.json()})
      .then(function(j){
        var run=(j.workflow_runs||[])[0];
        if(run && Date.parse(run.created_at)>=desde && run.status==='completed'){
          if(run.conclusion==='success'){ est.textContent='listo — recargando…'; setTimeout(function(){location.reload()},4000); }
          else { est.textContent='la corrida terminó "'+run.conclusion+'" — revisa Actions en GitHub'; traba(false); }
        } else { est.textContent='corriendo… ('+((run&&run.status)||'en cola')+')'; setTimeout(mirar,15000); }
      })
      .catch(function(){ setTimeout(mirar,20000); });
  }
})();
</script>`;

fs.writeFileSync(path.join(DIR, 'itf-tabla.html'), html);
console.log(`✓ vigia/itf-tabla.html (${J.length} jugadores)`);
