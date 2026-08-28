#!/usr/bin/env node
/* ============================================================
   ITF-DECANTADOR — dentro de cada tramo de cuota, qué criterios mandan.

   Pedido por Sebastián el 2026-08-26, cerrando el acuerdo de tramos:
   "¿podremos ver dentro de los rangos favoritos reales y donde no hay
   claridad, qué criterios mandan e ir decantando? La idea es poder
   tomar decisiones informadas."

   La unidad de medida es siempre EL FAVORITO DEL MERCADO (la cuota más
   baja del partido): cada criterio parte el tramo en dos y se mira si el
   favorito ganó más de un lado que del otro. Con los n chicos que hay,
   el intervalo (Wilson 95%) va al lado de cada celda: dos celdas cuyos
   intervalos se pisan NO están separadas, por mucho que los porcentajes
   se vean distintos.

   De dónde salen los partidos:
     · la base: el registro de la era PDF (Betano), cruzado con el banco
       de señales — se rearma con --rearmar y queda en
       datos/itf/decantador-base.json;
     · lo que se acumula: los veredictos diarios calificados
       (veredictos-historia.json), que desde hoy guardan su `crit` con
       los mismos campos. Cada día calificado afina estas celdas solo.

   Uso:  node vigia/itf-decantador.mjs             → tabla en consola
         node vigia/itf-decantador.mjs --rearmar   → rearma la base
   ============================================================ */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const DATOS = path.join(DIR, 'datos', 'itf');
const BASE = path.join(DATOS, 'decantador-base.json');
const leer = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')) } catch { return null } };

/* ---------- los tramos del acuerdo ---------- */
export const TRAMOS = [
  { clave: 'tramite', texto: 'TRÁMITE — bajo 1.20', de: 0, a: 1.20 },
  { clave: 'reales', texto: 'FAVORITOS REALES — 1.20 a 1.39', de: 1.20, a: 1.40 },
  { clave: 'analisis', texto: 'ZONA DE ANÁLISIS — 1.40 a 1.99', de: 1.40, a: 2.00 },
];

/* ---------- los criterios que se están decantando ----------
   Cada uno parte el tramo en dos ("sí" / "no"); null = el partido no
   entra en ninguna de las dos (dato desconocido). Todos van orientados
   al favorito del mercado (fm). */
export const CRITERIOS = [
  { clave: 'respaldo', texto: 'nuestro modelo le da 70% o más',
    si: c => c.pFm >= 0.70, no: c => c.pFm < 0.70 },
  { clave: 'acuerdo', texto: 'rating y precio de acuerdo (también es mejor por WTN)',
    si: c => c.acuerdo, no: c => !c.acuerdo },
  /* El Elo propio (itf-rating). OJO: solo se llena desde los días vivos —
     para el registro viejo sería mirar la respuesta (el Elo de hoy ya vio
     esos resultados), así que ahí queda vacío y las celdas crecen solas. */
  { clave: 'elo', texto: 'nuestro ranking (Elo) también lo da favorito',
    si: c => c.dElo != null && c.dElo > 0, no: c => c.dElo != null && c.dElo < 0 },
  { clave: 'wtn2', texto: 'ventaja WTN de 2 o más',
    si: c => c.dW != null && c.dW >= 2, no: c => c.dW != null && c.dW < 2 },
  { clave: 'forma', texto: 'forma conocida y a favor (games cedidos en este cuadro)',
    si: c => c.forma != null && c.forma >= 0, no: c => c.forma != null && c.forma < 0 },
  { clave: 'sub19', texto: 'el rival tiene 18 o menos',
    si: c => c.edadRi != null && c.edadRi <= 18, no: c => c.edadRi != null && c.edadRi > 18 },
  { clave: 'ronda', texto: 'ronda temprana (qualy o primeras)',
    si: c => c.grupo === 'Q1' || c.grupo === 'buenas', no: c => c.grupo === 'medias' || c.grupo === 'finales' },
  { clave: 'edad', texto: 'mayor que el rival',
    si: c => c.edadFm != null && c.edadRi != null && c.edadFm > c.edadRi,
    no: c => c.edadFm != null && c.edadRi != null && c.edadFm < c.edadRi },
];

export const wilson = (k, n) => {
  if (!n) return null;
  const z = 1.96, p = k / n, d = 1 + z * z / n;
  const c = (p + z * z / (2 * n)) / d, m = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d;
  return [Math.max(0, c - m), Math.min(1, c + m)];
};

/* ---------- juntar base + historia calificada ---------- */
export function cargar() {
  const filas = (leer(BASE)?.partidos || []).map(c => ({ ...c, origen: 'registro' }));
  const hist = leer(path.join(DATOS, 'veredictos-historia.json'));
  const vistos = new Set();   /* un fixture cuenta UNA vez, aunque figure en dos días */
  for (const [dia, arr] of Object.entries(hist?.dias || {}).sort()) for (const v of arr) {
    if (!v.crit || !v.res || v.acerto == null || v.cuotaSospechosa) continue;
    if (v.fixtureId) { if (vistos.has(v.fixtureId)) continue; vistos.add(v.fixtureId); }
    const ganoLado = v.acerto ? v.lado : 3 - v.lado;
    filas.push({ ...v.crit, gano: v.crit.ladoFm === ganoLado, origen: 'dia ' + dia });
  }
  return filas;
}

/* celdas por tramo: para cada criterio, cómo le fue al favorito del
   mercado con el criterio a favor ("si") y en contra ("no") */
export function celdas(filas) {
  const out = [];
  for (const t of TRAMOS) {
    const T = filas.filter(c => c.cuota >= t.de && c.cuota < t.a);
    const base = { k: T.filter(c => c.gano).length, n: T.length };
    const crit = CRITERIOS.map(cr => {
      const lado = g => {
        const a = T.filter(g);
        if (!a.length) return null;
        const k = a.filter(c => c.gano).length;
        const rinde = a.reduce((s, c) => s + (c.gano ? c.cuota - 1 : -1), 0) / a.length;
        return { k, n: a.length, pct: k / a.length, ic: wilson(k, a.length), rinde };
      };
      return { clave: cr.clave, texto: cr.texto, si: lado(cr.si), no: lado(cr.no) };
    });
    out.push({ ...t, base, crit });
  }
  return out;
}

/* ¿el criterio separa DE VERDAD? solo si los intervalos no se pisan */
export const separa = c => c.si && c.no && (c.si.ic[0] > c.no.ic[1] || c.no.ic[0] > c.si.ic[1]);

/* ---------- rearmar la base desde el registro de la era PDF ---------- */
async function rearmar() {
  const A = await import('./itf-ajuste.mjs');
  const R = leer(path.join(DIR, 'itf-resultados.json'));
  const N = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z ]/g, ' ').replace(/\s+/g, ' ').trim();
  const tok = s => new Set(N(s).split(' ').filter(x => x.length >= 3));
  const calza = (a, c) => { const X = tok(a), Y = tok(c); if (!X.size || !Y.size) return false; let z = 0; for (const x of X) if (Y.has(x)) z++; return z >= Math.min(X.size, Y.size) };

  /* el mismo modelo del informe, ajustado en el banco (núcleo + condicionales) */
  const sub18 = f => (f.edadFa <= 18 ? 1 : 0) - (f.edadRi <= 18 ? 1 : 0);
  const NUC = [...A.COLS_BASE, sub18];
  const SIN_JR = A.P.filter(f => !f.dJrElite);
  const b = A.fit(SIN_JR, NUC), e0 = f => NUC.reduce((s, c, i) => s + b[i] * c(f), 0);
  const cc = {};
  for (const [n, g] of [['dCed', f => f.dCed], ['dPrev', f => f.dPrev]]) {
    const sub = SIN_JR.filter(f => g(f) != null && Number.isFinite(g(f)));
    let z = 0;
    for (let it = 0; it < 50; it++) {
      let gr = 0, H = 0;
      for (const f of sub) { const x = g(f), p = A.sig(e0(f) + z * x), w = p * (1 - p); gr += ((f.gano ? 1 : 0) - p) * x; H += w * x * x }
      if (H < 1e-12) break; const d = gr / H; z += d; if (Math.abs(d) < 1e-10) break;
    }
    cc[n] = z;
  }
  const pModelo = f => A.sig(e0(f) + (f.dCed != null ? cc.dCed * f.dCed : 0) + (f.dPrev != null ? cc.dPrev * f.dPrev : 0));

  const partidos = [];
  for (const r of R.registro) {
    if (r.gano == null) continue;
    const n1 = r.lados?.[0]?.nombre, n2 = r.lados?.[1]?.nombre; if (!n1 || !n2) continue;
    const c1 = r.lados[0]?.gana, c2 = r.lados[1]?.gana; if (!c1 || !c2) continue;
    const f = A.P.find(x => (calza(x.fa.nombre, n1) && calza(x.ri.nombre, n2)) || (calza(x.fa.nombre, n2) && calza(x.ri.nombre, n1)));
    if (!f) continue;
    const i = calza(f.fa.nombre, n1) ? 0 : 1;          /* lado del registro que es el mejor por WTN */
    const ladoFm = c1 <= c2 ? 1 : 2;
    const acuerdo = (ladoFm - 1) === i;                /* favorito del mercado == mejor por WTN */
    const s = acuerdo ? 1 : -1;
    const pM = pModelo(f);
    partidos.push({
      cuota: ladoFm === 1 ? c1 : c2,
      gano: acuerdo ? f.gano : !f.gano,
      ladoFm,
      pFm: +(acuerdo ? pM : 1 - pM).toFixed(3),
      acuerdo,
      dW: +(s * f.dW).toFixed(2),
      forma: f.dCed == null ? null : Math.sign(s * f.dCed),
      previo: f.dPrev == null ? null : Math.sign(s * f.dPrev),
      grupo: f.grupo,
      edadFm: acuerdo ? f.edadFa : f.edadRi,
      edadRi: acuerdo ? f.edadRi : f.edadFa,
    });
  }
  fs.writeFileSync(BASE, JSON.stringify({
    nota: 'Base del decantador: registro de la era PDF cruzado con el banco. Se rearma con itf-decantador.mjs --rearmar.',
    generado: new Date().toISOString(), partidos }, null, 1));
  console.log(partidos.length + ' partidos con precio, resultado y ficha → ' + BASE);
}

/* ---------- CLI ---------- */
if (process.argv[1] && import.meta.url === 'file://' + process.argv[1].replace(/\\/g, '/')) {
  if (process.argv.includes('--rearmar')) await rearmar();
  const filas = cargar();
  const deHoy = filas.filter(c => c.origen !== 'registro').length;
  console.log(`${filas.length} partidos calificados (${filas.length - deHoy} del registro + ${deHoy} de los días)\n`);
  const pc = x => (100 * x).toFixed(0) + '%';
  for (const t of celdas(filas)) {
    console.log(`══ ${t.texto} · el favorito del mercado gana ${t.base.n ? pc(t.base.k / t.base.n) : '—'} (${t.base.k}/${t.base.n}) ══`);
    for (const c of t.crit) {
      const lado = (nom, l) => console.log('   ' + nom + ' ' + c.texto.padEnd(52)
        + (l ? `${String(l.k).padStart(3)}/${String(l.n).padEnd(3)} ${pc(l.pct).padStart(4)}  IC ${pc(l.ic[0])}–${pc(l.ic[1])}` : '  —'));
      lado('SÍ', c.si); lado('NO', c.no);
      if (separa(c)) console.log('       ↑ este criterio SEPARA (los intervalos no se pisan)');
    }
    console.log('');
  }
}
