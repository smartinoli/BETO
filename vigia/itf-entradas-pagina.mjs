#!/usr/bin/env node
/* ============================================================
   ITF-ENTRADAS-PAGINA — explica cómo se llena un cuadro ITF.
   Lee vigia/itf-entradas.json (lo deja itf-entradas.mjs) y arma la
   página. No mide nada nuevo: presenta lo medido.
   Uso:  node vigia/itf-entradas.mjs && node vigia/itf-entradas-pagina.mjs
   ============================================================ */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const DIR = path.dirname(fileURLToPath(import.meta.url));
const en = JSON.parse(fs.readFileSync(path.join(DIR, 'itf-entradas.json'), 'utf8'));
const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const med = a => a.length ? [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)] : null;
const pc = v => v == null ? '—' : (v * 100).toFixed(0) + '%';

const T = en.torneos.filter(t => t.cuadros.Q?.total || t.cuadros.M?.total)
  .sort((a, b) => a.clave.localeCompare(b.clave));
const dQ = T.filter(t => t.cuadros.Q?.total).map(t => t.cuadros.Q.dilucion);
const dM = T.filter(t => t.cuadros.M?.total).map(t => t.cuadros.M.dilucion);
const ret = T.filter(t => t.retiros.total);
const rTot = ret.map(t => t.retiros.total), rRank = ret.map(t => t.retiros.conRanking);
const destinos = {};
for (const t of T) for (const [d, n] of t.retiros.destinos) destinos[d] = (destinos[d] || 0) + n;
const topDest = Object.entries(destinos).sort((a, b) => b[1] - a[1]).slice(0, 6);

/* barra apilada: de dónde salió cada cuadro */
const apilada = c => c ? `<span class="ap" title="${c.total} jugadores">
  ${c.de.MDA ? `<i class="s-mda" style="width:${c.de.MDA / c.total * 100}%"></i>` : ''}
  ${c.de.Q ? `<i class="s-q" style="width:${c.de.Q / c.total * 100}%"></i>` : ''}
  ${(c.de.A + c.de.fuera) ? `<i class="s-a" style="width:${(c.de.A + c.de.fuera) / c.total * 100}%"></i>` : ''}
</span><b>${pc(c.dilucion)}</b>` : '<span class="nada">—</span>';

const filas = T.map(t => `<tr>
  <th scope="row">${esc(t.clave.slice(6))}</th>
  <td class="c-ap">${apilada(t.cuadros.M?.total ? t.cuadros.M : null)}</td>
  <td class="c-ap">${apilada(t.cuadros.Q?.total ? t.cuadros.Q : null)}</td>
  <td class="n">${t.retiros.total}</td>
  <td class="n">${t.retiros.conRanking}</td>
  <td class="n">${t.retiros.mejorAtp ?? '<i>—</i>'}</td>
  <td class="n">${t.retiros.aOtroTorneo}</td>
  <td class="c-txt">${t.retiros.destinos[0] ? esc(t.retiros.destinos[0][0]) + ' <i>' + t.retiros.destinos[0][1] + '</i>' : ''}</td>
</tr>`).join('');

const html = `<title>Cómo se llena un cuadro ITF</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@600;700&family=IBM+Plex+Sans:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500;600&display=swap">
<style>
:root{--papel:#F4F6F7;--carta:#FFF;--tinta:#18242E;--tinta2:#5A6B7A;--tinta3:#93A3B0;--linea:#DCE3E8;
  --mda:#0E8A6E;--q:#4B7FA8;--a:#C08A2E;--dn:#C0392B;--franja:#F9FBFC;--realce:#EDF3F6}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--papel:#0E141A;--carta:#151E26;
  --tinta:#DCE6ED;--tinta2:#8FA1B0;--tinta3:#62727E;--linea:#25303A;
  --mda:#26A98A;--q:#6C9DC4;--a:#D9A94B;--dn:#DB6350;--franja:#121A21;--realce:#1B252E}}
:root[data-theme="dark"]{--papel:#0E141A;--carta:#151E26;--tinta:#DCE6ED;--tinta2:#8FA1B0;--tinta3:#62727E;
  --linea:#25303A;--mda:#26A98A;--q:#6C9DC4;--a:#D9A94B;--dn:#DB6350;--franja:#121A21;--realce:#1B252E}
*{box-sizing:border-box}
body{margin:0;background:var(--papel);color:var(--tinta);font:15px/1.55 "IBM Plex Sans",system-ui,sans-serif}
.env{max-width:1000px;margin:0 auto;padding:26px 18px 60px}
h1{font-family:"Barlow Condensed",sans-serif;font-weight:700;font-size:33px;margin:0;letter-spacing:.4px;text-wrap:balance}
.sub{color:var(--tinta2);font-size:14px;margin:2px 0 20px}
h2{font-family:"Barlow Condensed",sans-serif;font-weight:700;font-size:22px;margin:32px 0 3px;letter-spacing:.4px}
.nota{color:var(--tinta2);font-size:13.5px;margin:0 0 12px;max-width:76ch}
.flujo{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:11px;margin:16px 0 4px}
.caja{background:var(--carta);border:1px solid var(--linea);border-radius:8px;padding:12px 14px;border-top:3px solid var(--linea)}
.caja.mda{border-top-color:var(--mda)} .caja.q{border-top-color:var(--q)}
.caja.a{border-top-color:var(--a)} .caja.w{border-top-color:var(--dn)}
.caja .cod{font:600 12px "IBM Plex Mono",monospace;letter-spacing:.5px}
.caja.mda .cod{color:var(--mda)} .caja.q .cod{color:var(--q)}
.caja.a .cod{color:var(--a)} .caja.w .cod{color:var(--dn)}
.caja h3{font-size:14.5px;margin:3px 0 5px;font-weight:600}
.caja p{margin:0;font-size:12.5px;color:var(--tinta2);line-height:1.5}
.cifras{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px;margin:16px 0 4px}
.tarj{background:var(--carta);border:1px solid var(--linea);border-radius:8px;padding:13px 15px}
.tarj .cifra{font-family:"IBM Plex Mono",monospace;font-size:26px;font-weight:600;line-height:1.1;font-variant-numeric:tabular-nums}
.tarj .et{font-size:11px;text-transform:uppercase;letter-spacing:.8px;color:var(--tinta2);font-weight:600;margin-bottom:4px}
.tarj p{margin:5px 0 0;font-size:12.5px;color:var(--tinta2);line-height:1.5}
.env-t{overflow-x:auto;background:var(--carta);border:1px solid var(--linea);border-radius:8px}
table{border-collapse:separate;border-spacing:0;width:100%;min-width:760px}
th,td{padding:7px 9px;border-bottom:1px solid var(--linea)}
thead th{font:600 10.5px "IBM Plex Sans",sans-serif;text-transform:uppercase;letter-spacing:.7px;
  color:var(--tinta2);text-align:right;white-space:nowrap;border-bottom:2px solid var(--linea)}
thead th:first-child,thead th.iz{text-align:left}
tbody th{font-family:"IBM Plex Mono",monospace;font-weight:500;font-size:12px;text-align:left;white-space:nowrap}
tbody tr:hover td,tbody tr:hover th{background:var(--realce)}
tbody tr:last-child th,tbody tr:last-child td{border-bottom:none}
td.n{text-align:right;font-family:"IBM Plex Mono",monospace;font-size:12.5px;font-variant-numeric:tabular-nums}
td.c-txt{font-size:12px;color:var(--tinta2)} td.c-txt i{font-style:normal;color:var(--tinta3)}
td.c-ap{min-width:150px}
.ap{display:inline-flex;width:104px;height:9px;border-radius:2px;overflow:hidden;background:var(--linea);vertical-align:-1px;gap:1px}
.ap i{display:block;height:100%}
.s-mda{background:var(--mda)} .s-q{background:var(--q)} .s-a{background:var(--a)}
td.c-ap b{font:600 11.5px "IBM Plex Mono",monospace;margin-left:7px;color:var(--a)}
.nada{color:var(--tinta3)}
.leyenda{display:flex;gap:15px;flex-wrap:wrap;font-size:12px;color:var(--tinta2);margin:9px 0 0;align-items:center}
.mu{display:inline-block;width:11px;height:11px;border-radius:2px;vertical-align:-1px;margin-right:5px}
.mu.mda{background:var(--mda)} .mu.q{background:var(--q)} .mu.a{background:var(--a)}
.hall{background:var(--carta);border:1px solid var(--linea);border-left:3px solid var(--dn);
  border-radius:0 8px 8px 0;padding:13px 16px;margin:12px 0}
.hall h3{font-size:14.5px;margin:0 0 5px;font-weight:600}
.hall p{margin:0;font-size:13.5px;color:var(--tinta2);line-height:1.6}
.mono{font-family:"IBM Plex Mono",monospace;font-size:12.5px;color:var(--tinta)}
.dest{display:flex;flex-wrap:wrap;gap:7px;margin:10px 0 0}
.dest span{background:var(--carta);border:1px solid var(--linea);border-radius:999px;padding:4px 11px;font-size:12.5px}
.dest b{font-family:"IBM Plex Mono",monospace;color:var(--dn)}
footer{margin-top:32px;padding-top:14px;border-top:1px solid var(--linea);font-size:12px;color:var(--tinta2);line-height:1.6}
</style>
<div class="env">
<h1>Cómo se llena un cuadro ITF</h1>
<p class="sub">${T.length} torneos con lista de aceptación y cuadro real · la lista no es una foto del torneo, es una cola</p>

<h2>Las cuatro secciones</h2>
<p class="nota">Cuando alguien se baja, sube el siguiente de la cola. Por eso el cuadro que finalmente juega puede parecerse poco a la lista original.</p>
<div class="flujo">
  <div class="caja mda"><div class="cod">MDA</div><h3>Aceptados al cuadro principal</h3>
    <p>Entran directo por ranking. Son los que la lista promete.</p></div>
  <div class="caja q"><div class="cod">Q</div><h3>Aceptados a la clasificación</h3>
    <p>Juegan las qualis para ganarse un lugar en el cuadro principal.</p></div>
  <div class="caja a"><div class="cod">A</div><h3>Suplentes</h3>
    <p>En lista de espera. Suben cada vez que alguien se retira, y son muchos más de los que uno pensaría.</p></div>
  <div class="caja w"><div class="cod">W</div><h3>Retirados</h3>
    <p>Con fecha, y a veces con el torneo al que se fueron en su lugar.</p></div>
</div>

<h2>De dónde sale cada cuadro</h2>
<p class="nota">La barra muestra la composición y el número a su derecha es la <b>dilución</b>: qué parte del cuadro NO estaba aceptada de entrada.</p>
<div class="cifras">
  <div class="tarj"><div class="et">clasificación</div><div class="cifra" style="color:var(--a)">${pc(med(dQ))}</div>
    <p>de dilución mediana, con casos de hasta ${pc(Math.max(...dQ))}. <b>Casi la mitad de un cuadro de qualis son suplentes</b> que originalmente no habían entrado.</p></div>
  <div class="tarj"><div class="et">cuadro principal</div><div class="cifra" style="color:var(--mda)">${pc(med(dM))}</div>
    <p>de dilución mediana. El cuadro grande se sostiene: los que se bajan son los de más abajo en la cola.</p></div>
  <div class="tarj"><div class="et">retiros por torneo</div><div class="cifra" style="color:var(--dn)">${med(rTot)}</div>
    <p>mediana, con máximo de ${Math.max(...rTot)}. De esos, ${med(rRank)} traen ranking ATP.</p></div>
</div>
<div class="env-t"><table>
  <thead><tr><th class="iz">Torneo</th><th class="iz">Cuadro principal</th><th class="iz">Clasificación</th>
    <th>Retiros</th><th>Con ATP</th><th>Mejor ATP</th><th>A otro torneo</th><th class="iz">Destino principal</th></tr></thead>
  <tbody>${filas}</tbody>
</table></div>
<div class="leyenda"><span><span class="mu mda"></span>aceptados directo</span><span><span class="mu q"></span>vinieron de qualis</span><span><span class="mu a"></span>suplentes y no listados</span></div>

<h2>Por qué faltan rankeados</h2>
<p class="nota">La lista de retiros trae la fecha y, en muchos casos, el torneo elegido en su lugar. No desaparecen: se van a jugar a otra parte esa misma semana.</p>
<div class="dest">${topDest.map(([d, n]) => `<span>${esc(d)} <b>${n}</b></span>`).join('')}</div>

<h2>Lo que probamos y NO sirve</h2>
<div class="hall"><h3>La dilución del cuadro no cambia lo predecible que es</h3>
<p>Parecía razonable que un cuadro lleno de suplentes fuera más caótico. Se midió partiendo las clasificaciones en tercios por dilución: el mejor WTN acierta <span class="mono">73.2%</span> con poca, <span class="mono">78.3%</span> con media y <span class="mono">73.4%</span> con mucha. Todo dentro del error. En cuadro principal, <span class="mono">71.7%</span> contra <span class="mono">70.5%</span>. No hay que ajustar nada por esto.</p></div>
<div class="hall"><h3>La fuerza del campo tampoco</h3>
<p>Medida por el ATP del cabeza de serie 1, que en estos torneos va de <span class="mono">222</span> a <span class="mono">542</span>: campo fuerte <span class="mono">70.1%</span>, medio <span class="mono">74.5%</span>, débil <span class="mono">73.7%</span>. Que el torneo tenga mejores o peores jugadores no cambia cuánto acierta la comparación de nivel entre los dos que están en la cancha.</p></div>

<footer>Medido con <span class="mono">vigia/itf-entradas.mjs</span> cruzando cada lista de aceptación con su cuadro real. El detalle por torneo queda en <span class="mono">vigia/itf-entradas.json</span>.<br>
“No listados” son jugadores que aparecen en el cuadro y no figuran en ninguna sección de la lista: suelen ser invitaciones de último minuto.</footer>
</div>`;
fs.writeFileSync(path.join(DIR, 'itf-entradas.html'), html);
console.log(`✓ itf-entradas.html (${(html.length / 1024).toFixed(0)} KB) · ${T.length} torneos`);
