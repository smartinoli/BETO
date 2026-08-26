/* ============================================================
   ITF-AJUSTE — orientar, ajustar y validar.

   Herramientas compartidas por itf-auditoria.mjs y por cualquier medicion
   nueva: orienta cada partido (favorito = mejor WTN, todas las señales
   como diferencia a su favor), ajusta una logistica SIN CONSTANTE por
   Newton-Raphson, y valida dejando un torneo afuera.

   Sin constante a proposito: con las dos señales en cero no hay favorito,
   asi que la curva tiene que dar 50%.
   ============================================================ */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const DIR = path.dirname(fileURLToPath(import.meta.url));
export const FILAS = JSON.parse(fs.readFileSync(path.join(DIR,'datos','itf','_auditoria.json'),'utf8'));
export const sig = x => 1/(1+Math.exp(-x));
export const GRUPO = { Q1:'Q1', Q2:'buenas', R1:'buenas', Q3:'medias', R2:'medias', R3:'medias', QF:'finales', SF:'finales', F:'finales' };
const edad = p => p.nacido!=null ? 2026-p.nacido : null;
const lg = v => v!=null && v>0 ? Math.log(v) : null;
/* orden de "cuánto le costó entrar": directo > clasificado > lucky loser / invitado */
const PESO_ENTRADA = { DA:0, SE:0, PR:0, Q:1, LL:-1, WC:-1, A:0 };

/* Orienta cada partido: fav = el de MEJOR WTN. Todas las senales quedan
   como (rival - favorito) con signo "a favor del favorito". */
export function orientar(f) {
  if (f.a.wtn==null || f.b.wtn==null || f.a.wtn===f.b.wtn) return null;
  const k = f.a.wtn < f.b.wtn ? 0 : 1;
  const fa = k===0 ? f.a : f.b, ri = k===0 ? f.b : f.a;
  const dif = (x,y) => x!=null && y!=null ? x-y : null;
  const cedFa = fa.forma?.ced ?? null, cedRi = ri.forma?.ced ?? null;
  return {
    clave:f.clave, ronda:f.ronda, grupo:GRUPO[f.ronda]||'medias', cat:f.cat, sup:f.sup,
    gano: (k===0) === f.gano0,
    dW: ri.wtn - fa.wtn,
    dAtp: dif(lg(ri.atp), lg(fa.atp)),
    dItf: dif(lg(ri.itf), lg(fa.itf)),
    dNac: dif(lg(ri.nac), lg(fa.nac)),
    dEdad: dif(edad(fa), edad(ri)),
    dPrev: dif(fa.previo, ri.previo),
    dCed: dif(cedRi, cedFa),
    dSeed: (fa.seed?1:0) - (ri.seed?1:0),
    dJrElite: ((ri.jr && ri.jrRank!=null && ri.jrRank<=60) ? -1 : 0) + ((fa.jr && fa.jrRank!=null && fa.jrRank<=60) ? 1 : 0),
    jrRivalIncog: (ri.jr && ri.jrRank==null) ? 1 : 0,
    /* señales nuevas para auditar */
    edadFa: edad(fa), edadRi: edad(ri),
    dEntrada: (PESO_ENTRADA[fa.entrada] ?? 0) - (PESO_ENTRADA[ri.entrada] ?? 0),
    entradaFa: fa.entrada, entradaRi: ri.entrada,
    dPZ: ((fa.wtnVisible === false) ? 1 : 0) - ((ri.wtnVisible === false) ? 1 : 0),
    mismoPais: fa.pais && ri.pais ? (fa.pais === ri.pais ? 1 : 0) : null,
    fa, ri,
  };
}
export const P = FILAS.map(orientar).filter(Boolean);

/* --- logistica sin constante, Newton-Raphson --- */
export function fit(filas, cols, iter=40) {
  const n = cols.length; let b = new Array(n).fill(0);
  for (let it=0; it<iter; it++) {
    const g = new Array(n).fill(0);
    const H = Array.from({length:n},()=>new Array(n).fill(0));
    for (const f of filas) {
      const x = cols.map(c=>c(f));
      let eta=0; for (let i=0;i<n;i++) eta += b[i]*x[i];
      const p = sig(eta), w = p*(1-p), r = (f.gano?1:0) - p;
      for (let i=0;i<n;i++) { g[i] += r*x[i];
        for (let j=0;j<n;j++) H[i][j] += w*x[i]*x[j]; }
    }
    for (let i=0;i<n;i++) H[i][i] += 1e-6;   /* ridge minimo: evita singular */
    const d = resolver(H, g); if (!d) break;
    let mx=0; for (let i=0;i<n;i++) { b[i]+=d[i]; mx=Math.max(mx,Math.abs(d[i])) }
    if (mx < 1e-9) break;
  }
  return b;
}
function resolver(A0, v0) {
  const n=v0.length, A=A0.map(r=>r.slice()), v=v0.slice();
  for (let i=0;i<n;i++) {
    let p=i; for (let r=i+1;r<n;r++) if (Math.abs(A[r][i])>Math.abs(A[p][i])) p=r;
    if (Math.abs(A[p][i])<1e-12) return null;
    [A[i],A[p]]=[A[p],A[i]]; [v[i],v[p]]=[v[p],v[i]];
    for (let r=i+1;r<n;r++) { const m=A[r][i]/A[i][i];
      for (let c=i;c<n;c++) A[r][c]-=m*A[i][c]; v[r]-=m*v[i]; }
  }
  const x=new Array(n).fill(0);
  for (let i=n-1;i>=0;i--) { let s=v[i];
    for (let c=i+1;c<n;c++) s-=A[i][c]*x[c]; x[i]=s/A[i][i]; }
  return x;
}
/* --- metrica: log-loss y acierto, dejando un torneo afuera --- */
export function loto(filas, cols, extra) {
  const claves=[...new Set(filas.map(f=>f.clave))];
  let ll=0, ok=0, n=0;
  for (const k of claves) {
    const tr=filas.filter(f=>f.clave!==k), te=filas.filter(f=>f.clave===k);
    if (tr.length<30 || !te.length) continue;
    const b=fit(tr,cols);
    for (const f of te) {
      const x=cols.map(c=>c(f)); let eta=0; for (let i=0;i<b.length;i++) eta+=b[i]*x[i];
      if (extra) eta += extra(f);
      const p=sig(eta);
      ll += -( (f.gano?1:0)*Math.log(Math.max(p,1e-9)) + (f.gano?0:1)*Math.log(Math.max(1-p,1e-9)) );
      if ((p>0.5)===f.gano) ok++; n++;
    }
  }
  return { ll: ll/n, ok: ok/n, n };
}
export const COLS_BASE = ['Q1','buenas','medias','finales'].map(g => f => f.grupo===g ? f.dW : 0);
