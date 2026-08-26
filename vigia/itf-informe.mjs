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
/* Por defecto se informa LA ÚLTIMA TANDA: los partidos que venían en los
   PDF de la última carga. Es una foto del día, no el registro histórico —
   el registro acumula cuotas de torneos que ya terminaron y mezclarlas
   ensucia el informe. Con --todo se muestra el registro completo. */
const todo = process.argv.includes('--todo');

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
/* ---------- ficha GLOBAL del jugador ----------
   La entry list es una foto del torneo tomada días antes: quien entró
   después (lucky loser, alternate) está en el CUADRO pero no en la lista,
   y se quedaba sin WTN — 3 de los 21 partidos del 26-08. El WTN, el ATP y
   el año de nacimiento son del jugador, no del torneo, así que se buscan
   en la ficha más reciente que tengamos de él en cualquier entry list.
   Se prefiere siempre la del propio torneo cuando existe. */
const GLOBAL_ID = new Map(), GLOBAL_NOM = new Map();
for (const f of fs.readdirSync(DATOS).sort()) {   /* orden alfabético ≈ orden de bajada; gana la última */
  if (!f.endsWith('.aceptacion.json')) continue;
  const j = leer(path.join(DATOS, f)); if (!j?.secciones) continue;
  for (const [sec, arr] of Object.entries(j.secciones)) for (const q of arr) {
    if (q.wtn == null) continue;
    const reg = { ...q, sec, deTorneo: f.replace('.aceptacion.json', '') };
    if (q.id != null) GLOBAL_ID.set(q.id, reg);
    GLOBAL_NOM.set(NORM(q.nombre), reg);
  }
}
function fichaGlobal(id, nombre) {
  if (id != null && GLOBAL_ID.has(id)) return GLOBAL_ID.get(id);
  const k = NORM(nombre);
  if (GLOBAL_NOM.has(k)) return GLOBAL_NOM.get(k);
  for (const [kk, v] of GLOBAL_NOM) if (mismoJugador(kk, k)) return v;
  return null;
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
  const nom0 = elegirNombre(lista.map(q => q.nombre), nombre);
  let fi = nom0 ? lista.find(q => q.nombre === nom0) : null;
  let nom = nom0, fuera = null;
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
  if (!fi || fi.wtn == null) {
    const g = fichaGlobal(id, nom || nombre);
    if (g) { fuera = g.deTorneo; fi = { ...g, ...(fi || {}), wtn: fi?.wtn ?? g.wtn, atp: fi?.atp ?? g.atp,
      itf: fi?.itf ?? g.itf, nacional: fi?.nacional ?? g.nacional, nacido: fi?.nacido ?? g.nacido,
      sec: fi?.sec ?? g.sec }; nom = nom || g.nombre; }
  }
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
    /* de qué torneo salió la ficha, cuando no es la del propio */
    fichaDe: fuera,
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
const tandaDoc = todo ? null : leer(path.join(DIR, 'itf-cuotas-tanda.json'));
const enTanda = tandaDoc
  ? new Set(tandaDoc.partidos.map(x => NORM(x.torneo) + '|' + NORM(x.p1) + '|' + NORM(x.p2)))
  : null;
const cuotas = enTanda
  ? doc.cuotas.filter(q => enTanda.has(NORM(q.torneo) + '|' + NORM(q.p1) + '|' + NORM(q.p2))
                        || enTanda.has(NORM(q.torneo) + '|' + NORM(q.p2) + '|' + NORM(q.p1)))
  : doc.cuotas;
const filas = [];
const sinTorneo = [];
for (const q of cuotas) {
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
/* Sin categorías: ordena por cuánto rinde la apuesta SI TENEMOS RAZÓN,
   que es el único número que depende de nosotros. Al lado va siempre lo
   que rinde si la tiene el mercado, para que no se lea solo la mitad. */
filas.sort((a, b) => (b.v?.precio?.val ?? -9) - (a.v?.precio?.val ?? -9)
  || (b.v?.nivel?.p ?? 0) - (a.v?.nivel?.p ?? 0));
const cuenta = {
  'con precio': filas.filter(f => f.v?.precio).length,
  'con alerta': filas.filter(f => f.v?.alertas?.length).length,
  'sin datos': filas.filter(f => !f.v?.nivel).length,
};

console.log(`\n${cuotas.length} partidos con cuota de Betano${tandaDoc ? ` (tanda del ${tandaDoc.generado.slice(0, 16).replace('T', ' ')}, ${tandaDoc.archivos.length} archivos)` : ' — registro completo'} · ${filas.filter(f => f.v).length} analizados`
  + (sinTorneo.length ? ` · ${sinTorneo.length} sin torneo en el mapa` : ''));
console.log('  ' + Object.entries(cuenta).map(([k, v]) => `${k} ${v}`).join(' · ') + '\n');

const T = (s, n) => String(s ?? '').slice(0, n).padEnd(n);
console.log('                                                    nuestra  mercado         rinde si');
console.log('  torneo               et  favorito                     p       p     cuota  nosotros  mercado  alertas');
for (const f of filas) {
  if (soloJugables && !f.v?.precio) continue;
  const p = f.v?.nivel?.p, pr = f.v?.precio;
  const cuotaFav = pr?.cuota ?? null;
  const pc = v => v == null ? '   —' : ((v >= 0 ? '+' : '−') + Math.abs(Math.round(v * 100)) + '%').padStart(6);
  /* en trampa y pasar, analizar() deja favorito en "—" a proposito (no hay
     nada que jugar); para leer el informe igual sirve saber a quien apunta
     el modelo, asi que se muestra el del nivel */
  const quien = (f.v?.favorito !== '—' && f.v?.favorito) || f.v?.nivel?.favorito || '—';
  const res = f.res ? (mismoJugador(f.res.ganador, quien) ? ' ✓' : ' ✗') : '';
  console.log(`  ${T(f.t.nombre, 20)} ${T(f.etapa, 3)} ${T(quien, 27)} `
    + `${p != null ? String(Math.round(p * 100)).padStart(4) + '%' : '   — '}  `
    + `${pr?.devig != null ? String(Math.round(pr.devig * 100)).padStart(4) + '%' : '   — '}  `
    + `${String(cuotaFav ?? '—').padStart(6)}  ${pc(pr?.val)}   ${pc(pr?.valMercado)}  `
    + `${(f.v?.alertas || []).map(a => a.clave).join(' ')}${res}`);
}
/* Las tres de arriba, con el razonamiento completo. No es una
   recomendación: son las que más rinden SI nuestro modelo tiene razón. */
const arriba = filas.filter(f => f.v?.precio?.val != null).slice(0, 3);
if (arriba.length) {
  console.log('\nLAS TRES DE MÁS VALOR — si nuestro modelo tiene razón');
  for (const f of arriba) {
    console.log(`\n  ${f.t.nombre} · ${f.etapa} · ${f.v.nivel.favorito} a ${f.v.precio.cuota}`);
    console.log(`    ${f.v.razon}`);
  }
}

/* ---------- HTML ----------
   Sin categorías. Una fila por partido con los cuatro números que
   importan —nuestra p, la del mercado, la cuota, y cuánto rinde bajo
   cada supuesto— y las alertas que sí están medidas. La decisión es
   de Sebastián, no del script. */
const num = (v, s = '') => v == null ? '<i>—</i>' : `${v}${s}`;
const pctN = v => v == null ? '<i>—</i>' : Math.round(v * 100) + '%';
const rend = v => v == null ? '<i>—</i>'
  : `<span class="${v >= 0 ? 'pos' : 'neg'}">${v >= 0 ? '+' : '−'}${Math.abs(Math.round(v * 100))}%</span>`;
const trayHtml = f => f.tray.length
  ? f.tray.map(x => `<i class="${x.gano ? 'g' : 'p'}">${x.etapa}${x.gano ? '✓' : '✗'}</i> `
    + x.sets.map((s, i) => `${s}-${x.setsRiv[i] ?? ''}`).join(' ')
    + (x.marcaRival ? ` <i class="vs">v${x.marcaRival}</i>` : '')).join(' · ')
  : 'debuta';
const prevHtml = f => f.previo
  ? `<b>${f.previo.ronda}</b> ${esc(f.previo.torneo.replace(/^M\d+\+?H? /, ''))} <i>${f.previo.gan}/${f.previo.jug}</i>`
  : '<i>—</i>';

const partido = f => {
  const n = f.v?.nivel, pr = f.v?.precio;
  const apunta = (f.v?.favorito !== '—' && f.v?.favorito) || n?.favorito || '';
  const favEs1 = apunta.startsWith(f.f1.nombre);
  const lado = (x, cu, fav) => `<div class="jug${fav ? ' fav' : ''}">
    <div class="nom">${esc(x.nombre)}${x.marca ? ` <b>${esc(x.marca)}</b>` : ''}${x.jr && x.jrRank != null ? ` <b>jr ${x.jrRank}</b>` : ''}
      ${cu ? `<span class="cu">${cu}</span>` : ''}</div>
    <div class="dat">WTN ${num(x.wtn)} · ${x.nacido ? 2026 - x.nacido + ' años' : '<i>edad —</i>'} · ATP ${num(x.atp)} · ITF ${num(x.itf)} · nac ${num(x.nac)}</div>
    <div class="tray">${trayHtml(x)}</div>
    <div class="dat">viene de ${prevHtml(x)}</div></div>`;
  return `<article class="p${(f.v?.alertas || []).length ? ' conalerta' : ''}">
    <div class="cab">
      <span class="tor">${esc(f.t.nombre)}</span> <span class="et">${esc(f.etapa || '')}</span>
      ${f.horario ? `<span class="hr">${esc(f.horario.fecha || '')} ${esc(f.horario.hora || '')}</span>` : ''}
      ${f.fuenteEtapa === 'deducida' ? '<span class="av">etapa deducida: el partido no está en el cuadro que tenemos</span>' : ''}
      ${f.via === 'lista' ? '<span class="av">verificado contra la entry list, no contra el cuadro</span>' : ''}
      ${[f.f1, f.f2].filter(x => x.fichaDe).map(x => `<span class="av">${esc(x.nombre)} no está en la entry list de este torneo: su WTN sale de la ficha de ${esc(POR_CLAVE[x.fichaDe]?.nombre || x.fichaDe)}</span>`).join('')}
      ${f.res ? `<span class="res">${esc(f.res.ganador)} ${esc(f.res.marcador)}</span>` : ''}
    </div>
    <div class="duelo">${lado(f.f1, f.q.g1, favEs1)}${lado(f.f2, f.q.g2, !favEs1)}</div>
    ${n ? `<div class="cifras">
      <span><label>nuestra p</label>${pctN(n.p)}</span>
      <span><label>sólo WTN</label><i class="sec">${pctN(n.soloNivel)}</i></span>
      ${pr?.devig != null ? `<span><label>el mercado</label>${pctN(pr.devig)}</span>` : ''}
      ${pr ? `<span class="sep"><label>rinde si acertamos</label>${rend(pr.val)}</span>
      <span><label>si acierta el mercado</label>${rend(pr.valMercado)}</span>` : ''}
    </div>` : ''}
    ${(f.v?.alertas || []).length ? `<ul class="alertas">${f.v.alertas.map(a => `<li>${esc(a.texto)}</li>`).join('')}</ul>` : ''}
    <p class="raz">${esc(f.v?.razon || f.motivo || '')}</p></article>`;
};

const html = `<title>Partidos cotizados hoy</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,500;12..96,700&family=Source+Serif+4:opsz,wght@8..60,400;8..60,600&family=IBM+Plex+Mono:wght@400;500;600&display=swap">
<style>
:root{--ground:#F5F7F8;--panel:#FFFFFF;--sunk:#EDF1F3;--ink:#141F28;--ink2:#54687A;--ink3:#8496A5;
  --rule:#DBE3E8;--rule2:#C3CFD7;--accent:#1B5B70;--accent-soft:#E2EEF2;
  --pos:#2C7A58;--pos-soft:#DEEDE5;--neg:#9E4C33;--ojo:#856512;--ojo-soft:#F6EEDC}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){
  --ground:#0D1319;--panel:#141C24;--sunk:#111920;--ink:#DDE6ED;--ink2:#93A5B4;--ink3:#647686;
  --rule:#222E39;--rule2:#31404C;--accent:#5BA9BF;--accent-soft:#15303A;
  --pos:#57B98A;--pos-soft:#142C22;--neg:#DE9077;--ojo:#CFA23F;--ojo-soft:#2A2415}}
:root[data-theme="dark"]{--ground:#0D1319;--panel:#141C24;--sunk:#111920;--ink:#DDE6ED;--ink2:#93A5B4;
  --ink3:#647686;--rule:#222E39;--rule2:#31404C;--accent:#5BA9BF;--accent-soft:#15303A;
  --pos:#57B98A;--pos-soft:#142C22;--neg:#DE9077;--ojo:#CFA23F;--ojo-soft:#2A2415}
*{box-sizing:border-box}
body{margin:0;background:var(--ground);color:var(--ink);font:400 16px/1.6 "Source Serif 4",Georgia,serif}
.env{max-width:940px;margin:0 auto;padding:0 18px 80px}
header{padding:46px 0 24px;border-bottom:2px solid var(--ink);margin-bottom:14px}
.kicker{font:500 11px/1 "IBM Plex Mono",monospace;letter-spacing:.15em;text-transform:uppercase;color:var(--accent);margin-bottom:14px}
h1{font:700 clamp(30px,5.5vw,48px)/1.03 "Bricolage Grotesque",system-ui,sans-serif;letter-spacing:-.025em;margin:0 0 12px;text-wrap:balance}
.bajada{font-size:17.5px;line-height:1.55;color:var(--ink2);max-width:62ch;margin:0}
.meta{display:flex;flex-wrap:wrap;gap:0 24px;margin-top:18px;font:500 12px/1.8 "IBM Plex Mono",monospace;color:var(--ink3)}
.meta b{color:var(--ink);font-weight:600}
.casa{background:var(--panel);border:1px solid var(--rule);border-left:3px solid var(--ojo);border-radius:6px;
  padding:14px 16px;margin:22px 0 30px;max-width:70ch;font-size:14.5px;line-height:1.58;color:var(--ink2)}
.casa b{color:var(--ink)}
.p{background:var(--panel);border:1px solid var(--rule);border-radius:8px;padding:13px 15px;margin-bottom:11px}
.p.conalerta{border-left:3px solid var(--ojo)}
.cab{display:flex;gap:8px;align-items:baseline;flex-wrap:wrap;margin-bottom:10px}
.tor{font:600 15px "Bricolage Grotesque",system-ui,sans-serif}
.et{font:600 11px "IBM Plex Mono",monospace;color:var(--ink2)}
.hr,.res{font-size:11.5px;color:var(--ink3);font-family:"IBM Plex Mono",monospace}
.av{font-size:11px;color:var(--ojo);background:var(--ojo-soft);padding:2px 7px;border-radius:3px}
.res{margin-left:auto}
.duelo{display:grid;grid-template-columns:1fr 1fr;gap:9px}
@media(max-width:620px){.duelo{grid-template-columns:1fr}}
.jug{padding:9px 11px;border-radius:6px;background:var(--sunk)}
.jug.fav{background:var(--accent-soft)}
.nom{font:600 14px "Bricolage Grotesque",system-ui,sans-serif}
.nom b{color:var(--accent);font-size:11px;margin-left:3px}
.cu{float:right;font:600 14px "IBM Plex Mono",monospace}
.dat{font:11px/1.5 "IBM Plex Mono",monospace;color:var(--ink2);margin-top:4px}
.dat i,.tray i.vs{font-style:normal;color:var(--ink3)}
.tray{font:11px/1.45 "IBM Plex Mono",monospace;color:var(--ink3);margin-top:4px}
.tray i.g{color:var(--pos);font-weight:600;font-style:normal}
.tray i.p{color:var(--neg);font-weight:600;font-style:normal}
.cifras{display:flex;gap:20px;flex-wrap:wrap;margin-top:11px;padding-top:10px;border-top:1px solid var(--rule);
  font:600 16px "IBM Plex Mono",monospace;font-variant-numeric:tabular-nums}
.cifras label{display:block;font:600 9.5px/1.4 "IBM Plex Sans","Bricolage Grotesque",sans-serif;
  text-transform:uppercase;letter-spacing:.07em;color:var(--ink3);white-space:nowrap}
.cifras .sep{margin-left:auto;padding-left:20px;border-left:1px solid var(--rule)}
.cifras i.sec{font-style:normal;color:var(--ink3);font-weight:500}
.pos{color:var(--pos)} .neg{color:var(--neg)}
.alertas{margin:11px 0 0;padding:0 0 0 18px;font-size:13.5px;line-height:1.55;color:var(--ojo)}
.alertas li{margin-bottom:4px}
.raz{margin:10px 0 0;font-size:12.5px;line-height:1.55;color:var(--ink3)}
.vacias{margin-top:34px}
.vacias h2{font:600 13px "IBM Plex Mono",monospace;letter-spacing:.1em;text-transform:uppercase;color:var(--ink3);margin:0 0 10px}
footer{border-top:1px solid var(--rule);padding-top:20px;margin-top:34px;font-size:13.5px;line-height:1.65;color:var(--ink3);max-width:70ch}
footer b{color:var(--ink2)}
:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
@media (prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}
</style>
<div class="env">
<header>
  <div class="kicker">${tandaDoc ? `${tandaDoc.archivos.length} torneos · ${tandaDoc.generado.slice(0, 10)}` : 'registro completo'}</div>
  <h1>Partidos cotizados hoy</h1>
  <p class="bajada">Los ${cuotas.length} partidos que Betano puso en precio, con todo lo que la ITF sabe de cada jugador encima.
    Ordenados por cuánto rinde la apuesta si nuestro modelo tiene razón.</p>
  <div class="meta">
    <span><b>${filas.filter(f => f.v?.precio).length}</b> con precio</span>
    <span><b>${filas.filter(f => f.v?.alertas?.length).length}</b> con alerta</span>
    <span>generado ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC</span>
  </div>
</header>
<div class="casa">
  <b>La columna que importa es la de la derecha.</b> "Si acierta el mercado" da siempre alrededor de −8%:
  ese es el margen de la casa, y es lo que se pierde jugando cuando el precio tiene razón.
  La única forma de ganar plata es estar en lo cierto donde el mercado no lo está — y sobre los 52 partidos
  que tenemos con precio y resultado, el mercado nos gana. Estos números son para mirar, no son una recomendación.
</div>
${filas.filter(f => f.v?.nivel).map(partido).join('')}
${filas.filter(f => !f.v?.nivel).length ? `<div class="vacias"><h2>Sin datos de nivel · ${filas.filter(f => !f.v?.nivel).length}</h2>
  ${filas.filter(f => !f.v?.nivel).map(partido).join('')}</div>` : ''}
<footer>
  <p><b>nuestra p</b> — el modelo: ΔWTN por grupo de rondas, escalón sub-19, games cedidos en el cuadro y hasta dónde llegó
  en su torneo anterior. Validado dejando un torneo afuera sobre 1243 partidos: 76.5% de acierto.</p>
  <p><b>el mercado</b> — la probabilidad que implica la cuota una vez sacado el margen de la casa.</p>
  <p><b>las alertas</b> son las tres cosas que están medidas: el favorito por WTN que paga sobre 1.50 (rinde −17% entre
  1.50 y 2.00, −69% sobre 2.00), el partido parejo con ΔWTN bajo 2 (el precio decía 58% y pasó 43%, n=23), y el rival
  junior sin ranking conocido. Todo lo demás que uno querría marcar está dentro del ruido con 52 partidos con precio.</p>
</footer>
</div>`;
fs.writeFileSync(path.join(DIR, 'itf-informe.html'), html);
console.log(`\n✓ vigia/itf-informe.html`);
if (sinTorneo.length) {
  console.log(`\n${sinTorneo.length} cuotas sin torneo en el mapa:`);
  for (const q of sinTorneo.slice(0, 10)) console.log(`  ${q.torneo}: ${q.p1} / ${q.p2}`);
}
