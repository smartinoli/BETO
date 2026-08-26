#!/usr/bin/env node
/* ============================================================
   ITF-BANCO — el conjunto historico de partidos con TODAS las señales.

   Una fila por partido JUGADO, con la ficha completa de los dos lados:
   WTN, ATP, ranking ITF, ranking nacional, año de nacimiento, seccion de
   la entry list, ranking junior (buscado en todo el disco), siembra,
   forma de entrada al cuadro, games cedidos ANTES de esa ronda, y hasta
   donde llego cada uno en su torneo anterior.

   Es la base sobre la que se ajusta y se valida itf-modelo.mjs, y la que
   lee itf-auditoria.mjs para medir que sirve y que no. Escribe
   datos/itf/_auditoria.json.

   Uso:  node vigia/itf-banco.mjs
   ============================================================ */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const D = path.join(path.dirname(fileURLToPath(import.meta.url)), 'datos', 'itf');
const N = s => String(s||'').normalize('NFD').replace(/[̀-ͯ]/g,'').toLowerCase().replace(/[^a-z ]/g,' ').replace(/\s+/g,' ').trim();

/* ---- mapa de torneos: fechas ---- */
const MAPA = JSON.parse(fs.readFileSync(path.join(D,'torneos.json'),'utf8'));
const FIN = {}, INI = {}, CAT = {}, SUP = {};
for (const ts of Object.values(MAPA.semanas||{})) for (const [k,t] of Object.entries(ts)) {
  FIN[k]=t.fechas?.final; INI[k]=t.fechas?.main||t.fechas?.quali; CAT[k]=t.categoria; SUP[k]=t.superficie; }
for (const [k,t] of Object.entries(MAPA.torneos||{})) if (!FIN[k]) {
  FIN[k]=t.fechas?.final; INI[k]=t.fechas?.main||t.fechas?.quali; CAT[k]=t.categoria; SUP[k]=t.superficie; }

/* ---- ranking junior global (el campo se guarda recien desde el 25-08) ---- */
const JR_ID = new Map(), JR_NOM = new Map();
const mejor = (m,k,v) => { if (k!=null && (m.get(k)==null || v<m.get(k))) m.set(k,v) };
for (const f of fs.readdirSync(D)) {
  if (!f.endsWith('.aceptacion.json')) continue;
  let j; try { j=JSON.parse(fs.readFileSync(path.join(D,f),'utf8')) } catch { continue }
  for (const arr of Object.values(j.secciones||{})) for (const p of arr)
    if (p.jrRank!=null) { mejor(JR_ID,p.id,p.jrRank); mejor(JR_NOM,N(p.nombre),p.jrRank); }
}
const jrDe = (id,nom) => (id!=null&&JR_ID.has(id)) ? JR_ID.get(id) : (JR_NOM.get(N(nom)) ?? null);

/* ---- fichas por torneo ---- */
function fichas(clave) {
  const f = path.join(D, clave+'.aceptacion.json');
  if (!fs.existsSync(f)) return null;
  let j; try { j=JSON.parse(fs.readFileSync(f,'utf8')) } catch { return null }
  const m = new Map();
  for (const [sec,arr] of Object.entries(j.secciones||{})) for (const p of arr)
    m.set(N(p.nombre), { ...p, sec });
  return m;
}
function buscar(m, nom) {
  const k = N(nom); if (m.has(k)) return m.get(k);
  const t = k.split(' ').filter(x=>x.length>=3); if (!t.length) return null;
  let mejorF=null, mejorN=-1;
  for (const [kk,v] of m) { const tt=new Set(kk.split(' '));
    const c=t.filter(x=>tt.has(x)).length;
    if (c>=Math.min(2,t.length) && c>mejorN) { mejorN=c; mejorF=v; } }
  return mejorF;
}

/* ---- archivos de cuadros ---- */
const ARCH = [];
for (const f of fs.readdirSync(D))
  if (f.startsWith('m-itf') && f.endsWith('.json') && !f.includes('aceptacion') && !f.includes('torneos'))
    ARCH.push([f.replace('.json',''), path.join(D,f)]);
for (const f of fs.readdirSync(path.join(D,'vivo')))
  if (f.startsWith('m-itf') && f.endsWith('.json')) ARCH.push([f.replace('.json',''), path.join(D,'vivo',f)]);

const ORD = {'1st Round':1,'2nd Round':2,'3rd Round':3,'Quarter-finals':4,'Semi-finals':5,'Final':6};
const ORD_Q = {'1st Round':1,'2nd Round':2,'3rd Round':3};
const nombreRonda = (ev, r) => {
  const q = /^q/i.test(ev);
  if (q) return 'Q'+(ORD_Q[r]??1);
  return ({1:'R1',2:'R2',3:'R3',4:'QF',5:'SF',6:'F'})[ORD[r]] ?? 'R2';
};

/* ---- paso 1: indice de trayectoria por (torneo, playerId) ---- */
const CRUDO = [];   /* todos los partidos con lados resueltos */
for (const [clave, arch] of ARCH) {
  let j; try { j=JSON.parse(fs.readFileSync(arch,'utf8')) } catch { continue }
  for (const [ev,c] of Object.entries(j.cuadros||{})) {
    if (!c?.rondas) continue;
    for (const r of c.rondas) for (const m of r.partidos) {
      const L = m.lados; if (!L || L.length!==2) continue;
      CRUDO.push({ clave, ev, rondaCruda:r.nombre, ronda:nombreRonda(ev,r.nombre),
        ordEv:/^q/i.test(ev)?0:1, ord:ORD[r.nombre]??9,
        estado:m.estado, nota:m.nota, lados:L });
    }
  }
}
/* trayectoria: por (clave, id) los partidos jugados ordenados */
const TRAY = new Map();
const key = (c,id) => c+'|'+id;
for (const p of CRUDO) {
  if (p.estado!=='jugado') continue;
  for (let i=0;i<2;i++) {
    for (const q of p.lados[i].jugadores||[]) {
      const k = key(p.clave,q.id);
      if (!TRAY.has(k)) TRAY.set(k,[]);
      TRAY.get(k).push({ ordEv:p.ordEv, ord:p.ord, gano:!!p.lados[i].ganador,
        sets:p.lados[i].sets||[], setsRiv:p.lados[1-i].sets||[], nota:p.nota });
    }
  }
}
/* torneo anterior por jugador: ronda mas alta ganada */
const HIST = new Map();  /* id -> Map(clave -> maxOrdGanada en main) */
for (const p of CRUDO) {
  if (p.estado!=='jugado') continue;
  for (let i=0;i<2;i++) {
    if (!p.lados[i].ganador) continue;
    for (const q of p.lados[i].jugadores||[]) {
      if (!HIST.has(q.id)) HIST.set(q.id,new Map());
      const h=HIST.get(q.id);
      const v = p.ordEv ? p.ord : 0;
      h.set(p.clave, Math.max(h.get(p.clave)??0, v));
    }
  }
}
function previo(id, clave) {
  const h = HIST.get(id); if (!h) return null;
  const f0 = INI[clave]; let mej=null;
  for (const [c,ord] of h) { if (c===clave) continue;
    const f = FIN[c]; if (!f||!f0||f>=f0) continue;
    if (!mej || f>mej.f) mej={f,ord}; }
  return mej ? mej.ord : null;   /* 0 = solo gano en quali, 6 = campeon */
}
/* forma dentro del torneo ANTES de esta ronda */
function forma(clave, id, ordEv, ord) {
  const a = (TRAY.get(key(clave,id))||[]).filter(x => x.ordEv<ordEv || (x.ordEv===ordEv && x.ord<ord));
  if (!a.length) return null;
  let gp=0, gc=0, ret=false, n=0, gan=0;
  for (const x of a) {
    if (/retir|walkover/i.test(x.nota||'')) { ret=true; continue }
    for (let i=0;i<Math.max(x.sets.length,x.setsRiv.length);i++) {
      gp += +x.sets[i]||0; gc += +x.setsRiv[i]||0;
    }
    n++; if (x.gano) gan++;
  }
  if (!n) return { n:0, ced:null, ret, ganados:gan };
  return { n, ced: gp+gc ? gc/(gp+gc) : null, ret, ganados:gan };
}

/* ---- paso 2: filas ---- */
const FILAS = [];
for (const p of CRUDO) {
  if (p.estado!=='jugado' || /retir|walkover/i.test(p.nota||'')) continue;
  const L=p.lados;
  if (!L[0].nombre||!L[1].nombre) continue;
  const iw = L.findIndex(x=>x.ganador); if (iw<0) continue;
  const F = fichas(p.clave); if (!F) continue;
  const lado = i => {
    const l=L[i], fi=buscar(F,l.nombre); if (!fi) return null;
    const id=(l.jugadores||[])[0]?.id ?? null;
    return { nombre:l.nombre, id, wtn:fi.wtn, atp:fi.atp, itf:fi.itf, nac:fi.nacional,
      nacido:fi.nacido, sec:fi.sec, jr:fi.sec==='JR', jrRank:jrDe(id,l.nombre),
      seed:l.seed??null, entrada:l.entrada||'DA', wtnVisible:fi.wtnVisible!==false, pais:fi.pais??null,
      previo:previo(id,p.clave), forma:forma(p.clave,id,p.ordEv,p.ord) };
  };
  const a=lado(0), b=lado(1); if (!a||!b) continue;
  FILAS.push({ clave:p.clave, cat:CAT[p.clave]??null, sup:SUP[p.clave]??null,
    ev:p.ev, ronda:p.ronda, ord:p.ord, ordEv:p.ordEv, gano0:iw===0, a, b });
}
const SAL = path.join(D, '_auditoria.json');
fs.writeFileSync(SAL, JSON.stringify(FILAS));
console.log(FILAS.length+' partidos');
const con = f => FILAS.filter(x=>f(x.a)&&f(x.b)).length;
console.log('  con WTN en los dos      ', con(x=>x.wtn!=null));
console.log('  con ATP en los dos      ', con(x=>x.atp!=null));
console.log('  con ITF en los dos      ', con(x=>x.itf!=null));
console.log('  con nacional en los dos ', con(x=>x.nac!=null));
console.log('  con edad en los dos     ', con(x=>x.nacido!=null));
console.log('  con previo en los dos   ', con(x=>x.previo!=null));
console.log('  con forma en los dos    ', con(x=>x.forma&&x.forma.n>0));
console.log('  con ced% en los dos     ', con(x=>x.forma&&x.forma.ced!=null));
