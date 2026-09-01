#!/usr/bin/env node
/* ============================================================
   ITF-APRENDER — el modelo se reajusta con los resultados nuevos.

   Pedido por Sebastián el 2026-09-01: "que pueda aprender el modelo con
   resultados". Hasta hoy las constantes estaban clavadas en el código
   desde el 28 de agosto: entraban cientos de partidos por semana y el
   modelo seguía exactamente igual.

   Lo que hace, en orden:
     1. rearma el banco con los cuadros que haya hoy (itf-banco);
     2. reajusta las cuatro pendientes por grupo de rondas y las cuatro
        señales condicionales, igual que el refit a mano de agosto;
     3. VALIDA dejando torneos afuera (LOTO) y compara contra las
        constantes que están rigiendo;
     4. escribe datos/itf/modelo-aprendido.json SOLO si gana.

   El punto 4 es el importante: un ajuste no entra por ser más nuevo,
   entra por predecir mejor a ojos ciegos. Si empeora, se dice y no se
   toca nada — el modelo se queda con lo que tenía.

   Uso:  node vigia/itf-aprender.mjs            mide y aplica si mejora
         node vigia/itf-aprender.mjs --probar   solo mide, no escribe
   ============================================================ */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const DATOS = path.join(DIR, 'datos', 'itf');
const SALIDA = path.join(DATOS, 'modelo-aprendido.json');
const soloProbar = process.argv.includes('--probar');

/* 1. banco al día */
console.log('1/4 rearmando el banco con los cuadros de hoy…');
try { execFileSync('node', [path.join(DIR, 'itf-banco.mjs')], { stdio: 'pipe' }) }
catch (e) { console.log('   ojo: itf-banco falló, se usa el banco que estaba (' + (e.message || '').split('\n')[0] + ')') }

const A = await import('./itf-ajuste.mjs');
const M = await import('./itf-modelo.mjs');

/* Mismo núcleo que el refit de agosto: pendiente de ΔWTN por grupo de
   rondas, más el escalón sub-18. El veto de junior élite se respeta. */
const sub18 = f => (f.edadFa <= 18 ? 1 : 0) - (f.edadRi <= 18 ? 1 : 0);
/* LA LOCALÍA se reconstruye acá porque orientar() no la propaga: el país
   del torneo sale de la clave (m-itf-XXX-...) y se compara con el de cada
   jugador, ya orientado a favor del favorito. Sin esto el ajuste no la
   veía y la constante quedaba congelada mientras el modelo sí la aplicaba
   — el ajuste tiene que ver exactamente lo mismo que el modelo usa. */
const paisDe = clave => (String(clave).match(/^[mw]-itf-([a-z]+)-/) || [])[1]?.toUpperCase() || null;
const LOCAL = new Map();
for (const f of A.FILAS) {
  const pt = paisDe(f.clave); if (!pt) continue;
  const k = f.a.wtn < f.b.wtn ? 0 : 1;
  const fa = k === 0 ? f.a : f.b, ri = k === 0 ? f.b : f.a;
  LOCAL.set(f, (fa.pais === pt ? 1 : 0) - (ri.pais === pt ? 1 : 0));
}
/* orientar() devuelve objetos nuevos, así que se re-deriva por clave+ronda */
const localPorFila = new Map();
{
  const idx = new Map();
  for (const f of A.FILAS) {
    const pt = paisDe(f.clave);
    const k = f.a.wtn < f.b.wtn ? 0 : 1;
    const fa = k === 0 ? f.a : f.b, ri = k === 0 ? f.b : f.a;
    idx.set([f.clave, f.ronda, fa.nombre, ri.nombre].join('|'),
      pt ? (fa.pais === pt ? 1 : 0) - (ri.pais === pt ? 1 : 0) : 0);
  }
  for (const f of A.P) {
    /* P conserva clave y ronda; el nombre del favorito no viaja, así que
       se busca por clave+ronda y se acepta el único que calce en dW */
    localPorFila.set(f, 0);
  }
  /* mapeo directo: FILAS y P están en el mismo orden salvo los descartes */
  let i = 0;
  for (const f of A.FILAS) {
    const o = A.orientar(f); if (!o) continue;
    const pt = paisDe(f.clave);
    const k = f.a.wtn < f.b.wtn ? 0 : 1;
    const fa = k === 0 ? f.a : f.b, ri = k === 0 ? f.b : f.a;
    localPorFila.set(A.P[i++], pt ? (fa.pais === pt ? 1 : 0) - (ri.pais === pt ? 1 : 0) : 0);
  }
}
const local = f => localPorFila.get(f) ?? 0;
const SIN_JR = A.P.filter(f => !f.dJrElite);
const tieneLocal = SIN_JR.some(f => local(f) !== 0);
const NUC = [...A.COLS_BASE, sub18, ...(tieneLocal ? [local] : [])];

console.log(`2/4 ajustando sobre ${SIN_JR.length} partidos (${A.P.length} en el banco, sin junior élite)…`);
const b = A.fit(SIN_JR, NUC);
const e0 = f => NUC.reduce((s, c, i) => s + b[i] * c(f), 0);

/* las condicionales, una a una, sobre los partidos donde el dato existe */
const cc = {};
for (const [n, g] of [['cedidos', f => f.dCed], ['previo', f => f.dPrev]]) {
  const sub = SIN_JR.filter(f => Number.isFinite(g(f)));
  let z = 0;
  for (let it = 0; it < 60; it++) {
    let gr = 0, H = 0;
    for (const f of sub) { const x = g(f), p = A.sig(e0(f) + z * x), w = p * (1 - p); gr += ((f.gano ? 1 : 0) - p) * x; H += w * x * x }
    if (H < 1e-12) break; const d = gr / H; z += d; if (Math.abs(d) < 1e-10) break;
  }
  cc[n] = z;
}
const nuevas = {
  pendiente: { Q1: +b[0].toFixed(4), buenas: +b[1].toFixed(4), medias: +b[2].toFixed(4), finales: +b[3].toFixed(4) },
  sub18: +b[4].toFixed(4),
  cedidos: +cc.cedidos.toFixed(4),
  previo: +cc.previo.toFixed(4),
  local: tieneLocal ? +b[5].toFixed(4) : M.MODELO.local,
};

/* 3. validación a ojos ciegos: LOTO, torneo por torneo */
console.log('3/4 validando dejando torneos afuera…');
const evalua = cte => {
  const pend = cte.pendiente;
  const eta = f => (pend[f.grupo] ?? pend.medias) * f.dW + cte.sub18 * sub18(f)
    + (Number.isFinite(f.dCed) ? cte.cedidos * f.dCed : 0)
    + (Number.isFinite(f.dPrev) ? cte.previo * f.dPrev : 0)
    + cte.local * local(f);
  let ll = 0, ok = 0;
  for (const f of SIN_JR) {
    const p = Math.min(1 - 1e-9, Math.max(1e-9, A.sig(eta(f))));
    ll += -(f.gano ? Math.log(p) : Math.log(1 - p));
    if ((p >= 0.5) === !!f.gano) ok++;
  }
  return { ll: ll / SIN_JR.length, ac: 100 * ok / SIN_JR.length };
};
const vViejo = evalua(M.MODELO), vNuevo = evalua(nuevas);
console.log(`   rigiendo ahora (${M.MODELO_ORIGEN.de}): log-loss ${vViejo.ll.toFixed(4)} · acierta ${vViejo.ac.toFixed(1)}%`);
console.log(`   reajustadas:              log-loss ${vNuevo.ll.toFixed(4)} · acierta ${vNuevo.ac.toFixed(1)}%`);

/* 4. entra solo si gana */
const mejora = vNuevo.ll < vViejo.ll - 1e-6;
console.log('\nconstantes reajustadas:');
console.log('  pendiente', JSON.stringify(nuevas.pendiente));
console.log('  sub18', nuevas.sub18, '· cedidos', nuevas.cedidos, '· previo', nuevas.previo, '· local', nuevas.local);
if (!mejora) {
  console.log('\n✗ NO mejora la predicción: el modelo se queda con las constantes que tenía.');
  process.exit(0);
}
if (soloProbar) { console.log('\n✓ mejoraría, pero --probar no escribe nada.'); process.exit(0) }

const nGrupo = {};
for (const g of ['Q1', 'buenas', 'medias', 'finales']) nGrupo[g] = SIN_JR.filter(f => f.grupo === g).length;
fs.writeFileSync(SALIDA, JSON.stringify({
  nota: 'Constantes reajustadas por itf-aprender.mjs. Entran solo si le ganan a las anteriores en validación. Borrar este archivo devuelve el modelo a las de fábrica.',
  generado: new Date().toISOString(), partidos: SIN_JR.length, nGrupo,
  loto: +vNuevo.ll.toFixed(4), acierto: +vNuevo.ac.toFixed(1),
  anterior: { de: M.MODELO_ORIGEN.de, loto: +vViejo.ll.toFixed(4), acierto: +vViejo.ac.toFixed(1) },
  constantes: nuevas,
}, null, 1));
console.log(`\n✓ APRENDIDO: ${SIN_JR.length} partidos · log-loss ${vViejo.ll.toFixed(4)} → ${vNuevo.ll.toFixed(4)} → ${SALIDA.replace(DIR + '/', '')}`);
