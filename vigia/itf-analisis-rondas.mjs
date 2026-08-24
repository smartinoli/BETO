/* ============================================================
   ITF-ANALISIS-RONDAS — presenta el backtest ronda por ronda.
   Lee vigia/itf-backtest.json (lo deja itf-backtest.mjs) y arma la
   página de análisis. No mide nada: solo pinta lo medido.
   Uso:  node vigia/itf-backtest.mjs && node vigia/itf-analisis-rondas.mjs
   ============================================================ */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const DIR = path.dirname(fileURLToPath(import.meta.url));
const raw = JSON.parse(fs.readFileSync(path.join(DIR, 'itf-backtest.json'), 'utf8'));
const bt = { total: raw.total, sinRetiro: raw.sinRetiro, rondas: raw.resumen };
const ORDEN=['Q1','Q2','Q3','R1','R2','QF','SF','F'];
const SEN=['WTN','ATP','ITF','rank país','forma','más joven','sembrado'];
const BAN=['<1.5','1.5-2.5','2.5-4','4+'];
const esc=s=>String(s??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

/* barra divergente centrada en 50%: la mitad de la celda es el eje */
function barra(a,n){
  if(a==null) return `<span class="poco">n=${n}</span>`;
  const p=(a*100), off=(p-50)*2;           /* 0..100 → −100..+100 */
  const w=Math.min(Math.abs(off),100)/2;   /* mitad del ancho */
  const pos=p>=50;
  return `<span class="bar" title="${p.toFixed(1)}% de acierto sobre ${n} partidos">
    <span class="eje"></span>
    <span class="fill ${pos?'up':'dn'}" style="width:${w}%;${pos?'left:50%':'right:50%'}"></span>
    <b class="${pos?'up':'dn'}">${p.toFixed(0)}</b><i>${n}</i></span>`;
}
const filasSen=ORDEN.filter(r=>bt.rondas[r]).map(r=>{
  const v=bt.rondas[r];
  return `<tr><th scope="row">${r}<i>${v.n}</i></th>${SEN.map(s=>{
    const x=v.señales[s]||{};
    return `<td>${barra(x.acierta??null,x.n||0)}</td>`;}).join('')}</tr>`;
}).join('');
const filasBan=ORDEN.filter(r=>bt.rondas[r]).map(r=>{
  const v=bt.rondas[r];
  return `<tr><th scope="row">${r}<i>${v.n}</i></th>${BAN.map(b=>{
    const x=v.bandas[b]||{};
    return `<td>${barra(x.acierta??null,x.n||0)}</td>`;}).join('')}</tr>`;
}).join('');

const html=`<title>Qué acierta en cada ronda</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@600;700&family=IBM+Plex+Sans:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500;600&display=swap">
<style>
:root{--papel:#F4F6F7;--carta:#FFF;--tinta:#18242E;--tinta2:#5A6B7A;--tinta3:#93A3B0;--linea:#DCE3E8;
  --up:#0E8A6E;--dn:#C0392B;--up-suave:#E2F1EC;--dn-suave:#F8E7E4;--franja:#F9FBFC;--realce:#EDF3F6}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--papel:#0E141A;--carta:#151E26;
  --tinta:#DCE6ED;--tinta2:#8FA1B0;--tinta3:#62727E;--linea:#25303A;
  --up:#26A98A;--dn:#DB6350;--up-suave:#12302A;--dn-suave:#331E1B;--franja:#121A21;--realce:#1B252E}}
:root[data-theme="dark"]{--papel:#0E141A;--carta:#151E26;--tinta:#DCE6ED;--tinta2:#8FA1B0;--tinta3:#62727E;
  --linea:#25303A;--up:#26A98A;--dn:#DB6350;--up-suave:#12302A;--dn-suave:#331E1B;--franja:#121A21;--realce:#1B252E}
*{box-sizing:border-box}
body{margin:0;background:var(--papel);color:var(--tinta);font:15px/1.55 "IBM Plex Sans",system-ui,sans-serif}
.env{max-width:1080px;margin:0 auto;padding:26px 18px 60px}
h1{font-family:"Barlow Condensed",sans-serif;font-weight:700;font-size:34px;margin:0;letter-spacing:.4px;text-wrap:balance}
.sub{color:var(--tinta2);font-size:14px;margin:2px 0 22px}
h2{font-family:"Barlow Condensed",sans-serif;font-weight:700;font-size:22px;margin:34px 0 3px;letter-spacing:.4px}
h2 + .nota{margin-top:0}
.nota{color:var(--tinta2);font-size:13.5px;margin:0 0 12px;max-width:76ch}
.destacados{display:grid;grid-template-columns:repeat(auto-fit,minmax(215px,1fr));gap:12px;margin:18px 0 6px}
.tarj{background:var(--carta);border:1px solid var(--linea);border-radius:8px;padding:13px 15px}
.tarj .cifra{font-family:"IBM Plex Mono",monospace;font-size:27px;font-weight:600;line-height:1.1;font-variant-numeric:tabular-nums}
.tarj .cifra.up{color:var(--up)} .tarj .cifra.dn{color:var(--dn)}
.tarj .et{font-size:11px;text-transform:uppercase;letter-spacing:.8px;color:var(--tinta2);font-weight:600;margin-bottom:5px}
.tarj p{margin:5px 0 0;font-size:12.5px;color:var(--tinta2);line-height:1.5}
.env-t{overflow-x:auto;background:var(--carta);border:1px solid var(--linea);border-radius:8px}
table{border-collapse:separate;border-spacing:0;width:100%;min-width:720px}
th,td{padding:7px 9px;border-bottom:1px solid var(--linea)}
thead th{font:600 10.5px "IBM Plex Sans",sans-serif;text-transform:uppercase;letter-spacing:.7px;
  color:var(--tinta2);text-align:center;white-space:nowrap;border-bottom:2px solid var(--linea)}
thead th:first-child{text-align:left}
tbody th{font-family:"IBM Plex Mono",monospace;font-weight:600;font-size:13px;text-align:left;white-space:nowrap;width:78px}
tbody th i{font-style:normal;color:var(--tinta3);font-weight:400;font-size:11px;margin-left:6px}
tbody tr:hover td,tbody tr:hover th{background:var(--realce)}
tbody tr:last-child th,tbody tr:last-child td{border-bottom:none}
.bar{display:block;position:relative;height:22px;min-width:96px}
.bar .eje{position:absolute;left:50%;top:2px;bottom:2px;width:1px;background:var(--linea)}
.bar .fill{position:absolute;top:6px;height:10px;border-radius:2px}
.bar .fill.up{background:var(--up);border-radius:0 3px 3px 0}
.bar .fill.dn{background:var(--dn);border-radius:3px 0 0 3px}
.bar b{position:absolute;right:2px;top:2px;font:600 12px "IBM Plex Mono",monospace;font-variant-numeric:tabular-nums}
.bar b.up{color:var(--up)} .bar b.dn{color:var(--dn)}
.bar i{position:absolute;left:2px;top:3px;font-style:normal;font-size:10px;color:var(--tinta3);font-family:"IBM Plex Mono",monospace}
.poco{display:block;height:22px;line-height:22px;text-align:center;font:400 11px "IBM Plex Mono",monospace;color:var(--tinta3)}
.leyenda{display:flex;gap:16px;flex-wrap:wrap;font-size:12px;color:var(--tinta2);margin:9px 0 0;align-items:center}
.mu{display:inline-block;width:11px;height:11px;border-radius:2px;vertical-align:-1px;margin-right:5px}
.mu.up{background:var(--up)} .mu.dn{background:var(--dn)}
.hallazgo{background:var(--carta);border:1px solid var(--linea);border-left:3px solid var(--up);
  border-radius:0 8px 8px 0;padding:13px 16px;margin:12px 0}
.hallazgo.malo{border-left-color:var(--dn)}
.hallazgo h3{font-size:14.5px;margin:0 0 5px;font-weight:600}
.hallazgo p{margin:0;font-size:13.5px;color:var(--tinta2);line-height:1.6}
.hallazgo .mono,.nota .mono,p .mono{font-family:"IBM Plex Mono",monospace;font-size:12.5px;color:var(--tinta)}
footer{margin-top:34px;padding-top:14px;border-top:1px solid var(--linea);font-size:12px;color:var(--tinta2);line-height:1.6}
</style>
<div class="env">
<h1>Qué acierta en cada ronda</h1>
<p class="sub">${bt.total} partidos jugados de todos los cuadros guardados · ${bt.sinRetiro} sin retiros, que son los que se miden · nivel siempre de la entry list del propio torneo</p>

<div class="destacados">
  <div class="tarj"><div class="et">la mejor ronda</div><div class="cifra up">79.5%</div>
    <p>El WTN en <b>Q2</b>, sobre 146 partidos. Es la segunda ronda de clasificación.</p></div>
  <div class="tarj"><div class="et">el precipicio</div><div class="cifra dn">61.0%</div>
    <p>El WTN en <b>Q3</b>, la ronda que decide el cuadro principal. Cae 18 puntos de golpe.</p></div>
  <div class="tarj"><div class="et">donde estábamos ciegos</div><div class="cifra dn">59.5%</div>
    <p>Δ1.5-2.5 en <b>Q1</b>. Le aplicábamos 68% porque promediábamos todas las rondas tempranas juntas.</p></div>
  <div class="tarj"><div class="et">lo más sólido</div><div class="cifra up">89.6%</div>
    <p>Δ4+ en <b>Q1</b>, sobre 164 partidos. La muestra más grande de todas y la más fiable.</p></div>
</div>

<h2>Cada señal, ronda por ronda</h2>
<p class="nota">Barra a la derecha del eje = acierta más que el azar; a la izquierda = acierta menos. El número chico a la izquierda de cada celda es cuántos partidos tenían ese dato. Una señal “opina” solo cuando existe para los dos jugadores y no empatan.</p>
<div class="env-t"><table>
  <thead><tr><th>Ronda</th>${SEN.map(s=>`<th>${esc(s)}</th>`).join('')}</tr></thead>
  <tbody>${filasSen}</tbody>
</table></div>
<div class="leyenda"><span><span class="mu up"></span>sobre 50% (predice)</span><span><span class="mu dn"></span>bajo 50% (predice al revés)</span><span>el eje central es el azar</span></div>

<h2>El WTN por banda de Δ, dentro de cada ronda</h2>
<p class="nota">Esta es la tabla que usábamos mal: teníamos una sola banda para “qualis, R1 y R2” juntas, y las rondas no se parecen entre sí.</p>
<div class="env-t"><table>
  <thead><tr><th>Ronda</th>${BAN.map(b=>`<th>Δ ${esc(b)}</th>`).join('')}</tr></thead>
  <tbody>${filasBan}</tbody>
</table></div>

<h2>Lo que sale de acá</h2>

<div class="hallazgo"><h3>Q2 es la ronda de oro y Q3 es una trampa</h3>
<p>En Q2 el WTN acierta <span class="mono">79.5%</span> (n=146) y con Δ4+ llega a <span class="mono">93.3%</span> (n=60). Pero en <b>Q3</b>, que es la ronda que decide quién entra al cuadro principal, se desploma a <span class="mono">61.0%</span> — y con Δ4+ apenas <span class="mono">61.1%</span>. El que está a un partido de entrar juega distinto, y el rating no lo ve.</p></div>

<div class="hallazgo malo"><h3>La banda global nos hacía sobreestimar Q1</h3>
<p>Veníamos usando <span class="mono">68.2%</span> para todo Δ1.5-2.5 en ronda temprana. Pero eso es el promedio de rondas que no se parecen: en <b>Q1</b> esa banda acierta <span class="mono">59.5%</span> y en <b>R1</b> <span class="mono">77.8%</span>. Un partido de Q1 con Δ2 lo estábamos cobrando casi nueve puntos por encima de lo que vale — y la cuota mínima que calculábamos con ese número quedaba demasiado baja.</p></div>

<div class="hallazgo"><h3>El ranking ITF sirve en qualis y no sirve en el cuadro principal</h3>
<p>Acierta <span class="mono">66.7%</span> en Q1, <span class="mono">67.0%</span> en Q2 y <span class="mono">66.7%</span> en Q3, pero cae a <span class="mono">52.3%</span> en R1 y <span class="mono">42.9%</span> en cuartos. Tiene sentido: es un ranking de circuito menor, así que discrimina entre jugadores de nivel clasificatorio y deja de hacerlo cuando todos son mejores que eso.</p></div>

<div class="hallazgo malo"><h3>La edad parecía una señal y no lo es</h3>
<p>El jugador más viejo gana <span class="mono">58.3%</span> de los 931 partidos donde hay ambas edades, y en Q1/R1 sube a <span class="mono">60.6%</span>. Parece mucho. Pero al controlarlo por WTN se cae entero: dentro de la banda de ruido (Δ&lt;1.5) el más viejo gana <span class="mono">50.5%</span>, azar puro. Y cuando el WTN y la edad señalan a jugadores distintos, gana el del mejor WTN el <span class="mono">73.4%</span> — lo mismo que cuando coinciden. Los mayores tienden a tener mejor WTN en este circuito: eso era todo.</p></div>

<div class="hallazgo malo"><h3>Cuando el ATP contradice al WTN, no hay lado</h3>
<p>En esos 69 partidos el WTN acierta <span class="mono">56.5%</span>, dentro del azar. Cuando coinciden, <span class="mono">70.4%</span>. Confirma la bandera que ya teníamos, ahora con el número.</p></div>

<div class="hallazgo"><h3>El sembrado manda en cuartos, justo donde el WTN falla</h3>
<p>En QF el mejor sembrado gana <span class="mono">81.3%</span> mientras el WTN acierta <span class="mono">59.6%</span>. Muestra chica (n=16), pero apunta a lo mismo que veníamos midiendo: en rondas finales el nivel deja de discriminar y hay que mirar otra cosa.</p></div>

<footer>Reconstruido con <span class="mono">vigia/itf-backtest.mjs</span> sobre todos los cuadros en disco. Se excluyen retiros y walkovers. El detalle partido a partido queda en <span class="mono">vigia/itf-backtest.json</span>.<br>
Las rondas con menos de 10 partidos para una señal aparecen como <span class="mono">n=…</span> sin barra: no alcanzan para decir nada.</footer>
</div>`;
fs.writeFileSync(path.join(DIR, 'itf-analisis-rondas.html'), html);
console.log('✓ itf-analisis-rondas.html ('+(html.length/1024).toFixed(0)+' KB)');
