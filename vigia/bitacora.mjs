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
const hist = Object.values(REG)
  .filter(e => e.sid === '10' && !e.sombra && /^AH 1er tiempo/.test(e.familia)
    && lineaDe(e) < 0 && e.cuota >= MIN && e.cuota <= MAX && CERRADO.includes(e.estado))
  .sort((a, b) => (a.inicio < b.inicio ? -1 : 1));
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

const filaCorrida = s => `<tr>
  <td class="c-part"><span class="eq">${esc(s.lado)}</span><span class="sub">${esc(s.partido)}</span></td>
  <td class="c-liga">${esc(s.liga)}</td>
  <td class="c-hora"><span class="d">${fechaCorta(s.inicio)}</span> <span class="h">${horaCorta(s.inicio)}</span></td>
  <td class="num">${s.cuota.toFixed(2)}</td>
  <td class="num sec">${s.justo.toFixed(2)}</td>
  <td class="num v ${bandaDe(s.vent).id}">${pct(s.vent)}</td>
</tr>`;

const RES = { G: ['gano', 'Ganada'], P: ['perdio', 'Perdida'], E: ['nula', 'Empate'],
              MG: ['gano', 'Media G'], MP: ['perdio', 'Media P'] };
const filaHist = e => `<tr${e.congelada ? ' class="fria"' : ''}>
  <td class="c-hora"><span class="d">${fechaCorta(e.inicio)}</span></td>
  <td class="c-part"><span class="eq">${esc(e.lado)}</span><span class="sub">${esc(e.partido)}</span></td>
  <td class="c-liga">${esc(e.liga)}</td>
  <td class="num">${e.cuota.toFixed(2)}</td>
  <td class="num v ${bandaDe(e.vent).id}">${pct(e.vent)}</td>
  <td><span class="pill ${RES[e.estado][0]}">${RES[e.estado][1]}</span>${e.congelada ? '<span class="pill fria-p">congelada</span>' : ''}</td>
  <td class="num u ${uni(e) > 0 ? 'gano' : uni(e) < 0 ? 'perdio' : 'nula'}">${uni(e) >= 0 ? '+' : '−'}${Math.abs(uni(e)).toFixed(2)}</td>
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

  .bandas{display:flex;flex-wrap:wrap;gap:8px}
  .banda{display:flex;align-items:baseline;gap:7px;border:1px solid var(--line-fuerte);
         border-radius:2px;padding:6px 11px;background:var(--surface)}
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
    <div class="criterio">hándicap asiático −(x) · primer tiempo · cuota ${MIN.toFixed(2)}–${MAX.toFixed(2)} · fútbol</div>
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
    <div class="scroll"><table>
      <thead><tr><th>Fecha</th><th>Apuesta</th><th>Liga</th><th class="num">Cuota</th><th class="num">vs justo</th><th>Resultado</th><th class="num">Unid.</th></tr></thead>
      <tbody>${hist.map(filaHist).join('\n')}</tbody>
    </table></div>
  </section>

  <section>
    <h2>Última corrida — todos los partidos del rango</h2>
    <p class="lead">Sin filtro de valor: entran todos los partidos que ofrecen la línea dentro del rango de cuota, ordenados de mayor a menor ventaja. Las de ventaja negativa significan que Betano paga bajo el justo de Cloudbet — se listan como dato, no como recomendación.</p>
    <div class="bandas">
      ${porBanda.map(b => `<div class="banda ${b.id}"><span class="n">${b.n}</span><span class="e">${b.etiqueta}</span></div>`).join('\n      ')}
    </div>
    <div class="scroll"><table>
      <thead><tr><th>Apuesta</th><th>Liga</th><th>Comienza</th><th class="num">Cuota</th><th class="num">Justo</th><th class="num">Ventaja</th></tr></thead>
      <tbody>${senales.map(filaCorrida).join('\n')}</tbody>
    </table></div>
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

  <footer>
    Generado por <code>vigia/bitacora.mjs</code> desde <code>registro.json</code> y la corrida del barrido.
    Espejo del 1X2 de primer tiempo: ${(corrida.espejo || []).length} señal(es) en esta corrida, medidas aparte.
  </footer>
</div>`;

fs.writeFileSync(salidaPath, html);
console.log('bitácora generada:', salidaPath, '·', hist.length, 'históricas ·', senales.length, 'de la corrida');
