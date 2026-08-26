#!/usr/bin/env node
/* ============================================================
   ITF-AUDITORIA — qué sirve, qué no, y por qué.

   Mide TODOS los campos que tenemos contra la realidad y arma la página.
   Nada acá está escrito a mano: cada número sale de correr la medición
   sobre datos/itf/_auditoria.json (lo deja itf-banco.mjs).

   La medición es siempre la misma y es la única que respetamos: se ajusta
   el modelo dejando un torneo COMPLETO afuera y se juzga sobre ese torneo.
   Un torneo entero y no un partido al azar, porque los partidos de un
   mismo cuadro comparten jugadores y se filtrarían entre sí.

   Uso:  node vigia/itf-banco.mjs && node vigia/itf-auditoria.mjs
   ============================================================ */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as A from './itf-ajuste.mjs';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const P = A.P;
const sub18 = f => (f.edadFa <= 18 ? 1 : 0) - (f.edadRi <= 18 ? 1 : 0);
const SIN_JR = P.filter(f => !f.dJrElite);
const NUC = [...A.COLS_BASE, sub18];
const COND = [['games cedidos', f => f.dCed], ['torneo anterior', f => f.dPrev]];

/* la curva de referencia: SOLO ΔWTN por grupo de rondas. Todo se mide
   contra ella, que es lo que el sistema sabía antes de esta auditoría. */
const bBase = A.fit(P, A.COLS_BASE);
const pBase = f => A.sig(A.COLS_BASE.reduce((s, c, i) => s + bBase[i] * c(f), 0));

const wilson = (k, n) => {
  if (!n) return null;
  const z = 1.96, p = k / n, d = 1 + z * z / n;
  const c = (p + z * z / (2 * n)) / d, m = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d;
  return [Math.max(0, c - m), Math.min(1, c + m)];
};
function celda(a) {
  if (!a.length) return null;
  const k = a.filter(x => x.gano).length;
  const esp = a.reduce((s, x) => s + pBase(x), 0) / a.length;
  return { n: a.length, k, real: k / a.length, esp, dif: k / a.length - esp, ic: wilson(k, a.length) };
}
/* p-valor exacto de la cola, por convolución Poisson-binomial: cada
   partido tiene su propia probabilidad, así que no sirve una binomial. */
function pcola(a) {
  let d = [1];
  for (const p of a.map(pBase)) {
    const n = new Array(d.length + 1).fill(0);
    for (let i = 0; i < d.length; i++) { n[i] += d[i] * (1 - p); n[i + 1] += d[i] * p }
    d = n;
  }
  const k = a.filter(x => x.gano).length;
  let baja = 0, alta = 0;
  for (let i = 0; i <= k; i++) baja += d[i];
  for (let i = k; i < d.length; i++) alta += d[i];
  return Math.min(1, 2 * Math.min(baja, alta));
}

/* ---------- 1. inventario ---------- */
const INVENTARIO = [
  ['WTN', f => f.dW != null, 'eje', 'Es el eje del modelo. Todo lo demás corrige sobre él.'],
  ['edad', f => f.edadFa != null && f.edadRi != null, 'usa', 'Un escalón: tiene menos de 19 o no. No es una pendiente.'],
  ['games cedidos', f => f.dCed != null, 'usa', 'Sólo existe si los dos ya jugaron en ese cuadro.'],
  ['torneo anterior', f => f.dPrev != null, 'usa', 'Sólo si tenemos bajado el cuadro anterior de los dos.'],
  ['ranking junior', f => f.dJrElite !== 0, 'veto', 'Top 60 del mundo junior: el partido no se juega.'],
  ['ATP', f => f.dAtp != null, 'no', 'Redundante con el WTN (r=0.58) y con un tercio de los datos.'],
  ['ranking ITF', f => f.dItf != null, 'no', 'Coeficiente negativo: ruido.'],
  ['ranking nacional', f => f.dNac != null, 'no', 'Coeficiente negativo: ruido.'],
  ['tipo de entrada', f => f.dEntrada !== 0, 'no', 'El invitado rinde sobre lo esperado, pero no mueve el modelo.'],
  ['siembra', () => true, 'no', 'Con el escalón sub-19 adentro deja de aportar.'],
  ['categoría M15/M25', f => f.cat != null, 'no', 'Idéntico rendimiento en las dos.'],
  ['superficie', f => f.sup != null, 'no', 'Idéntico en tierra y en cemento.'],
  ['mismo país', f => f.mismoPais != null, 'no', 'No cambia nada.'],
  ['insignia ProZone', f => f.dPZ !== 0, 'no', 'Ya se había descartado: no es un corte de nivel.'],
].map(([campo, g, uso, nota]) => ({ campo, n: P.filter(g).length, uso, nota }));

/* ---------- 2. cada señal, sola, contra la curva de ΔWTN ---------- */
const SENALES_DEF = [
  ['edad, como escalón sub-19', f => sub18(f), 'La diferencia entre tener 18 y tener 19.'],
  ['edad, como años de diferencia', f => f.dEdad, 'La forma que usábamos antes.'],
  ['games cedidos', f => f.dCed, 'Cuánto le costó a cada uno llegar hasta acá.'],
  ['torneo anterior', f => f.dPrev, 'Hasta qué ronda llegó cada uno la semana pasada.'],
  ['siembra', f => f.dSeed, 'Cabeza de serie contra no sembrado.'],
  ['ATP', f => f.dAtp, 'Logaritmo del puesto: del 50 al 100 pesa como del 500 al 1000.'],
  ['ranking ITF', f => f.dItf, 'Ídem, con el ranking propio de la ITF.'],
  ['ranking nacional', f => f.dNac, 'El puesto dentro de su federación.'],
  ['tipo de entrada', f => f.dEntrada, 'Directo, clasificado, invitado, lucky loser.'],
  ['insignia ProZone', f => f.dPZ, 'Cuando la ITF tapa el WTN en su web.'],
];
const SENALES_G = Object.fromEntries(SENALES_DEF.map(([n, g]) => [n, g]));
const SENALES = SENALES_DEF.map(([nom, g, que]) => {
  const conj = P.filter(f => g(f) != null && Number.isFinite(g(f)));
  if (conj.length < 60) return { nom, que, n: conj.length, pocos: true };
  const col = f => g(f) ?? 0;
  const a = A.loto(conj, A.COLS_BASE), b = A.loto(conj, [...A.COLS_BASE, col]);
  const coef = A.fit(conj, [...A.COLS_BASE, col]).at(-1);
  return { nom, que, n: conj.length, ll0: a.ll, ll1: b.ll, ok0: a.ok, ok1: b.ok, coef,
    gana: a.ll - b.ll, sirve: b.ll < a.ll - 0.0005 };
}).map(x => {
  /* Segunda medición, y es la que decide: ¿aporta ENCIMA del núcleo?
     El ATP mejora la curva de ΔWTN a secas, pero una vez que el escalón
     sub-19 está adentro deja de mover el log-loss. Mostrar sólo la
     primera columna haría que la página se contradijera con el veredicto. */
  if (x.pocos) return x;
  const g = SENALES_G[x.nom];
  const conj = P.filter(f => g(f) != null && Number.isFinite(g(f)));
  const nuc = x.nom === 'edad, como escalón sub-19' ? A.COLS_BASE : NUC;
  const a2 = A.loto(conj, nuc), b2 = A.loto(conj, [...nuc, f => g(f) ?? 0]);
  return { ...x, llN0: a2.ll, llN1: b2.ll, ganaN: a2.ll - b2.ll, sirveN: b2.ll < a2.ll - 0.0005 };
}).sort((x, y) => (y.ganaN ?? y.gana ?? -9) - (x.ganaN ?? x.gana ?? -9));

/* ---------- 3. la edad ---------- */
const EDAD_ANO = [];
for (let e = 16; e <= 26; e++) {
  const c = celda(P.filter(f => f.edadRi === e));
  if (c && c.n >= 10) EDAD_ANO.push({ edad: e, ...c });
}
const EDAD_FAV = [];
for (let e = 16; e <= 26; e++) {
  const c = celda(P.filter(f => f.edadFa === e));
  if (c && c.n >= 10) EDAD_FAV.push({ edad: e, ...c });
}
const FORMAS = [
  ['escalón: 18 o menos', e => e <= 18 ? 1 : 0],
  ['escalón: 19 o menos', e => e <= 19 ? 1 : 0],
  ['escalón: 20 o menos', e => e <= 20 ? 1 : 0],
  ['rampa bajo 20', e => Math.max(0, 20 - e)],
  ['rampa bajo 19', e => Math.max(0, 19 - e)],
  ['años de diferencia', e => e],
  ['logaritmo de la edad', e => Math.log(e)],
].map(([nom, g]) => {
  const col = f => g(f.edadFa) - g(f.edadRi);
  const conEdad = P.filter(f => f.edadFa != null && f.edadRi != null);
  const sinJr = conEdad.filter(f => !f.fa.jr && !f.ri.jr);
  const r = A.loto(conEdad, [...A.COLS_BASE, col]);
  const r2 = A.loto(sinJr, [...A.COLS_BASE, col]);
  return { nom, ll: r.ll, ok: r.ok, coef: A.fit(conEdad, [...A.COLS_BASE, col]).at(-1),
    llSinJr: r2.ll, coefSinJr: A.fit(sinJr, [...A.COLS_BASE, col]).at(-1) };
}).sort((a, b) => a.ll - b.ll);
const REF_EDAD = A.loto(P.filter(f => f.edadFa != null && f.edadRi != null), A.COLS_BASE);
const REF_EDAD_SINJR = A.loto(P.filter(f => f.edadFa != null && f.edadRi != null && !f.fa.jr && !f.ri.jr), A.COLS_BASE);

/* la edad no es lo mismo en todas las rondas ni en todos los ΔWTN */
const CRUCE_RONDA = ['Q1', 'buenas', 'medias', 'finales'].map(g => ({
  fila: g,
  celdas: [['rival sub-19', f => f.edadRi <= 18], ['ninguno sub-19', f => f.edadFa > 18 && f.edadRi > 18], ['favorito sub-19', f => f.edadFa <= 18]]
    .map(([nom, h]) => ({ nom, ...(celda(P.filter(f => f.grupo === g && h(f))) || {}) })),
}));
const CRUCE_DELTA = [['Δ menor a 2', f => f.dW < 2], ['Δ de 2 a 5', f => f.dW >= 2 && f.dW < 5], ['Δ 5 o más', f => f.dW >= 5]]
  .map(([fila, g]) => ({
    fila,
    celdas: [['rival sub-19', f => f.edadRi <= 18], ['ninguno sub-19', f => f.edadFa > 18 && f.edadRi > 18], ['favorito sub-19', f => f.edadFa <= 18]]
      .map(([nom, h]) => ({ nom, ...(celda(P.filter(f => g(f) && h(f))) || {}) })),
  }));

/* ---------- 4. las condicionales ---------- */
const FORMA_BANDAS = [
  ['el favorito cede 10 pts menos', f => f.dCed != null && f.dCed >= 0.10],
  ['cede algo menos (3 a 10)', f => f.dCed != null && f.dCed >= 0.03 && f.dCed < 0.10],
  ['parejos (±3)', f => f.dCed != null && Math.abs(f.dCed) < 0.03],
  ['el rival cede algo menos', f => f.dCed != null && f.dCed <= -0.03 && f.dCed > -0.10],
  ['el rival cede 10 pts menos', f => f.dCed != null && f.dCed <= -0.10],
  ['sin trayectoria en alguno', f => f.dCed == null],
].map(([nom, g]) => ({ nom, ...(celda(P.filter(g)) || {}) }));
const PREVIO_BANDAS = [
  ['el favorito llegó 2 rondas más lejos', f => f.dPrev != null && f.dPrev >= 2],
  ['una ronda más lejos', f => f.dPrev === 1],
  ['los dos igual', f => f.dPrev === 0],
  ['el rival llegó más lejos', f => f.dPrev != null && f.dPrev <= -1],
  ['sin dato en alguno', f => f.dPrev == null],
].map(([nom, g]) => ({ nom, ...(celda(P.filter(g)) || {}) }));
const ENTRADA_BANDAS = [
  ['el rival entró directo', f => f.ri.entrada === 'DA'],
  ['el rival es clasificado', f => f.ri.entrada === 'Q'],
  ['el rival es invitado (WC)', f => f.ri.entrada === 'WC'],
  ['el rival es alterno', f => f.ri.entrada === 'A'],
].map(([nom, g]) => ({ nom, ...(celda(P.filter(g)) || {}) })).filter(x => x.n >= 10);
const CONTEXTO = [
  ['torneos M15', f => f.cat === 'M15'], ['torneos M25', f => f.cat === 'M25'],
  ['tierra batida', f => f.sup === 'Clay'], ['cemento', f => f.sup === 'Hard'],
  ['los dos del mismo país', f => f.mismoPais === 1], ['países distintos', f => f.mismoPais === 0],
].map(([nom, g]) => ({ nom, ...(celda(P.filter(g)) || {}) })).filter(x => x.n);
const SIEMBRA_BANDAS = [
  ['sólo el favorito sembrado', f => f.dSeed === 1],
  ['ninguno sembrado', f => f.dSeed === 0 && !f.fa.seed],
  ['los dos sembrados', f => f.dSeed === 0 && !!f.fa.seed],
  ['sólo el rival sembrado', f => f.dSeed === -1],
].map(([nom, g]) => ({ nom, ...(celda(P.filter(g)) || {}) })).filter(x => x.n);

/* ---------- 5. por qué el ATP no entra: correlaciones ---------- */
const EJES = [['ΔWTN', f => f.dW], ['ΔATP', f => f.dAtp], ['ΔITF', f => f.dItf], ['Δnacional', f => f.dNac], ['sub-19', sub18]];
function correl(fx, fy) {
  const v = P.filter(z => fx(z) != null && fy(z) != null && Number.isFinite(fx(z)) && Number.isFinite(fy(z)));
  if (v.length < 20) return null;
  const n = v.length, mx = v.reduce((s, z) => s + fx(z), 0) / n, my = v.reduce((s, z) => s + fy(z), 0) / n;
  let sxy = 0, sx = 0, sy = 0;
  for (const z of v) { const a = fx(z) - mx, b = fy(z) - my; sxy += a * b; sx += a * a; sy += b * b }
  return sxy / Math.sqrt(sx * sy);
}
const CORREL = EJES.map(([n1, f1]) => ({ eje: n1, fila: EJES.map(([, f2]) => correl(f1, f2)) }));

/* ---------- 6. el modelo, paso a paso ---------- */
function entrenar(tr) {
  const b = A.fit(tr, NUC), e0 = f => NUC.reduce((s, c, i) => s + b[i] * c(f), 0), cc = {};
  for (const [n, g] of COND) {
    const sub = tr.filter(f => g(f) != null && Number.isFinite(g(f)));
    let z = 0;
    if (sub.length >= 40) for (let it = 0; it < 50; it++) {
      let gr = 0, H = 0;
      for (const f of sub) { const x = g(f), p = A.sig(e0(f) + z * x), w = p * (1 - p); gr += ((f.gano ? 1 : 0) - p) * x; H += w * x * x }
      if (H < 1e-12) break;
      const d = gr / H; z += d; if (Math.abs(d) < 1e-10) break;
    }
    cc[n] = z;
  }
  return { b, cc, eta: f => e0(f) + COND.reduce((s, [n, g]) => s + ((g(f) != null && Number.isFinite(g(f))) ? cc[n] * g(f) : 0), 0) };
}
function evaluarStack() {
  const claves = [...new Set(SIN_JR.map(f => f.clave))];
  let ll = 0, ok = 0, n = 0;
  for (const k of claves) {
    const tr = SIN_JR.filter(f => f.clave !== k), te = SIN_JR.filter(f => f.clave === k);
    if (tr.length < 30 || !te.length) continue;
    const { eta } = entrenar(tr);
    for (const f of te) {
      const p = A.sig(eta(f)), y = f.gano ? 1 : 0;
      ll += -(y * Math.log(Math.max(p, 1e-9)) + (1 - y) * Math.log(Math.max(1 - p, 1e-9)));
      if ((p > 0.5) === f.gano) ok++; n++;
    }
  }
  return { ll: ll / n, ok: ok / n, n };
}
const ESCALERA = [
  { paso: 'sólo ΔWTN, un nivel por ronda', ...A.loto(SIN_JR, A.COLS_BASE) },
  { paso: 'más el escalón sub-19', ...A.loto(SIN_JR, NUC) },
  { paso: 'más games cedidos y torneo anterior', ...evaluarStack() },
];
const MODELO_FINAL = entrenar(SIN_JR);

/* ============================================================
   LA PÁGINA
   ============================================================ */
const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const pct = v => v == null ? '—' : (100 * v).toFixed(1) + '%';
const pts = v => v == null ? '—' : (v >= 0 ? '+' : '−') + Math.abs(100 * v).toFixed(1);
const ESCALA = 22;   /* puntos porcentuales que llenan media barra */

/* la barra divergente: una sola unidad visual, repetida en toda la página,
   para que el lector aprenda a leerla una vez */
function barra(dif) {
  if (dif == null) return '<td class="bar"></td>';
  const w = Math.min(50, Math.abs(100 * dif) / ESCALA * 50);
  const lado = dif >= 0 ? 'pos' : 'neg';
  const estilo = dif >= 0 ? `left:50%;width:${w}%` : `right:50%;width:${w}%`;
  return `<td class="bar"><span class="cero"></span><span class="fill ${lado}" style="${estilo}"></span></td>`;
}
function filaCelda(nom, c, extra = '') {
  if (!c || !c.n) return `<tr><th scope="row">${esc(nom)}</th><td class="num">0</td><td colspan="4" class="vacio">sin partidos</td></tr>`;
  return `<tr><th scope="row">${esc(nom)}${extra}</th>
    <td class="num">${c.n}</td>
    <td class="num">${pct(c.real)}</td>
    <td class="num sec">${pct(c.esp)}</td>
    <td class="num ${c.dif >= 0 ? 'pos' : 'neg'}">${pts(c.dif)}</td>
    ${barra(c.dif)}
    <td class="num sec">${c.ic ? `${(100 * c.ic[0]).toFixed(0)}–${(100 * c.ic[1]).toFixed(0)}` : '—'}</td></tr>`;
}
const CAB = `<thead><tr><th scope="col">caso</th><th scope="col" class="num">n</th>
  <th scope="col" class="num">ganó</th><th scope="col" class="num">esperaba</th>
  <th scope="col" class="num">error</th><th scope="col" class="bar">−${ESCALA} · 0 · +${ESCALA}</th>
  <th scope="col" class="num">IC 95%</th></tr></thead>`;

const chip = u => `<span class="chip c-${u}">${{ eje: 'el eje', usa: 'entra', veto: 'veto', no: 'fuera' }[u]}</span>`;

const html = `<title>Qué sirve y qué no</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,500;12..96,700&family=Source+Serif+4:opsz,wght@8..60,400;8..60,600&family=IBM+Plex+Mono:wght@400;500;600&display=swap">
<style>
:root{
  --ground:#F5F7F8; --panel:#FFFFFF; --sunk:#EDF1F3;
  --ink:#141F28; --ink2:#54687A; --ink3:#8496A5;
  --rule:#DBE3E8; --rule2:#C3CFD7;
  --accent:#1B5B70; --accent-soft:#E2EEF2;
  --pos:#2C7A58; --pos-soft:#DEEDE5;
  --neg:#9E4C33; --neg-soft:#F6E5DF;
  --ojo:#856512;
}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){
  --ground:#0D1319; --panel:#141C24; --sunk:#111920;
  --ink:#DDE6ED; --ink2:#93A5B4; --ink3:#647686;
  --rule:#222E39; --rule2:#31404C;
  --accent:#5BA9BF; --accent-soft:#15303A;
  --pos:#57B98A; --pos-soft:#142C22;
  --neg:#DE9077; --neg-soft:#2E1B14;
  --ojo:#CFA23F;
}}
:root[data-theme="dark"]{
  --ground:#0D1319; --panel:#141C24; --sunk:#111920;
  --ink:#DDE6ED; --ink2:#93A5B4; --ink3:#647686;
  --rule:#222E39; --rule2:#31404C;
  --accent:#5BA9BF; --accent-soft:#15303A;
  --pos:#57B98A; --pos-soft:#142C22;
  --neg:#DE9077; --neg-soft:#2E1B14;
  --ojo:#CFA23F;
}
*{box-sizing:border-box}
body{margin:0;background:var(--ground);color:var(--ink);
  font:400 16px/1.62 "Source Serif 4",Georgia,serif;
  -webkit-font-smoothing:antialiased}
.env{max-width:1080px;margin:0 auto;padding:0 20px 96px}
.prosa{max-width:66ch}

/* --- encabezado --- */
header{padding:56px 0 30px;border-bottom:2px solid var(--ink);margin-bottom:34px}
.kicker{font:500 11px/1 "IBM Plex Mono",monospace;letter-spacing:.16em;text-transform:uppercase;
  color:var(--accent);margin-bottom:16px}
h1{font:700 clamp(34px,6vw,58px)/1.02 "Bricolage Grotesque",system-ui,sans-serif;
  letter-spacing:-.025em;margin:0 0 14px;text-wrap:balance}
.bajada{font-size:19px;line-height:1.55;color:var(--ink2);max-width:60ch;margin:0}
.meta{display:flex;flex-wrap:wrap;gap:0 28px;margin-top:24px;
  font:500 12px/1.8 "IBM Plex Mono",monospace;color:var(--ink3)}
.meta b{color:var(--ink);font-weight:600}

/* --- secciones --- */
section{margin:0 0 68px;scroll-margin-top:20px}
h2{font:700 clamp(22px,3.4vw,30px)/1.15 "Bricolage Grotesque",system-ui,sans-serif;
  letter-spacing:-.018em;margin:0 0 6px;text-wrap:balance}
.h2sub{font:500 11px/1 "IBM Plex Mono",monospace;letter-spacing:.14em;text-transform:uppercase;
  color:var(--ink3);margin:0 0 18px}
h3{font:600 17px/1.3 "Bricolage Grotesque",system-ui,sans-serif;margin:34px 0 10px;letter-spacing:-.01em}
p{margin:0 0 15px}
strong{font-weight:600}
em.q{font-style:normal;font-family:"IBM Plex Mono",monospace;font-size:.9em;
  background:var(--sunk);padding:1px 5px;border-radius:3px}

/* --- tablas --- */
.envt{overflow-x:auto;background:var(--panel);border:1px solid var(--rule);border-radius:8px;margin:18px 0}
table{border-collapse:collapse;width:100%;min-width:600px;
  font:500 13.5px/1.4 "IBM Plex Mono",monospace;font-variant-numeric:tabular-nums}
thead th{position:sticky;top:0;background:var(--panel);text-align:left;padding:11px 12px;
  border-bottom:1.5px solid var(--rule2);font:600 10px/1.3 "IBM Plex Mono",monospace;
  letter-spacing:.09em;text-transform:uppercase;color:var(--ink3);white-space:nowrap}
thead th.num{text-align:right}
thead th.bar{text-align:center;min-width:200px}
tbody th{text-align:left;font-weight:500;padding:8px 12px;border-bottom:1px solid var(--rule);
  color:var(--ink);white-space:nowrap;font-family:"Source Serif 4",Georgia,serif;font-size:14.5px}
tbody td{padding:8px 12px;border-bottom:1px solid var(--rule);white-space:nowrap}
tbody tr:last-child th,tbody tr:last-child td{border-bottom:0}
tbody tr:hover th,tbody tr:hover td{background:var(--sunk)}
td.num{text-align:right} td.sec{color:var(--ink3)}
td.pos,.pos{color:var(--pos)} td.neg,.neg{color:var(--neg)}
td.vacio{color:var(--ink3);font-style:italic}
tbody tr.destaca th{font-weight:600}
tbody tr.destaca th::before{content:"";display:inline-block;width:3px;height:13px;
  background:var(--accent);margin-right:8px;vertical-align:-2px;border-radius:2px}

/* --- la barra divergente --- */
td.bar{position:relative;min-width:200px;padding:0 12px}
td.bar .cero{position:absolute;left:50%;top:6px;bottom:6px;width:1px;background:var(--rule2)}
td.bar .fill{position:absolute;top:11px;height:11px;border-radius:2px}
td.bar .fill.pos{background:var(--pos)}
td.bar .fill.neg{background:var(--neg)}

/* --- fichas de veredicto --- */
.rejilla{display:grid;grid-template-columns:repeat(auto-fit,minmax(232px,1fr));gap:12px;margin:20px 0}
.ficha{background:var(--panel);border:1px solid var(--rule);border-radius:8px;padding:14px 15px}
.ficha.entra{border-color:var(--pos);background:var(--pos-soft)}
.ficha .n{font:600 15px/1.25 "Bricolage Grotesque",system-ui,sans-serif;margin-bottom:5px}
.ficha .d{font-size:13.5px;line-height:1.5;color:var(--ink2)}
.ficha .c{font:600 11px/1 "IBM Plex Mono",monospace;color:var(--ink3);margin-top:8px;letter-spacing:.04em}
.chip{display:inline-block;font:600 10px/1 "IBM Plex Mono",monospace;letter-spacing:.08em;
  text-transform:uppercase;padding:4px 7px;border-radius:3px;vertical-align:1px}
.c-eje{background:var(--accent-soft);color:var(--accent)}
.c-usa{background:var(--pos-soft);color:var(--pos)}
.c-veto{background:var(--neg-soft);color:var(--neg)}
.c-no{background:var(--sunk);color:var(--ink3)}

/* --- escalera del modelo --- */
.escalera{display:grid;gap:2px;margin:20px 0;background:var(--rule);border:1px solid var(--rule);border-radius:8px;overflow:hidden}
.peld{display:grid;grid-template-columns:1fr auto auto;gap:18px;align-items:baseline;
  background:var(--panel);padding:13px 16px}
.peld:last-child{background:var(--accent-soft)}
.peld .p{font-size:14.5px}
.peld .v{font:600 15px "IBM Plex Mono",monospace;font-variant-numeric:tabular-nums;min-width:74px;text-align:right}
.peld .v small{display:block;font:500 9.5px/1.4 "IBM Plex Mono",monospace;letter-spacing:.08em;
  text-transform:uppercase;color:var(--ink3)}

/* --- matriz de correlación --- */
.matriz table{min-width:460px;text-align:center}
.matriz td{text-align:center}
.matriz td.alto{background:var(--neg-soft);color:var(--neg);font-weight:600}
.matriz td.diag{color:var(--ink3)}

/* --- nota al pie de sección --- */
.nota{border-left:2px solid var(--rule2);padding:2px 0 2px 15px;margin:18px 0 0;
  font-size:14.5px;line-height:1.6;color:var(--ink2);max-width:64ch}
.nota b{color:var(--ink)}
.aviso{background:var(--panel);border:1px solid var(--rule);border-left:3px solid var(--ojo);
  border-radius:6px;padding:15px 17px;margin:20px 0;max-width:70ch}
.aviso .t{font:600 11px/1 "IBM Plex Mono",monospace;letter-spacing:.1em;text-transform:uppercase;
  color:var(--ojo);margin-bottom:9px}
.aviso p:last-child{margin-bottom:0}
footer{border-top:1px solid var(--rule);padding-top:22px;margin-top:20px;
  font-size:13.5px;line-height:1.65;color:var(--ink3);max-width:70ch}
footer code{font-family:"IBM Plex Mono",monospace;color:var(--ink2)}
@media (prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}
:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
</style>

<div class="env">
<header>
  <div class="kicker">Auditoría del modelo · ${new Date().toISOString().slice(0, 10)}</div>
  <h1>Qué sirve y qué no</h1>
  <p class="bajada">Trece campos de datos medidos uno por uno contra ${P.length.toLocaleString('es-CL')} partidos jugados.
    Cuatro entran al modelo. Nueve no, y acá está por qué.</p>
  <div class="meta">
    <span><b>${P.length.toLocaleString('es-CL')}</b> partidos con WTN en los dos lados</span>
    <span><b>${[...new Set(P.map(f => f.clave))].length}</b> torneos</span>
    <span>validación: <b>dejando un torneo entero afuera</b></span>
  </div>
</header>

<section>
  <h2>El veredicto</h2>
  <p class="h2sub">qué mira el modelo cuando calcula una probabilidad</p>
  <div class="rejilla">
    ${INVENTARIO.filter(x => x.uso !== 'no').map(x => `<div class="ficha entra">
      <div class="n">${esc(x.campo)}</div>
      <div class="d">${esc(x.nota)}</div>
      <div class="c">${x.n.toLocaleString('es-CL')} de ${P.length.toLocaleString('es-CL')} partidos · ${(100 * x.n / P.length).toFixed(0)}%</div>
    </div>`).join('')}
  </div>
  <h3>Lo que se midió y quedó afuera</h3>
  <div class="rejilla">
    ${INVENTARIO.filter(x => x.uso === 'no').map(x => `<div class="ficha">
      <div class="n">${esc(x.campo)}</div>
      <div class="d">${esc(x.nota)}</div>
      <div class="c">${x.n.toLocaleString('es-CL')} partidos · ${(100 * x.n / P.length).toFixed(0)}%</div>
    </div>`).join('')}
  </div>
  <p class="nota"><b>Cobertura no es lo mismo que utilidad.</b> El ranking ITF está en el 46% de los partidos
    y no sirve; el torneo anterior está en el 13% y sí. Un dato que falta seguido igual aporta donde existe,
    porque el modelo sólo lo suma ahí.</p>
</section>

<section>
  <h2>Cada señal, medida sola</h2>
  <p class="h2sub">contra la curva que sólo mira el ΔWTN</p>
  <p class="prosa">A cada señal se le da su mejor oportunidad: se mide únicamente sobre los partidos donde
    ese dato existe, y se compara contra la misma curva corriendo sobre esos mismos partidos.
    La medida es el <em class="q">log-loss</em>, que castiga estar seguro y equivocarse; acá se muestra
    <strong>cuánto lo mejora</strong>, así que más alto es mejor.</p>
  <p class="prosa">Las dos columnas del medio son la pregunta entera. <strong>Sola</strong> es cuánto aporta
    sobre la curva de ΔWTN pelada. <strong>Sobre el núcleo</strong> es cuánto aporta una vez que el escalón
    sub-19 ya está adentro — y esa es la que decide, porque una señal que sólo repite lo que otra ya dijo
    no agrega nada aunque por sí sola se vea bien.</p>
  <div class="envt"><table>
    <thead><tr><th scope="col">señal</th><th scope="col" class="num">n</th>
      <th scope="col" class="num">sola</th><th scope="col" class="num">sobre el núcleo</th>
      <th scope="col" class="num">acierto</th><th scope="col">veredicto</th></tr></thead>
    <tbody>${SENALES.map(s => s.pocos
      ? `<tr><th scope="row">${esc(s.nom)}</th><td class="num">${s.n}</td><td colspan="4" class="vacio">muy pocos datos para medir</td></tr>`
      : `<tr class="${s.sirveN ? 'destaca' : ''}"><th scope="row">${esc(s.nom)}</th>
        <td class="num">${s.n}</td>
        <td class="num ${s.sirve ? 'pos' : 'sec'}">${s.gana >= 0 ? '+' : '−'}${Math.abs(s.gana).toFixed(4)}</td>
        <td class="num ${s.sirveN ? 'pos' : 'neg'}">${s.ganaN >= 0 ? '+' : '−'}${Math.abs(s.ganaN).toFixed(4)}</td>
        <td class="num sec">${(100 * s.ok0).toFixed(1)} → ${(100 * s.ok1).toFixed(1)}%</td>
        <td>${s.sirveN ? '<span class="chip c-usa">entra</span>' : s.sirve ? '<span class="chip c-no">redundante</span>' : '<span class="chip c-no">no</span>'}</td></tr>`).join('')}
    </tbody></table></div>
  <p class="nota"><b>El ATP es el caso interesante.</b> Solo mejora la curva, y por eso durante un tiempo
    lo tuvimos como candidato. Pero sobre el núcleo no mueve nada: no es que sea malo, es que ya lo
    habíamos escuchado. La matriz de correlaciones de más abajo dice de quién es el eco.</p>
  <p class="nota">El coeficiente de los tres rankings sale <b>negativo</b>: el modelo, si los deja entrar,
    aprende que estar mejor rankeado predice perder. Eso no es una señal invertida, es ruido — la única
    lectura honesta es que no tienen nada que agregar sobre lo que el WTN ya dice.</p>
</section>

<section>
  <h2>La edad</h2>
  <p class="h2sub">el hallazgo grande, y no era una pendiente</p>
  <p class="prosa">Veníamos usando la edad como diferencia de años: cuanto más joven el favorito, mejor.
    Pero al mirar la edad <strong>absoluta</strong> de cada lado aparece otra cosa. Contra un rival
    de 18 la curva se equivoca casi 15 puntos; contra uno de 19, no se equivoca en nada.
    El efecto no baja de a poco: se apaga de golpe.</p>
  <h3>Cuánto se equivoca la curva según la edad del rival</h3>
  <div class="envt"><table>${CAB}
    <tbody>${EDAD_ANO.map(x => filaCelda(`rival de ${x.edad} años`, x)).join('')}</tbody></table></div>
  <h3>Y según la edad del favorito</h3>
  <div class="envt"><table>${CAB}
    <tbody>${EDAD_FAV.map(x => filaCelda(`favorito de ${x.edad} años`, x)).join('')}</tbody></table></div>
  <p class="nota">Es la misma historia leída de los dos lados: <b>al sub-19 lo subestimamos, y a nadie más</b>.
    Del lado del favorito el efecto es más chico porque para ser favorito por WTN a los 18 hay que ser
    ya muy bueno, y ahí el rating alcanzó a ponerse al día.</p>
  <h3>Qué forma darle</h3>
  <p class="prosa">Se probaron siete formas de meter la edad al modelo, todas antisimétricas —
    <em class="q">f(favorito) − f(rival)</em> — que es lo único que mantiene la curva pasando por 50%
    cuando los dos lados son iguales.</p>
  <div class="envt"><table>
    <thead><tr><th scope="col">forma</th><th scope="col" class="num">log-loss</th>
      <th scope="col" class="num">acierto</th><th scope="col" class="num">coeficiente</th>
      <th scope="col" class="num">sin ningún junior</th></tr></thead>
    <tbody>
      <tr><th scope="row">sin edad ninguna</th><td class="num sec">${REF_EDAD.ll.toFixed(4)}</td>
        <td class="num sec">${(100 * REF_EDAD.ok).toFixed(1)}%</td><td class="num sec">—</td>
        <td class="num sec">${REF_EDAD_SINJR.ll.toFixed(4)}</td></tr>
      ${FORMAS.map((f, i) => `<tr class="${i === 0 ? 'destaca' : ''}"><th scope="row">${esc(f.nom)}</th>
        <td class="num">${f.ll.toFixed(4)}</td><td class="num sec">${(100 * f.ok).toFixed(1)}%</td>
        <td class="num">${f.coef >= 0 ? '+' : '−'}${Math.abs(f.coef).toFixed(3)}</td>
        <td class="num sec">${f.llSinJr.toFixed(4)}</td></tr>`).join('')}
    </tbody></table></div>
  <p class="nota">La última columna contesta la sospecha obvia: <b>no es el efecto junior con otro nombre</b>.
    Sacando todo partido que tenga un JR en cancha, el escalón sigue valiendo casi lo mismo
    (${FORMAS[0].llSinJr.toFixed(4)}, coeficiente ${FORMAS[0].coefSinJr >= 0 ? '+' : '−'}${Math.abs(FORMAS[0].coefSinJr).toFixed(3)}).
    Y agregarle una pendiente lineal encima no aporta nada: de los 19 para arriba, la edad deja de decir algo.</p>
  <h3>Dónde pesa más</h3>
  <div class="envt"><table>
    <thead><tr><th scope="col">ronda</th>
      ${CRUCE_RONDA[0].celdas.map(c => `<th scope="col" class="num">${esc(c.nom)}</th>`).join('')}</tr></thead>
    <tbody>${CRUCE_RONDA.map(f => `<tr><th scope="row">${esc(f.fila)}</th>
      ${f.celdas.map(c => c.n ? `<td class="num ${c.dif >= 0 ? 'pos' : 'neg'}">${pts(c.dif)} <span class="sec">(${c.n})</span></td>` : '<td class="num sec">—</td>').join('')}</tr>`).join('')}
    </tbody></table></div>
  <div class="envt"><table>
    <thead><tr><th scope="col">distancia de WTN</th>
      ${CRUCE_DELTA[0].celdas.map(c => `<th scope="col" class="num">${esc(c.nom)}</th>`).join('')}</tr></thead>
    <tbody>${CRUCE_DELTA.map(f => `<tr><th scope="row">${esc(f.fila)}</th>
      ${f.celdas.map(c => c.n ? `<td class="num ${c.dif >= 0 ? 'pos' : 'neg'}">${pts(c.dif)} <span class="sec">(${c.n})</span></td>` : '<td class="num sec">—</td>').join('')}</tr>`).join('')}
    </tbody></table></div>
</section>

<section>
  <h2>Las otras dos que entran</h2>
  <p class="h2sub">forma dentro del cuadro y de dónde viene</p>
  <h3>Games cedidos hasta llegar acá</h3>
  <div class="envt"><table>${CAB}<tbody>${FORMA_BANDAS.map(x => filaCelda(x.nom, x)).join('')}</tbody></table></div>
  <p class="nota">Monótona de punta a punta y con la muestra bien repartida: es la señal más limpia
    después de la edad. La última fila —los partidos donde alguno de los dos todavía no jugó— confirma
    que el dato faltante no está sesgado: ahí la curva acierta.</p>
  <h3>Hasta qué ronda llegó en su torneo anterior</h3>
  <div class="envt"><table>${CAB}<tbody>${PREVIO_BANDAS.map(x => filaCelda(x.nom, x)).join('')}</tbody></table></div>
  <p class="nota">Mismo orden, muestras chicas. Aporta poco y por eso su coeficiente es chico,
    pero apunta en la dirección correcta en las cuatro bandas.</p>
</section>

<section>
  <h2>Las que no sirven, y por qué</h2>
  <p class="h2sub">nueve campos que miramos y no usamos</p>
  <h3>Los rankings dicen lo mismo que el WTN</h3>
  <p class="prosa">La razón no es que sean malos, es que son <strong>redundantes</strong>. El ΔATP
    correlaciona 0.58 con el ΔWTN sobre los partidos donde los dos existen: mide lo mismo, con un
    tercio de los datos.</p>
  <div class="envt matriz"><table>
    <thead><tr><th scope="col"></th>${EJES.map(e => `<th scope="col" class="num">${esc(e[0])}</th>`).join('')}</tr></thead>
    <tbody>${CORREL.map((f, i) => `<tr><th scope="row">${esc(f.eje)}</th>
      ${f.fila.map((r, j) => r == null ? '<td class="sec">—</td>'
        : `<td class="${i === j ? 'diag' : Math.abs(r) >= 0.5 ? 'alto' : ''}">${r.toFixed(2)}</td>`).join('')}</tr>`).join('')}
    </tbody></table></div>
  <p class="nota">Acá hay una <b>corrección a lo que dije ayer</b>: había explicado la caída del ATP diciendo
    que "estaba diciendo joven que sube, y la edad lo dice mejor". La matriz muestra que no: el ΔATP
    correlaciona apenas −0.08 con el escalón sub-19. Lo que lo vuelve prescindible es su 0.58 con el WTN,
    no la edad.</p>
  <h3>La siembra</h3>
  <div class="envt"><table>${CAB}<tbody>${SIEMBRA_BANDAS.map(x => filaCelda(x.nom, x)).join('')}</tbody></table></div>
  <p class="nota">Ordenada pero floja: el sembrado gana ${pts(SIEMBRA_BANDAS[0].dif)} puntos sobre lo esperado
    con ${SIEMBRA_BANDAS[0].n} partidos. Entraba al modelo con un coeficiente muy chico y, con el escalón
    sub-19 adentro, dejó de aportar del todo. Salió.</p>
  <h3>Cómo entró el rival al cuadro</h3>
  <div class="envt"><table>${CAB}<tbody>${ENTRADA_BANDAS.map(x => filaCelda(x.nom, x)).join('')}</tbody></table></div>
  <p class="nota">El único que dice algo es el <b>invitado</b>: rinde sobre lo que la curva espera, que es
    lo razonable —los wildcards suelen ser locales jóvenes o promesas cuyo rating va atrás. Pero metido al
    modelo no mueve el log-loss, así que se queda como dato a la vista y no como término.</p>
  <h3>El contexto del torneo</h3>
  <div class="envt"><table>${CAB}<tbody>${CONTEXTO.map(x => filaCelda(x.nom, x)).join('')}</tbody></table></div>
  <p class="nota">Nada. Ni la categoría, ni la superficie, ni que los dos sean del mismo país.
    Todas las diferencias caben dentro del ruido y ninguna barra se despega del cero.</p>
</section>

<section>
  <h2>El modelo que queda</h2>
  <p class="h2sub">tres peldaños, cada uno validado dejando un torneo afuera</p>
  <div class="escalera">
    ${ESCALERA.map(e => `<div class="peld">
      <span class="p">${esc(e.paso)}</span>
      <span class="v">${e.ll.toFixed(4)}<small>log-loss</small></span>
      <span class="v">${(100 * e.ok).toFixed(1)}%<small>acierto</small></span></div>`).join('')}
  </div>
  <div class="envt"><table>
    <thead><tr><th scope="col">término</th><th scope="col" class="num">coeficiente</th>
      <th scope="col" class="num">n</th><th scope="col">qué mide</th></tr></thead>
    <tbody>
      ${['Q1', 'buenas', 'medias', 'finales'].map((g, i) => `<tr><th scope="row">ΔWTN · ${g}</th>
        <td class="num">+${MODELO_FINAL.b[i].toFixed(4)}</td>
        <td class="num sec">${SIN_JR.filter(f => f.grupo === g).length}</td>
        <td>${{ Q1: 'primera ronda de la clasificación', buenas: 'Q2 y R1 — el mejor terreno que tenemos',
          medias: 'Q3, R2 y R3', finales: 'cuartos, semis y final' }[g]}</td></tr>`).join('')}
      <tr class="destaca"><th scope="row">escalón sub-19</th>
        <td class="num">+${MODELO_FINAL.b[4].toFixed(4)}</td>
        <td class="num sec">${SIN_JR.filter(f => sub18(f) !== 0).length}</td>
        <td>uno tiene 18 o menos y el otro no</td></tr>
      ${COND.map(([n]) => `<tr><th scope="row">${esc(n)}</th>
        <td class="num">+${MODELO_FINAL.cc[n].toFixed(4)}</td>
        <td class="num sec">${SIN_JR.filter(f => (n === 'games cedidos' ? f.dCed : f.dPrev) != null).length}</td>
        <td>${n === 'games cedidos' ? 'fracción de games cedidos: rival menos favorito' : 'ronda alcanzada la semana pasada'}</td></tr>`).join('')}
    </tbody></table></div>
  <p class="nota">El escalón sub-19 vale <b>${MODELO_FINAL.b[4].toFixed(2)} en escala logit</b>, que es mucho:
    convierte un 90% en un 65%. Es un solo bit de información —tiene 18 o no— pero es el bit que más
    corrige al WTN en todo el circuito.</p>
</section>

<section>
  <h2>Lo que todavía no sabemos</h2>
  <p class="h2sub">los límites de esta medición</p>
  <div class="aviso">
    <div class="t">Sobre la regla de mercado</div>
    <p>Todo lo de esta página se midió sobre ${P.length.toLocaleString('es-CL')} partidos. La regla que
      decide <em class="q">segura</em> contra <em class="q">trampa</em> —no discrepar más de 12 puntos con
      el precio— se midió sobre <strong>52</strong>, que son los únicos que tienen cuota y resultado.
      Entre dos mediciones seguidas, las bandas de discrepancia se movieron harto: el tramo de +5 a +15
      pasó de 89% a 76% de acierto. Con 7 a 21 partidos por casilla eso es lo esperable.</p>
    <p>Lo que se sostiene entre las dos mediciones es el <strong>signo</strong>: el criterio viejo
      (valor ≥ 9%) perdió plata las dos veces, y el nuevo no. El umbral exacto hay que volver a medirlo
      cuando el registro esté al doble.</p>
  </div>
  <div class="aviso">
    <div class="t">Sobre las muestras chicas</div>
    <p>El torneo anterior se apoya en 164 partidos y el ranking junior en 9. Los dos entran igual, uno
      como término chico y el otro como veto, porque apuntan en la dirección correcta en todas sus bandas
      — pero son las dos primeras piezas que hay que remedir cuando entren datos nuevos.</p>
  </div>
  <div class="aviso">
    <div class="t">Sobre lo que ni siquiera está en la mesa</div>
    <p>No tenemos historial cara a cara, ni sets ganados y perdidos más allá del torneo en curso, ni nada
      sobre lesiones, viajes o cambio de superficie entre semanas. Ninguna de esas ausencias está medida:
      no sé si aportarían. Sé que las que sí pude medir están todas acá.</p>
  </div>
</section>

<footer>
  <p>Todos los números salen de correr <code>node vigia/itf-banco.mjs &amp;&amp; node vigia/itf-auditoria.mjs</code>
  sobre los cuadros y entry lists que tenemos bajados. Nada está escrito a mano en esta página.</p>
  <p><strong>Cómo leer la barra:</strong> mide cuántos puntos porcentuales se equivocó la curva de ΔWTN en ese
  grupo de partidos. A la derecha del cero, el favorito ganó más de lo que la curva esperaba; a la izquierda,
  menos. Media barra son ${ESCALA} puntos.</p>
  <p><strong>Log-loss:</strong> castiga estar seguro y errar. Decir 95% y perder cuesta mucho más que decir 60% y perder.
  Por eso es mejor medida que el acierto pelado cuando lo que se compara son probabilidades contra un precio.</p>
</footer>
</div>`;

fs.writeFileSync(path.join(DIR, 'itf-auditoria.html'), html);
console.log(`✓ vigia/itf-auditoria.html · ${P.length} partidos · ${SENALES.filter(s => s.sirveN).length} señales entran de ${SENALES.filter(s => !s.pocos).length} medidas`);
for (const e of ESCALERA) console.log(`  ${e.paso.padEnd(40)} log-loss ${e.ll.toFixed(4)}  acierto ${(100 * e.ok).toFixed(1)}%`);
