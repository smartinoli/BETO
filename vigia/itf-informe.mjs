#!/usr/bin/env node
/* ============================================================
   ITF-INFORME — el análisis de los partidos QUE BETANO COTIZA.

   Cambio de eje, decidido con Sebastián el 2026-08-25. Hasta hoy el
   universo salía del order of play de la ITF y las cuotas se le pegaban
   encima cuando calzaban. Eso tenía dos costos:

     · dependíamos de que la ITF publicara la programación del día, que
       falla seguido por el WAF y que en Maanshan no salió nunca;
     · llenábamos la mesa de partidos sin precio, que no se pueden jugar.

   Ahora manda el PDF: el universo son las cuotas que él bajó, y a cada
   partido le pegamos ENCIMA todo lo que la ITF sí nos dio — WTN, ATP,
   ranking ITF y nacional, edad, siembra, forma dentro del cuadro, hasta
   dónde llegó en el torneo anterior, ranking junior. El order of play
   pasa a ser un dato más (la hora), no el que decide qué se mira.

   NO SCRAPEA NADA: lee lo que hay en disco.

   Uso:  node vigia/itf-informe.mjs            → consola + HTML
         node vigia/itf-informe.mjs --solo     → solo lo jugable
   ============================================================ */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { analizar, elegirNombre, mismoJugador, NORM, gamesCedidos } from './itf-reglas.mjs';
import { ORDEN_PREVIO } from './itf-modelo.mjs';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const DATOS = path.join(DIR, 'datos', 'itf');
const VIVO = path.join(DATOS, 'vivo');
const OOP = path.join(DATOS, 'oop');
const leer = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')) } catch { return null } };
const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const soloJugables = process.argv.includes('--solo');

/* ---------- mapa de torneos ---------- */
const mapa = leer(path.join(DATOS, 'torneos.json')) || {};
const TORNEO = {};                       /* nombre → {clave, ...} */
const POR_CLAVE = {};
for (const sem of Object.values(mapa.semanas || {})) for (const [k, t] of Object.entries(sem)) { TORNEO[t.nombre] = { clave: k, ...t }; POR_CLAVE[k] = t }
for (const [k, t] of Object.entries(mapa.torneos || {})) { TORNEO[t.nombre] = { clave: k, ...t }; POR_CLAVE[k] = t }
const fechaIni = k => POR_CLAVE[k]?.fechas?.main || POR_CLAVE[k]?.fechas?.quali || null;
const fechaFin = k => POR_CLAVE[k]?.fechas?.final || null;

/* ---------- ranking junior, buscado en TODO el disco ----------
   El campo se guarda recién desde el 2026-08-25 y las entry lists viejas
   no lo traen: sin esto, Behrmann figuraba "junior sin ranking" siendo el
   7 del mundo. Se indexa por playerId y por nombre, con el MEJOR puesto
   visto (el de un junior que sube baja de número con las semanas). */
const JR_ID = new Map(), JR_NOM = new Map();
const mejorEn = (m, k, v) => { if (k != null && (m.get(k) == null || v < m.get(k))) m.set(k, v) };
for (const f of fs.readdirSync(DATOS)) {
  if (!f.endsWith('.aceptacion.json')) continue;
  const j = leer(path.join(DATOS, f)); if (!j?.secciones) continue;
  for (const arr of Object.values(j.secciones)) for (const q of arr) {
    const r = q.jrRank ?? q.juniorRanking;
    if (r != null) { mejorEn(JR_ID, q.id, r); mejorEn(JR_NOM, NORM(q.nombre), r) }
  }
}
function rankJunior(id, nombre) {
  if (id != null && JR_ID.has(id)) return JR_ID.get(id);
  const k = NORM(nombre);
  if (JR_NOM.has(k)) return JR_NOM.get(k);
  for (const [kk, v] of JR_NOM) if (mismoJugador(kk, k)) return v;
  return null;
}

/* ---------- índice de cuadros: quién jugó qué, dónde y contra quién ---------- */
const ORD_M = { '1st Round': 'R1', '2nd Round': 'R2', '3rd Round': 'R3', 'Quarter-finals': 'QF', 'Semi-finals': 'SF', 'Final': 'F' };
const ORD_Q = { '1st Round': 'Q1', '2nd Round': 'Q2', '3rd Round': 'Q3' };
const etapaDe = (ev, ronda) => (/^q/i.test(ev) ? ORD_Q[ronda] : ORD_M[ronda]) || 'R2';

const CUADROS = new Map();               /* clave → [{etapa, ordEv, ord, lados}] */
const HIST = new Map();                  /* playerId → Map(clave → mejor etapa ganada) */
for (const dir of [DATOS, VIVO]) {
  let ff = []; try { ff = fs.readdirSync(dir) } catch { continue }
  for (const f of ff) {
    if (!f.startsWith('m-itf') || !f.endsWith('.json') || f.includes('aceptacion')) continue;
    const clave = f.replace('.json', '');
    const j = leer(path.join(dir, f)); if (!j?.cuadros) continue;
    const lista = CUADROS.get(clave) || [];
    for (const [ev, c] of Object.entries(j.cuadros)) {
      if (!c?.rondas) continue;
      const esQ = /^q/i.test(ev);
      for (const r of c.rondas) for (const m of r.partidos) {
        if (!m.lados || m.lados.length !== 2) continue;
        const etapa = etapaDe(ev, r.nombre);
        lista.push({ etapa, esQ, orden: ORDEN_PREVIO[etapa] ?? 0, ...m });
        if (m.estado !== 'jugado') continue;
        for (const lado of m.lados) {
          if (!lado.ganador) continue;
          for (const q of lado.jugadores || []) {
            if (!HIST.has(q.id)) HIST.set(q.id, new Map());
            const h = HIST.get(q.id);
            h.set(clave, Math.max(h.get(clave) ?? 0, esQ ? 0 : (ORDEN_PREVIO[etapa] ?? 0)));
          }
        }
      }
    }
    CUADROS.set(clave, lista);
    if (j.bajado) (CUADROS.get(clave)).bajado = j.bajado;
  }
}
const NOMBRE_ETAPA = ['R1', 'R2', 'R3', 'QF', 'SF', 'campeón'];
function deDondeViene(id, clave) {
  const h = HIST.get(id); if (!h) return null;
  const f0 = fechaIni(clave); let mej = null;
  for (const [c, orden] of h) {
    if (c === clave) continue;
    const f = fechaFin(c); if (!f || !f0 || f >= f0) continue;
    if (!mej || f > mej.f) mej = { f, orden, clave: c };
  }
  if (!mej) return null;
  const gan = mej.orden, jug = gan + (mej.orden === 6 ? 0 : 1);
  return { ronda: mej.orden === 0 ? 'Q' : (NOMBRE_ETAPA[mej.orden - 1] || 'R1'), orden: mej.orden,
    torneo: POR_CLAVE[mej.clave]?.nombre || mej.clave, gan, jug };
}

/* ---------- ficha de un jugador dentro de un torneo ---------- */
function fichas(clave) {
  const j = leer(path.join(DATOS, clave + '.aceptacion.json'));
  if (!j?.secciones) return [];
  return Object.entries(j.secciones).flatMap(([sec, arr]) => arr.map(q => ({ ...q, sec })));
}
const CACHE_F = new Map();
const fichasDe = c => { if (!CACHE_F.has(c)) CACHE_F.set(c, fichas(c)); return CACHE_F.get(c) };

/* trayectoria dentro del cuadro: cada partido jugado, en orden */
function trayectoria(clave, nombre) {
  const out = [];
  for (const m of CUADROS.get(clave) || []) {
    if (m.estado !== 'jugado') continue;
    const i = m.lados.findIndex(l => l.nombre && mismoJugador(l.nombre, nombre));
    if (i < 0) continue;
    const yo = m.lados[i], riv = m.lados[1 - i];
    out.push({ etapa: m.etapa, esQ: m.esQ, orden: (m.esQ ? -3 : 0) + (m.orden || 0),
      gano: !!yo.ganador, sets: yo.sets || [], setsRiv: riv.sets || [],
      rival: riv.nombre, marcaRival: [riv.seed ? `[${riv.seed}]` : null, riv.entrada && riv.entrada !== 'DA' ? riv.entrada : null].filter(Boolean).join(''),
      nota: m.nota });
  }
  return out.sort((a, b) => a.orden - b.orden);
}
/* el texto que espera gamesCedidos() de itf-reglas */
const trayTexto = t => t.map(x => {
  const sets = x.sets.map((s, i) => `${s}-${x.setsRiv[i] ?? ''}`).join(' ');
  return `${x.etapa}${x.gano ? '✓' : '✗'} ${sets}${x.nota ? ' ' + x.nota : ''}`;
}).join(' · ');

function ficha(clave, nombre) {
  const lista = fichasDe(clave);
  const nom = elegirNombre(lista.map(q => q.nombre), nombre);
  const fi = nom ? lista.find(q => q.nombre === nom) : null;
  /* el cuadro manda para siembra y forma de entrada */
  let seed = null, entrada = null, id = null;
  for (const m of CUADROS.get(clave) || [])
    for (const l of m.lados)
      if (l.nombre && mismoJugador(l.nombre, nombre)) {
        if (l.seed != null) seed = l.seed;
        if (l.entrada) entrada = l.entrada;
        if ((l.jugadores || [])[0]?.id != null) id = l.jugadores[0].id;
      }
  if (id == null && fi?.id != null) id = fi.id;
  const tray = trayectoria(clave, nombre);
  const llega = tray.length ? trayTexto(tray) : null;
  return {
    nombre: nom || nombre, betano: nom && NORM(nom) !== NORM(nombre) ? nombre : null,
    id, pais: fi?.pais || null,
    wtn: fi?.wtn ?? null, wtnVisible: fi?.wtnVisible !== false,
    atp: fi?.atp ?? null, itf: fi?.itf ?? null, nac: fi?.nacional ?? null,
    nacido: fi?.nacido ?? null, seccion: fi?.sec || null,
    jr: fi?.sec === 'JR', jrRank: (fi?.jrRank ?? fi?.juniorRanking) ?? rankJunior(id, nom || nombre),
    seed, entrada, marca: [seed ? `[${seed}]` : null, entrada && entrada !== 'DA' ? entrada : null, fi?.sec === 'JR' ? 'JR' : null].filter(Boolean).join(' '),
    tray, llega, cedidos: gamesCedidos(llega),
    previo: id != null ? deDondeViene(id, clave) : null,
    enCuadro: (CUADROS.get(clave) || []).some(m => m.lados.some(l => l.nombre && mismoJugador(l.nombre, nombre))),
  };
}

/* ---------- la etapa del partido: del cuadro si está, si no del contexto ---------- */
function etapaPartido(clave, n1, n2) {
  for (const m of CUADROS.get(clave) || []) {
    const a = m.lados[0]?.nombre, b = m.lados[1]?.nombre;
    if (!a || !b) continue;
    if ((mismoJugador(a, n1) && mismoJugador(b, n2)) || (mismoJugador(a, n2) && mismoJugador(b, n1)))
      return { etapa: m.etapa, fuente: 'cuadro', estado: m.estado, lados: m.lados };
  }
  return null;
}
/* Sin el partido en el cuadro (cuadro viejo), la etapa se deduce: el que
   viene de ganar quali entra a R1; si los dos son de la sección Q y no hay
   cuadro nuevo, es una ronda de clasificación. */
function etapaDeducida(f1, f2) {
  const q = x => x.seccion === 'Q' || x.entrada === 'Q';
  const ganoQuali = x => x.tray.some(t => t.esQ && t.gano);
  if (q(f1) && q(f2) && !ganoQuali(f1) && !ganoQuali(f2)) return 'Q1';
  return 'R1';
}

/* ---------- horario, si el order of play lo tiene ---------- */
const HORARIOS = new Map();
try {
  for (const f of fs.readdirSync(OOP).sort()) {
    const j = leer(path.join(OOP, f)); if (!j?.partidos) continue;
    for (const p of j.partidos) {
      const n = (p.lados || []).map(l => l.nombre).filter(Boolean);
      if (n.length !== 2) continue;
      HORARIOS.set(NORM(n[0]) + '|' + NORM(n[1]), { fecha: j.fecha, hora: p.horario || '', cancha: p.cancha, estado: p.estado });
    }
  }
} catch { }
function horarioDe(n1, n2) {
  for (const [k, v] of HORARIOS) {
    const [a, b] = k.split('|');
    if ((mismoJugador(a, n1) && mismoJugador(b, n2)) || (mismoJugador(a, n2) && mismoJugador(b, n1))) return v;
  }
  return null;
}

/* ---------- resultado, si ya se jugó ---------- */
function resultado(clave, n1, n2) {
  const e = etapaPartido(clave, n1, n2);
  if (!e || e.estado !== 'jugado') return null;
  const iw = e.lados.findIndex(l => l.ganador); if (iw < 0) return null;
  const marcador = (e.lados[iw].sets || []).map((s, i) => `${s}-${e.lados[1 - iw].sets?.[i] ?? ''}`).join(' ');
  return { ganador: e.lados[iw].nombre, marcador };
}

/* ============================================================
   EL INFORME
   ============================================================ */
const doc = leer(path.join(DIR, 'itf-cuotas-manuales.json')) || { cuotas: [] };
const filas = [];
const sinTorneo = [];
for (const q of doc.cuotas) {
  const t = TORNEO[q.torneo];
  if (!t) { sinTorneo.push(q); continue }
  const f1 = ficha(t.clave, q.p1), f2 = ficha(t.clave, q.p2);
  if (f1.wtn == null || f2.wtn == null) { filas.push({ q, t, f1, f2, v: null, motivo: 'sin WTN' }); continue }
  const enCuadro = etapaPartido(t.clave, q.p1, q.p2);
  const etapa = enCuadro?.etapa || etapaDeducida(f1, f2);
  const lados = [f1, f2].map((f, i) => ({
    ...f, gana: i === 0 ? q.g1 : q.g2,
    llega: f.llega, previo: f.previo,
  }));
  const v = analizar({ lados, ronda: etapa });
  filas.push({ q, t, f1, f2, etapa, fuenteEtapa: enCuadro ? 'cuadro' : 'deducida',
    via: q.via || 'cuadro', v, horario: horarioDe(q.p1, q.p2), res: resultado(t.clave, q.p1, q.p2) });
}

/* ---------- consola ---------- */
const ORDEN_TIPO = { segura: 0, mirar: 1, trampa: 2, 'sin-precio': 3, pasar: 4 };
filas.sort((a, b) => (ORDEN_TIPO[a.v?.tipo] ?? 9) - (ORDEN_TIPO[b.v?.tipo] ?? 9)
  || (b.v?.nivel?.p ?? 0) - (a.v?.nivel?.p ?? 0));
const cuenta = {};
for (const f of filas) cuenta[f.v?.tipo || 'sin datos'] = (cuenta[f.v?.tipo || 'sin datos'] || 0) + 1;

console.log(`\n${doc.cuotas.length} partidos con cuota de Betano · ${filas.filter(f => f.v).length} analizados`
  + (sinTorneo.length ? ` · ${sinTorneo.length} sin torneo en el mapa` : ''));
console.log('  ' + Object.entries(cuenta).map(([k, v]) => `${k} ${v}`).join(' · ') + '\n');

const T = (s, n) => String(s ?? '').slice(0, n).padEnd(n);
const marca = { segura: '★', mirar: '·', trampa: '⚠', pasar: ' ', 'sin-precio': '?' };
for (const f of filas) {
  if (soloJugables && !['segura', 'mirar'].includes(f.v?.tipo)) continue;
  const p = f.v?.nivel?.p, dis = f.v?.precio?.discrepancia;
  const cuotaFav = f.v?.precio?.cuota ?? null;
  const res = f.res ? (mismoJugador(f.res.ganador, f.v?.favorito || '') ? ' ✓' : ' ✗') : '';
  console.log(`${marca[f.v?.tipo] || ' '} ${T(f.v?.tipo, 11)} ${T(f.etapa, 3)} ${T(f.t.nombre, 20)} `
    + `${T(f.v?.favorito ?? '—', 30)} ${String(cuotaFav ?? '—').padStart(5)}  `
    + `p=${p != null ? String(Math.round(p * 100)).padStart(3) + '%' : ' — '}  `
    + `mercado ${dis != null ? (dis >= 0 ? '+' : '') + String(Math.round(dis * 100)).padStart(3) : '  —'}  `
    + `valor ${f.v?.precio?.val != null ? (f.v.precio.val >= 0 ? '+' : '') + String(Math.round(f.v.precio.val * 100)).padStart(3) + '%' : '   —'}${res}`);
}
const jug = filas.filter(f => f.v?.tipo === 'segura');
if (jug.length) {
  console.log('\nPARA JUGAR');
  for (const f of jug) {
    console.log(`\n  ${f.t.nombre} · ${f.etapa} · ${f.v.favorito} a ${f.v.precio.cuota}`);
    console.log(`    ${f.v.razon}`);
  }
} else console.log('\nNada llega a SEGURA con las cuotas de ahora.');

/* ---------- HTML ---------- */
const badge = t => `<span class="tp t-${t}">${t === 'sin-precio' ? 'sin precio' : t}</span>`;
const num = (v, s = '') => v == null ? '<i>—</i>' : `${v}${s}`;
const trayHtml = f => f.tray.length
  ? f.tray.map(x => `<i class="${x.gano ? 'g' : 'p'}">${x.etapa}${x.gano ? '✓' : '✗'}</i> `
    + x.sets.map((s, i) => `${s}-${x.setsRiv[i] ?? ''}`).join(' ')
    + (x.marcaRival ? ` <i class="vs">v${x.marcaRival}</i>` : '')).join(' · ')
  : 'debuta';
const prevHtml = f => f.previo
  ? `<b>${f.previo.ronda}</b> ${esc(f.previo.torneo.replace(/^M\d+\+?H? /, ''))} <i>${f.previo.gan}/${f.previo.jug}</i>`
  : '<i>—</i>';

const seccion = f => {
  const n = f.v?.nivel, pr = f.v?.precio;
  const lado = (x, cu, fav) => `<div class="jug${fav ? ' fav' : ''}">
    <div class="nom">${esc(x.nombre)}${x.marca ? ` <b>${esc(x.marca)}</b>` : ''}${x.jr && x.jrRank != null ? ` <b>jr ${x.jrRank}</b>` : ''}
      ${cu ? `<span class="cu">${cu}</span>` : ''}</div>
    <div class="dat">WTN ${num(x.wtn)} · ATP ${num(x.atp)} · ITF ${num(x.itf)} · nac ${num(x.nac)} · ${x.nacido ? 2026 - x.nacido + ' años' : '<i>edad —</i>'}</div>
    <div class="tray">${trayHtml(x)}</div>
    <div class="dat">viene de ${prevHtml(x)}</div></div>`;
  const favEs1 = f.v?.favorito?.startsWith(f.f1.nombre);
  return `<div class="p ${f.v?.tipo || 'sd'}">
    <div class="cab">${badge(f.v?.tipo || 'sin datos')}
      <span class="tor">${esc(f.t.nombre)}</span> <span class="et">${esc(f.etapa || '')}</span>
      ${f.horario ? `<span class="hr">${esc(f.horario.fecha || '')} ${esc(f.horario.hora || '')}</span>` : ''}
      ${f.fuenteEtapa === 'deducida' ? '<span class="av">etapa deducida: el partido no está en el cuadro que tenemos</span>' : ''}
      ${f.via === 'lista' ? '<span class="av">verificado contra la entry list, no contra el cuadro</span>' : ''}
      ${f.res ? `<span class="res">${esc(f.res.ganador)} ${esc(f.res.marcador)}</span>` : ''}
    </div>
    <div class="duelo">${lado(f.f1, f.q.g1, favEs1)}${lado(f.f2, f.q.g2, !favEs1)}</div>
    ${n ? `<div class="cifras">
      <span><label>modelo</label>${Math.round(n.p * 100)}%</span>
      <span><label>solo WTN</label>${Math.round(n.soloNivel * 100)}%</span>
      ${pr?.devig != null ? `<span><label>mercado</label>${Math.round(pr.devig * 100)}%</span>
      <span class="${pr.discrepancia > 0.12 ? 'mal' : Math.abs(pr.discrepancia) < 0.05 ? 'bien' : ''}"><label>discrepancia</label>${pr.discrepancia >= 0 ? '+' : ''}${Math.round(pr.discrepancia * 100)}</span>` : ''}
      ${pr ? `<span><label>mínima</label>${pr.cMinima.toFixed(2)}</span>` : ''}
    </div>` : ''}
    <p class="raz">${esc(f.v?.razon || f.motivo || '')}</p></div>`;
};

const html = `<title>Informe ITF</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=IBM+Plex+Sans:wght@400;500;600&display=swap">
<style>
:root{--papel:#F3F5F7;--carta:#FFF;--tinta:#1A2732;--tinta2:#5A6B7A;--tinta3:#93A3B0;--linea:#DDE4EA;
  --verde:#0F6B5C;--verde-s:#E3EFEB;--rojo:#A33B2A;--rojo-s:#F7E9E6;--ambar:#8A6116;--ambar-s:#F6EEDC;--realce:#EAF1F5}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--papel:#0F151B;--carta:#151E26;--tinta:#DAE4EC;
  --tinta2:#8FA1B0;--tinta3:#63737F;--linea:#26313C;--verde:#3FB79E;--verde-s:#15302B;--rojo:#E08A79;--rojo-s:#2E1D19;
  --ambar:#D9A94B;--ambar-s:#2A2415;--realce:#1B252E}}
:root[data-theme="dark"]{--papel:#0F151B;--carta:#151E26;--tinta:#DAE4EC;--tinta2:#8FA1B0;--tinta3:#63737F;
  --linea:#26313C;--verde:#3FB79E;--verde-s:#15302B;--rojo:#E08A79;--rojo-s:#2E1D19;--ambar:#D9A94B;--ambar-s:#2A2415;--realce:#1B252E}
*{box-sizing:border-box}
body{margin:0;background:var(--papel);color:var(--tinta);font:14px/1.5 "IBM Plex Sans",system-ui,sans-serif}
.env{max-width:1000px;margin:0 auto;padding:18px 14px 60px}
h1{font-size:20px;margin:0 0 4px;font-weight:600}
.gen{font-size:12px;color:var(--tinta2);margin-bottom:6px}
.resumen{display:flex;gap:8px;flex-wrap:wrap;margin:14px 0}
.resumen b{background:var(--carta);border:1px solid var(--linea);border-radius:5px;padding:6px 10px;font:600 12px "IBM Plex Mono",monospace}
h2{font-size:13px;text-transform:uppercase;letter-spacing:.8px;color:var(--tinta2);margin:26px 0 10px;font-weight:600}
.p{background:var(--carta);border:1px solid var(--linea);border-left-width:4px;border-radius:6px;padding:11px 13px;margin-bottom:9px}
.p.segura{border-left-color:var(--verde)} .p.mirar{border-left-color:var(--tinta3)}
.p.trampa{border-left-color:var(--rojo)} .p.pasar,.p.sd,.p\\.sin-precio{border-left-color:var(--linea)}
.cab{display:flex;gap:8px;align-items:baseline;flex-wrap:wrap;margin-bottom:9px}
.tp{font:600 10px "IBM Plex Sans",sans-serif;text-transform:uppercase;letter-spacing:.6px;padding:2px 7px;border-radius:3px}
.t-segura{background:var(--verde-s);color:var(--verde)} .t-trampa{background:var(--rojo-s);color:var(--rojo)}
.t-mirar{background:var(--realce);color:var(--tinta2)} .t-pasar{color:var(--tinta3)}
.tor{font-weight:600} .et{font:600 11px "IBM Plex Mono",monospace;color:var(--tinta2)}
.hr,.av,.res{font-size:11px;color:var(--tinta3)} .av{color:var(--ambar);background:var(--ambar-s);padding:1px 6px;border-radius:3px}
.res{margin-left:auto;font-family:"IBM Plex Mono",monospace;color:var(--tinta2)}
.duelo{display:grid;grid-template-columns:1fr 1fr;gap:10px}
@media(max-width:640px){.duelo{grid-template-columns:1fr}}
.jug{padding:8px 10px;border-radius:5px;background:var(--papel)}
.jug.fav{background:var(--verde-s)}
.nom{font-weight:600;font-size:13.5px} .nom b{color:var(--verde);font-size:11px;margin-left:3px}
.cu{float:right;font:600 13px "IBM Plex Mono",monospace}
.dat{font:11px "IBM Plex Mono",monospace;color:var(--tinta2);margin-top:3px}
.dat i,.tray i.vs{font-style:normal;color:var(--tinta3)}
.tray{font:11px "IBM Plex Mono",monospace;color:var(--tinta3);margin-top:3px;line-height:1.4}
.tray i.g{color:var(--verde);font-weight:600;font-style:normal} .tray i.p{color:var(--rojo);font-weight:600;font-style:normal}
.cifras{display:flex;gap:16px;flex-wrap:wrap;margin-top:10px;padding-top:9px;border-top:1px solid var(--linea);
  font:600 14px "IBM Plex Mono",monospace}
.cifras label{display:block;font:600 9.5px "IBM Plex Sans",sans-serif;text-transform:uppercase;letter-spacing:.6px;color:var(--tinta3)}
.cifras .bien{color:var(--verde)} .cifras .mal{color:var(--rojo)}
.raz{margin:9px 0 0;font-size:12.5px;color:var(--tinta2);line-height:1.55}
.pie{margin-top:28px;font-size:12px;color:var(--tinta2);line-height:1.65}
.pie code{font-family:"IBM Plex Mono",monospace;color:var(--tinta)}
</style>
<div class="env">
<h1>Informe ITF</h1>
<div class="gen">${doc.cuotas.length} partidos cotizados por Betano · generado ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC</div>
<div class="gen">El universo son las cuotas, no el order of play: se analiza todo lo que Betano puso precio, con toda la información de la ITF encima.</div>
<div class="resumen">${Object.entries(cuenta).map(([k, v]) => `<b>${k === 'sin-precio' ? 'sin precio' : k} ${v}</b>`).join('')}</div>
${['segura', 'mirar', 'trampa', 'sin-precio', 'pasar'].map(t => {
  const g = filas.filter(f => (f.v?.tipo || 'sin datos') === t);
  if (!g.length) return '';
  const titulo = { segura: 'Para jugar', mirar: 'Con lado, pero algo falta',
    trampa: 'Trampa: el mercado nos contradice fuerte', 'sin-precio': 'Sin precio', pasar: 'Descartadas' }[t] || t;
  return `<h2>${titulo} · ${g.length}</h2>${g.map(seccion).join('')}`;
}).join('')}
${filas.filter(f => !f.v).length ? `<h2>Sin datos de nivel · ${filas.filter(f => !f.v).length}</h2>${filas.filter(f => !f.v).map(seccion).join('')}` : ''}
<p class="pie">
<b>modelo</b> = nuestra probabilidad con todas las señales: ΔWTN por grupo de rondas, edad, siembra, games cedidos en el cuadro y hasta dónde llegó en el torneo anterior.
Validado dejando un torneo afuera sobre 1243 partidos: log-loss 0.4967 y 75.5% de acierto, contra 0.5097 y 74.3% del modelo que solo miraba el WTN.<br>
<b>solo WTN</b> = lo que decía el modelo anterior, para ver cuánto mueven las otras señales.<br>
<b>mercado</b> = la probabilidad que implica la cuota una vez sacado el margen de la casa.<br>
<b>discrepancia</b> = modelo menos mercado, en puntos. <b>Esta es la señal que decide.</b> Medido sobre los 50 partidos con cuota y resultado:
sacarle al mercado más de 15 puntos dio 4 aciertos de 13 y −57%; estar dentro de ±5 dio 6 de 7 y +13%.
Por eso <code>trampa</code> no es una oportunidad: es la casilla donde el precio sabe algo que nosotros no.<br>
<b>segura</b> = el modelo da 70% o más, no le sacamos más de 12 puntos al mercado, y la cuota deja 9% sobre el margen. Esa combinación midió 16 de 16 y +20%,
con el modelo reajustado sin el torneo de cada partido — pero son 16 partidos y el umbral lo elegí mirando esos mismos datos, así que hay que volver a medirlo.<br>
<b>ATP, ranking ITF y nacional</b> se muestran porque sirven para mirar, pero <b>no entran en el modelo</b>: medidos uno por uno, el ITF y el nacional dan coeficiente negativo (ruido)
y el ATP deja de aportar cuando la edad ya está adentro — estaba diciendo "joven que sube", que la edad dice mejor y con el triple de datos.
</p>
</div>`;
fs.writeFileSync(path.join(DIR, 'itf-informe.html'), html);
console.log(`\n✓ vigia/itf-informe.html`);
if (sinTorneo.length) {
  console.log(`\n${sinTorneo.length} cuotas sin torneo en el mapa:`);
  for (const q of sinTorneo.slice(0, 10)) console.log(`  ${q.torneo}: ${q.p1} / ${q.p2}`);
}
