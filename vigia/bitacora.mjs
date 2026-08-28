#!/usr/bin/env node
/* ============================================================
   BITÁCORA — genera el HTML del artefacto con el listado de cada
   corrida y el histórico liquidado del foco.

   Lee dos fuentes:
     · corrida.json  — la última corrida (lo que el barrido encontró)
     · registro.json — el histórico ya liquidado, para el mismo rango

   Uso: node vigia/bitacora.mjs <corrida.json> <salida.html>
   ============================================================ */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const [, , corridaPath, salidaPath] = process.argv;
const CFG = JSON.parse(fs.readFileSync(path.join(DIR, 'config.json'), 'utf8'));
const REG = JSON.parse(fs.readFileSync(path.join(DIR, 'registro.json'), 'utf8'));
const corrida = JSON.parse(fs.readFileSync(corridaPath, 'utf8'));

const CERRADO = ['G', 'MG', 'E', 'MP', 'P'];
/* retorno por unidad apostada: la medida honesta del filo, sin que el
   monto Kelly infle una apuesta grande que salió bien */
const uni = e => e.estado === 'G' ? e.cuota - 1 : e.estado === 'MG' ? (e.cuota - 1) / 2
  : e.estado === 'E' ? 0 : e.estado === 'MP' ? -0.5 : -1;
const lineaDe = e => parseFloat((String(e.lado).match(/(-?\d+(?:\.\d+)?)\s*$/) || [])[1]);

const MIN = CFG.cuotaMinima, MAX = CFG.cuotaMaxima;
/* el filtro sale del FOCO del config, no de una copia local: si el foco
   cambia (de -(x) a solo -0.5, por ejemplo), la bitácora sigue sola en vez
   de mostrar apuestas que ya no jugamos */
const reFoco = new RegExp(CFG.foco['10']);
const enFoco = e => reFoco.test(e.familia.split(' · ')[0] + ' · ' + e.lado);
const hist = Object.values(REG)
  .filter(e => e.sid === '10' && !e.sombra && enFoco(e)
    && e.cuota >= MIN && e.cuota <= MAX && CERRADO.includes(e.estado))
  .sort((a, b) => (a.inicio < b.inicio ? -1 : 1));
/* etiqueta legible del foco, derivada del propio regex */
const lineasFoco = CFG.foco['10'].includes('-0\\.5') ? '−0.5' : '−(x)';
const vivas = hist.filter(e => !e.congelada);

const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const pct = v => (v >= 0 ? '+' : '−') + Math.abs(v * 100).toFixed(1) + '%';
const fechaCorta = iso => { const d = new Date(iso); return isNaN(d) ? '—'
  : new Intl.DateTimeFormat('es-CL', { day: '2-digit', month: 'short', timeZone: 'America/Santiago' }).format(d); };
const horaCorta = iso => { const d = new Date(iso); return isNaN(d) ? ''
  : new Intl.DateTimeFormat('es-CL', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'America/Santiago' }).format(d); };

/* bandas de ventaja: el eje con el que ordenamos y agrupamos todo */
const BANDAS = [
  { id: 'alta',  test: v => v >= 0.015,             etiqueta: '≥ +1,5%' },
  { id: 'leve',  test: v => v >= 0 && v < 0.015,    etiqueta: '0 a +1,5%' },
  { id: 'roja',  test: v => v >= -0.02 && v < 0,    etiqueta: '−2% a 0' },
  { id: 'peor',  test: v => v < -0.02,              etiqueta: 'peor que −2%' },
];
const bandaDe = v => BANDAS.find(b => b.test(v)) || BANDAS[3];

const unidades = vivas.reduce((s, e) => s + uni(e), 0);
const roiVivas = vivas.length ? unidades / vivas.length * 100 : 0;
const rec = { G: 0, E: 0, P: 0, MG: 0, MP: 0 };
for (const e of vivas) rec[e.estado]++;

const senales = (corrida.senales || []).slice().sort((a, b) => b.vent - a.vent);
const porBanda = BANDAS.map(b => ({ ...b, n: senales.filter(s => b.test(s.vent)).length }));

const filaCorrida = s => `<tr data-buscar="${esc((s.lado + ' ' + s.partido + ' ' + s.liga).toLowerCase())}" data-banda="${bandaDe(s.vent).id}">
  <td class="c-part" data-v="${esc(s.lado.toLowerCase())}"><span class="eq">${esc(s.lado)}</span><span class="sub">${esc(s.partido)}</span></td>
  <td class="c-liga" data-v="${esc(s.liga.toLowerCase())}">${esc(s.liga)}</td>
  <td class="c-hora" data-v="${new Date(s.inicio).getTime() || 0}"><span class="d">${fechaCorta(s.inicio)}</span> <span class="h">${horaCorta(s.inicio)}</span></td>
  <td class="num" data-v="${s.cuota}">${s.cuota.toFixed(2)}</td>
  <td class="num sec" data-v="${s.justo}">${s.justo.toFixed(2)}</td>
  <td class="num v ${bandaDe(s.vent).id}" data-v="${s.vent}">${pct(s.vent)}</td>
</tr>`;

const RES = { G: ['gano', 'Ganada'], P: ['perdio', 'Perdida'], E: ['nula', 'Empate'],
              MG: ['gano', 'Media G'], MP: ['perdio', 'Media P'] };
const filaHist = e => `<tr${e.congelada ? ' class="fria"' : ''} data-buscar="${esc((e.lado + ' ' + e.partido + ' ' + e.liga).toLowerCase())}" data-banda="${bandaDe(e.vent).id}">
  <td class="c-hora" data-v="${new Date(e.inicio).getTime() || 0}"><span class="d">${fechaCorta(e.inicio)}</span> <span class="h">${horaCorta(e.inicio)}</span></td>
  <td class="c-part" data-v="${esc(e.lado.toLowerCase())}"><span class="eq">${esc(e.lado)}</span><span class="sub">${esc(e.partido)}</span></td>
  <td class="c-liga" data-v="${esc(e.liga.toLowerCase())}">${esc(e.liga)}</td>
  <td class="num" data-v="${e.cuota}">${e.cuota.toFixed(2)}</td>
  <td class="num v ${bandaDe(e.vent).id}" data-v="${e.vent}">${pct(e.vent)}</td>
  <td data-v="${esc(RES[e.estado][1])}"><span class="pill ${RES[e.estado][0]}">${RES[e.estado][1]}</span>${e.congelada ? '<span class="pill fria-p">congelada</span>' : ''}</td>
  <td class="num u ${uni(e) > 0 ? 'gano' : uni(e) < 0 ? 'perdio' : 'nula'}" data-v="${uni(e)}">${uni(e) >= 0 ? '+' : '−'}${Math.abs(uni(e)).toFixed(2)}</td>
</tr>`;

const html = `<title>Bitácora AH Primer Tiempo</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Archivo:wght@500;600;700&family=IBM+Plex+Mono:wght@400;500;600&family=IBM+Plex+Sans:wght@400;500;600&display=swap">
<style>
  :root{
    --paper:#f4f6f8; --surface:#ffffff; --ink:#101820; --muted:#61707f;
    --line:#e2e7ec; --line-fuerte:#ccd5dd;
    --acento:#2d6a8f; --acento-tenue:#e8f1f6;
    --gano:#17795e; --perdio:#a83f2e; --nula:#8b7a4f;
    --frio:#f0f3f6;
    --sans:"IBM Plex Sans",ui-sans-serif,system-ui,sans-serif;
    --disp:"Archivo",ui-sans-serif,system-ui,sans-serif;
    --mono:"IBM Plex Mono",ui-monospace,"SFMono-Regular",monospace;
  }
  @media (prefers-color-scheme:dark){:root:not([data-theme="light"]){
    --paper:#0e1318; --surface:#161d24; --ink:#e7edf3; --muted:#93a3b2;
    --line:#242e38; --line-fuerte:#33404c;
    --acento:#7cb8dc; --acento-tenue:#17242e;
    --gano:#3fbd93; --perdio:#e37f6c; --nula:#c2ab77;
    --frio:#131b22;
  }}
  :root[data-theme="dark"]{
    --paper:#0e1318; --surface:#161d24; --ink:#e7edf3; --muted:#93a3b2;
    --line:#242e38; --line-fuerte:#33404c;
    --acento:#7cb8dc; --acento-tenue:#17242e;
    --gano:#3fbd93; --perdio:#e37f6c; --nula:#c2ab77;
    --frio:#131b22;
  }
  *{box-sizing:border-box}
  body{margin:0;background:var(--paper);color:var(--ink);font-family:var(--sans);
       font-size:15px;line-height:1.55;-webkit-font-smoothing:antialiased}
  .wrap{max-width:1080px;margin:0 auto;padding:40px 24px 80px;display:flex;flex-direction:column;gap:44px}

  header{display:flex;flex-direction:column;gap:10px;border-bottom:2px solid var(--line-fuerte);padding-bottom:22px}
  h1{font-family:var(--disp);font-weight:700;font-size:clamp(26px,4vw,36px);line-height:1.1;
     letter-spacing:-.02em;margin:0;text-wrap:balance}
  .criterio{font-family:var(--mono);font-size:13px;color:var(--acento);letter-spacing:.01em}
  .sello{font-size:13px;color:var(--muted)}

  section{display:flex;flex-direction:column;gap:16px}
  h2{font-family:var(--disp);font-weight:600;font-size:19px;margin:0;letter-spacing:-.01em}
  .lead{margin:0;color:var(--muted);font-size:14px;max-width:66ch}

  .tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(158px,1fr));gap:1px;
         background:var(--line);border:1px solid var(--line);border-radius:3px;overflow:hidden}
  .tile{background:var(--surface);padding:15px 17px;display:flex;flex-direction:column;gap:5px}
  .tile .k{font-size:11px;text-transform:uppercase;letter-spacing:.09em;color:var(--muted);font-weight:600}
  .tile .val{font-family:var(--mono);font-size:25px;font-weight:600;line-height:1;font-variant-numeric:tabular-nums}
  .tile .note{font-size:12px;color:var(--muted)}
  .val.gano{color:var(--gano)} .val.perdio{color:var(--perdio)}

  .scroll{overflow-x:auto;border:1px solid var(--line);border-radius:3px;background:var(--surface)}
  table{width:100%;border-collapse:collapse;font-size:14px;min-width:660px}
  thead th{font-family:var(--disp);font-size:11px;text-transform:uppercase;letter-spacing:.08em;
           font-weight:600;color:var(--muted);text-align:left;padding:11px 13px;
           border-bottom:1px solid var(--line-fuerte);white-space:nowrap;background:var(--surface)}
  thead th.num{text-align:right}
  tbody td{padding:10px 13px;border-bottom:1px solid var(--line);vertical-align:top}
  tbody tr:last-child td{border-bottom:none}
  tbody tr.fria{background:var(--frio)}
  .num{text-align:right;font-family:var(--mono);font-variant-numeric:tabular-nums;white-space:nowrap}
  .sec{color:var(--muted)}
  .c-part .eq{display:block;font-weight:600}
  .c-part .sub{display:block;font-size:12.5px;color:var(--muted);margin-top:1px}
  .c-liga{color:var(--muted);font-size:13px}
  .c-hora{white-space:nowrap;font-family:var(--mono);font-size:13px}
  .c-hora .h{color:var(--muted)}
  .v{font-weight:600}
  .v.alta{color:var(--gano)} .v.leve{color:var(--ink)} .v.roja{color:var(--nula)} .v.peor{color:var(--perdio)}
  .u.gano{color:var(--gano)} .u.perdio{color:var(--perdio)} .u.nula{color:var(--muted)}

  .pill{display:inline-block;font-size:11px;font-weight:600;letter-spacing:.03em;
        padding:2px 8px;border-radius:2px;border:1px solid currentColor;white-space:nowrap}
  .pill+.pill{margin-left:5px}
  .pill.gano{color:var(--gano)} .pill.perdio{color:var(--perdio)} .pill.nula{color:var(--nula)}
  .pill.fria-p{color:var(--muted)}

  .controles{display:flex;flex-wrap:wrap;gap:10px;align-items:center}
  .buscar{flex:1 1 210px;min-width:0;font:inherit;font-size:13.5px;color:var(--ink);
          background:var(--surface);border:1px solid var(--line-fuerte);border-radius:3px;
          padding:7px 11px}
  .buscar::placeholder{color:var(--muted)}
  .buscar:focus-visible,.banda:focus-visible,th.orden:focus-visible{outline:2px solid var(--acento);outline-offset:1px}
  .conteo{font-family:var(--mono);font-size:12px;color:var(--muted);white-space:nowrap}
  th.orden{cursor:pointer;user-select:none}
  th.orden:hover{color:var(--ink)}
  th.orden::after{content:"";display:inline-block;width:0;height:0;margin-left:6px;
                  border-left:3.5px solid transparent;border-right:3.5px solid transparent;
                  opacity:.28;border-bottom:4.5px solid currentColor;vertical-align:middle}
  th.orden[aria-sort="ascending"]::after{opacity:1;border-bottom:4.5px solid var(--acento);border-top:0}
  th.orden[aria-sort="descending"]::after{opacity:1;border-top:4.5px solid var(--acento);border-bottom:0}
  tr[hidden]{display:none}
  .vacio{padding:22px 14px;text-align:center;color:var(--muted);font-size:13.5px}
  .bandas{display:flex;flex-wrap:wrap;gap:8px}
  .banda{display:flex;align-items:baseline;gap:7px;border:1px solid var(--line-fuerte);
         border-radius:2px;padding:6px 11px;background:var(--surface);cursor:pointer;
         font:inherit;color:inherit;transition:border-color .12s,background .12s}
  .banda:hover{border-color:var(--acento)}
  .banda[aria-pressed="true"]{border-color:var(--acento);background:var(--acento-tenue)}
  @media (prefers-reduced-motion:reduce){.banda{transition:none}}
  .banda .n{font-family:var(--mono);font-weight:600;font-size:16px;font-variant-numeric:tabular-nums}
  .banda .e{font-size:12px;color:var(--muted)}
  .banda.alta .n{color:var(--gano)} .banda.peor .n{color:var(--perdio)} .banda.roja .n{color:var(--nula)}

  .nota{border-left:2px solid var(--acento);background:var(--acento-tenue);
        padding:13px 16px;border-radius:0 3px 3px 0;font-size:13.5px;color:var(--ink)}
  .nota p{margin:0 0 8px} .nota p:last-child{margin:0}
  .nota strong{font-weight:600}
  footer{border-top:1px solid var(--line);padding-top:18px;font-size:12.5px;color:var(--muted)}
  code{font-family:var(--mono);font-size:.92em;background:var(--acento-tenue);padding:1px 5px;border-radius:2px}
</style>

<div class="wrap">
  <header>
    <h1>Bitácora AH Primer Tiempo</h1>
    <div class="criterio">hándicap asiático ${lineasFoco} · primer tiempo · cuota ${MIN.toFixed(2)}–${MAX.toFixed(2)} · fútbol</div>
    <div class="sello">Última corrida: ${new Date(corrida.ts).toLocaleString('es-CL', { timeZone: 'America/Santiago' })} · ${corrida.partidos} partidos barridos · ${corrida.requests} requests</div>
  </header>

  <section>
    <h2>Histórico liquidado</h2>
    <p class="lead">Apuestas del foco ya cerradas dentro del rango de cuota vigente. Solo las de precio vivo cuentan en el balance; las que se generaron con el feed congelado van marcadas y quedan fuera.</p>
    <div class="tiles">
      <div class="tile"><span class="k">Apuestas</span><span class="val">${vivas.length}</span><span class="note">precio vivo</span></div>
      <div class="tile"><span class="k">Récord</span><span class="val">${rec.G}<span style="font-size:15px;color:var(--muted)">G</span> ${rec.P}<span style="font-size:15px;color:var(--muted)">P</span> ${rec.E}<span style="font-size:15px;color:var(--muted)">E</span></span><span class="note">ganadas · perdidas · nulas</span></div>
      <div class="tile"><span class="k">Unidades</span><span class="val ${unidades >= 0 ? 'gano' : 'perdio'}">${unidades >= 0 ? '+' : '−'}${Math.abs(unidades).toFixed(2)}</span><span class="note">suma de retornos</span></div>
      <div class="tile"><span class="k">ROI por unidad</span><span class="val ${roiVivas >= 0 ? 'gano' : 'perdio'}">${roiVivas >= 0 ? '+' : '−'}${Math.abs(roiVivas).toFixed(1)}%</span><span class="note">cada apuesta pesa igual</span></div>
    </div>
    <div class="tabla" data-tabla="historico">
      <div class="controles">
        <input type="search" class="buscar" placeholder="Filtrar por equipo o liga…" aria-label="Filtrar el histórico por equipo o liga">
        <span class="conteo"></span>
      </div>
      <div class="scroll"><table>
        <thead><tr><th class="orden" data-tipo="num" data-inicial="asc">Fecha</th><th class="orden" data-tipo="txt">Apuesta</th><th class="orden" data-tipo="txt">Liga</th><th class="orden num" data-tipo="num">Cuota</th><th class="orden num" data-tipo="num">vs justo</th><th class="orden" data-tipo="txt">Resultado</th><th class="orden num" data-tipo="num">Unid.</th></tr></thead>
        <tbody>${hist.map(filaHist).join('\n')}</tbody>
      </table></div>
      <p class="vacio" hidden>Ninguna apuesta calza con ese filtro.</p>
    </div>
  </section>

  <section>
    <h2>Última corrida — todos los partidos del rango</h2>
    <p class="lead">Sin filtro de valor: entran todos los partidos que ofrecen la línea dentro del rango de cuota, ordenados de mayor a menor ventaja. Las de ventaja negativa significan que Betano paga bajo el justo de Cloudbet — se listan como dato, no como recomendación.</p>
    <div class="tabla" data-tabla="corrida">
      <div class="controles">
        <input type="search" class="buscar" placeholder="Filtrar por equipo o liga…" aria-label="Filtrar la corrida por equipo o liga">
        <span class="conteo"></span>
      </div>
      <div class="bandas">
        ${porBanda.map(b => `<button type="button" class="banda ${b.id}" data-filtro="${b.id}" aria-pressed="false"><span class="n">${b.n}</span><span class="e">${b.etiqueta}</span></button>`).join('\n        ')}
      </div>
      <div class="scroll"><table>
        <thead><tr><th class="orden" data-tipo="txt">Apuesta</th><th class="orden" data-tipo="txt">Liga</th><th class="orden" data-tipo="num">Comienza</th><th class="orden num" data-tipo="num">Cuota</th><th class="num">Justo</th><th class="orden num" data-tipo="num" data-inicial="desc">Ventaja</th></tr></thead>
        <tbody>${senales.map(filaCorrida).join('\n')}</tbody>
      </table></div>
      <p class="vacio" hidden>Ningún partido calza con ese filtro.</p>
    </div>
  </section>

  <section>
    <h2>Cómo leer esto</h2>
    <div class="nota">
      <p><strong>La ventaja es contra Cloudbet, no una verdad.</strong> El «justo» sale de des-vigar la cuota de Cloudbet; que Betano pague más no garantiza nada, solo dice que las dos casas discrepan.</p>
      <p><strong>AH −0.5 de primer tiempo ≡ «gana el primer tiempo».</strong> Empate al descanso = apuesta perdida. La línea −1 exige ganar por dos al descanso y devuelve la plata si gana por uno exacto.</p>
      <p><strong>El ROI por unidad trata todas las apuestas por igual.</strong> Es la medida del filo. El resultado del banco depende además del monto Kelly, que apuesta más donde ve más ventaja.</p>
      <p><strong>La muestra es corta.</strong> Con estas cantidades, diferencias de unos puntos entre bandas no significan nada. Lo que hace falta es volumen, no más filtros.</p>
    </div>
  </section>

  <script>
  /* Ordenar y filtrar sin librerías: cada celda lleva su valor ordenable en
     data-v, así el orden no depende de cómo se ve el texto (una fecha
     "28-ago" ordena por su timestamp, no alfabéticamente). */
  for (const tabla of document.querySelectorAll('.tabla')) {
    const cuerpo = tabla.querySelector('tbody');
    const filas = [...cuerpo.rows];
    const buscar = tabla.querySelector('.buscar');
    const conteo = tabla.querySelector('.conteo');
    const vacio = tabla.querySelector('.vacio');
    const bandas = [...tabla.querySelectorAll('.banda')];
    let bandaActiva = null;

    const aplicar = () => {
      const q = (buscar.value || '').trim().toLowerCase();
      let visibles = 0;
      for (const fila of filas) {
        const okTexto = !q || fila.dataset.buscar.includes(q);
        const okBanda = !bandaActiva || fila.dataset.banda === bandaActiva;
        fila.hidden = !(okTexto && okBanda);
        if (!fila.hidden) visibles++;
      }
      conteo.textContent = visibles === filas.length
        ? filas.length + (filas.length === 1 ? ' apuesta' : ' apuestas')
        : visibles + ' de ' + filas.length;
      vacio.hidden = visibles > 0;
    };

    const ordenar = (th) => {
      const i = [...th.parentNode.children].indexOf(th);
      const num = th.dataset.tipo === 'num';
      const previo = th.getAttribute('aria-sort');
      const dir = previo === 'ascending' ? 'descending'
        : previo === 'descending' ? 'ascending'
        : (th.dataset.inicial === 'asc' ? 'ascending' : 'descending');
      for (const otro of th.parentNode.children) otro.removeAttribute('aria-sort');
      th.setAttribute('aria-sort', dir);
      const signo = dir === 'ascending' ? 1 : -1;
      const valor = (fila) => {
        const celda = fila.cells[i];
        const v = celda.dataset.v ?? celda.textContent.trim();
        return num ? parseFloat(v) || 0 : String(v);
      };
      filas.sort((a, b) => {
        const va = valor(a), vb = valor(b);
        return signo * (num ? va - vb : va.localeCompare(vb, 'es'));
      });
      for (const fila of filas) cuerpo.appendChild(fila);
    };

    for (const th of tabla.querySelectorAll('th.orden')) {
      th.tabIndex = 0;
      th.addEventListener('click', () => ordenar(th));
      th.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); ordenar(th); }
      });
    }
    for (const b of bandas) {
      b.addEventListener('click', () => {
        bandaActiva = bandaActiva === b.dataset.filtro ? null : b.dataset.filtro;
        for (const otra of bandas) otra.setAttribute('aria-pressed', String(otra.dataset.filtro === bandaActiva));
        aplicar();
      });
    }
    buscar.addEventListener('input', aplicar);
    aplicar();
  }
  </script>

  <footer>
    Generado por <code>vigia/bitacora.mjs</code> desde <code>registro.json</code> y la corrida del barrido.
    Espejo del 1X2 de primer tiempo: ${(corrida.espejo || []).length} señal(es) en esta corrida, medidas aparte.
  </footer>
</div>`;

fs.writeFileSync(salidaPath, html);
console.log('bitácora generada:', salidaPath, '·', hist.length, 'históricas ·', senales.length, 'de la corrida');
