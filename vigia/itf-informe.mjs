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
import { ORDEN_PREVIO, GRUPO } from './itf-modelo.mjs';
import { cargar as cargarDecantador, celdas as celdasDecantador, separa } from './itf-decantador.mjs';

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
/* --bet365: la tanda no sale de los PDF de Betano sino de la API de
   OddsPapi (itf-cuotas-bet365.mjs). Mismo análisis, otra fuente. */
const bet365 = process.argv.includes('--bet365');

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
const doc = bet365
  ? (leer(path.join(DIR, 'itf-cuotas-bet365.json')) || { cuotas: [] })
  : (leer(path.join(DIR, 'itf-cuotas-manuales.json')) || { cuotas: [] });
const tandaDoc = (todo || bet365) ? null : leer(path.join(DIR, 'itf-cuotas-tanda.json'));
const enTanda = tandaDoc
  ? new Set(tandaDoc.partidos.map(x => NORM(x.torneo) + '|' + NORM(x.p1) + '|' + NORM(x.p2)))
  : null;
const cuotas = enTanda
  ? doc.cuotas.filter(q => enTanda.has(NORM(q.torneo) + '|' + NORM(q.p1) + '|' + NORM(q.p2))
                        || enTanda.has(NORM(q.torneo) + '|' + NORM(q.p2) + '|' + NORM(q.p1)))
  : doc.cuotas;
/* ---------- LA BRECHA: el precio mundial de bet365 al lado del de Betano.

   Descubierto el 2026-08-27 destripando por qué Sebastián le ganó a la
   regla de la contra apostando a Wygona y Brown: Betano los pagaba 2.07 y
   2.42 cuando bet365 —el libro afilado— tenía 1.83 (¡empate!) y 2.20.
   La "contradicción con el rating" que la contra detectaba era un error
   de Betano a solas, no del mercado, y cuando el libro blando se aparta
   del afilado el que se equivoca es el blando. Sus apuestas eran +3.5% y
   +2.4% contra el precio justo de bet365; las contras, −17% y −15%.

   Regla operativa: la probabilidad "real" de cada lado sale de bet365
   desvigado (itf-cuotas-bet365.json, vía API); el valor de la apuesta se
   calcula con la cuota de Betano. Brecha = ese valor. */
const sharpDoc = leer(path.join(DIR, 'itf-cuotas-bet365.json'));
function brechaDe(n1, n2, g1, g2) {
  if (!sharpDoc || !g1 || !g2) return null;
  const q = (sharpDoc.cuotas || []).find(c =>
    (mismoJugador(c.p1, n1) && mismoJugador(c.p2, n2)) || (mismoJugador(c.p1, n2) && mismoJugador(c.p2, n1)));
  if (!q) return null;
  const orden = mismoJugador(q.p1, n1);
  const s1 = orden ? q.g1 : q.g2, s2 = orden ? q.g2 : q.g1;
  const sum = 1 / s1 + 1 / s2;
  const p1 = (1 / s1) / sum, p2 = (1 / s2) / sum;      /* bet365 desvigado */
  const ev1 = p1 * g1 - 1, ev2 = p2 * g2 - 1;          /* valor a cuota Betano */
  const mejor = ev1 >= ev2 ? { lado: n1, cuota: g1, sharp: s1, p: p1, ev: ev1 }
                           : { lado: n2, cuota: g2, sharp: s2, p: p2, ev: ev2 };
  return { s1, s2, p1, p2, ev1, ev2, mejor };
}

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
  const brecha = bet365 ? null : brechaDe(f1.nombre, f2.nombre, q.g1, q.g2);
  filas.push({ q, t, f1, f2, etapa, brecha, fuenteEtapa: enCuadro ? 'cuadro' : 'deducida',
    via: q.via || 'cuadro', v, horario: horarioDe(q.p1, q.p2), res: resultado(t.clave, q.p1, q.p2) });
}

/* ============================================================
   LA ELECCIÓN — 3 o 4 partidos, no 19.
   Sebastián pidió menos salida y más decisión. Los filtros son duros y
   son los tres que están medidos: nada con el favorito caro, nada
   parejo, y la apuesta tiene que dar positiva con nuestra propia
   probabilidad. Si no quedan cuatro, se muestran los que queden: es
   mejor entregar dos que rellenar con basura.
   ============================================================ */
const MALAS = new Set(['parejo', 'jr-incognito']);

/* EL MANUAL (acordado con Sebastián el 2026-08-26, tras el decantador):
   por ahora hay UNA casilla que apunta a plata, más la brecha.

   LA CASILLA — el favorito del mercado paga entre 1.20 y 1.39 Y nuestro
   modelo le da 70% o más. Es la única celda del decantador donde algo
   manda: 9/9 en el registro, rindiendo +26%. Con el modelo tibio, ese
   mismo favorito cayó 4 de 7 — se pasa.

   LA BRECHA — Betano paga 3%+ por encima del precio justo de bet365.
   No depende de nuestro modelo y vale en cualquier tramo (Wygona, Brown).

   TODO LO DEMÁS SE MIRA, NO SE APUESTA: bajo 1.20 no paga la pena;
   en 1.40–1.99 ningún criterio separa todavía (y llevarle la contra al
   precio ahí perdió 5 de 6); sobre 2.00 no sabe nadie. La contra queda
   en observación en el historial, no en las elegidas. */
const casillaDe = f => {
  if (!f.q.g1 || !f.q.g2 || !f.v?.nivel) return null;
  const ladoFm = f.q.g1 <= f.q.g2 ? 1 : 2;
  const acuerdo = (f.v.nivel.favorito.startsWith(f.f1.nombre) ? 1 : 2) === ladoFm;
  return { cFm: ladoFm === 1 ? f.q.g1 : f.q.g2, ladoFm, acuerdo,
    quien: (ladoFm === 1 ? f.f1 : f.f2).nombre,
    pFm: acuerdo ? f.v.nivel.p : 1 - f.v.nivel.p };
};
const jugadaDe = f => {
  if (!f.v?.precio) return null;
  /* la brecha manda: es la única jugada que no depende de nuestro modelo */
  if (f.brecha?.mejor?.ev >= 0.03)
    return { tipo: 'brecha', quien: f.brecha.mejor.lado, cuota: f.brecha.mejor.cuota,
      rinde: f.brecha.mejor.ev, sharp: f.brecha.mejor.sharp, pSharp: f.brecha.mejor.p };
  const mal = (f.v.alertas || []).some(a => MALAS.has(a.clave));
  const k = casillaDe(f);
  if (!mal && k && k.acuerdo && k.cFm >= 1.20 && k.cFm < 1.40 && k.pFm >= 0.70)
    return { tipo: 'casilla', quien: k.quien, cuota: k.cFm, prob: k.pFm,
      rinde: f.v.precio.val, rindeMercado: f.v.precio.valMercado };
  return null;
};
for (const f of filas) f.jugada = jugadaDe(f);
/* las brechas primero; después la casilla, del respaldo más alto para abajo */
const ELEGIDAS = filas.filter(f => f.jugada)
  .sort((a, b) => (b.jugada.tipo === 'brecha' ? 1 : 0) - (a.jugada.tipo === 'brecha' ? 1 : 0)
    || (b.jugada.prob ?? b.jugada.rinde) - (a.jugada.prob ?? a.jugada.rinde))
  .slice(0, 8);

/* el motivo del descarte, en el idioma del manual */
const motivoDe = f => {
  const mal = (f.v.alertas || []).filter(a => MALAS.has(a.clave)).map(a => a.clave);
  if (mal.includes('parejo')) return 'partido parejo: acá no sabe nadie';
  if (mal.includes('jr-incognito')) return 'el rival es junior y no sé su ranking';
  const k = casillaDe(f);
  if (!k) return 'sin cuota de los dos lados';
  if (k.cFm < 1.20) return 'trámite: gana casi siempre, pero a este precio no paga la pena';
  if (k.cFm < 1.40) return 'favorito real pero el modelo está tibio (bajo 70%): cayó 4 de 7 así';
  if (k.cFm < 2.00) return 'zona de análisis: ningún criterio manda todavía — se mira, no se apuesta';
  return 'sin favorito de verdad (2.00 o más): nadie sabe, nosotros tampoco';
};

/* Traduce lo que el modelo calculó a una frase que se lee sin saber qué
   es un logit. Cada trozo sale de una señal real, no es adorno. */
function enSimple(f) {
  const n = f.v.nivel, pr = f.v.precio, j = f.jugada;
  if (j?.tipo === 'brecha') {
    return {
      fav: j.quien,
      razon: `Betano paga ${j.cuota} por ${j.quien} cuando bet365 —el libro que fija el precio mundial— lo tiene a ${j.sharp}. `
        + `Sacando el margen, el precio mundial dice que gana ${Math.round(j.pSharp * 100)} de cada 100. `
        + `Betano está pagando de más, y cuando el libro blando se aparta del afilado, el que se equivoca es el blando.`,
      mercado: `Esta jugada no depende de nuestro modelo: es puro precio contra precio.`,
      cuenta: `Al precio mundial, apostarle a ${j.quien} a ${j.cuota} deja ${j.rinde >= 0 ? '+' : ''}${Math.round(j.rinde * 100)}% a la larga.`,
      riesgo: `Lo que puede fallar: la cuota de bet365 tiene su hora — si Betano ya la corrigió cuando vayas a apostar, la brecha no está más. Verifica el precio antes de jugarla.`,
    };
  }
  if (j?.tipo === 'contra') {
    const c = j.contra;
    return {
      fav: c.lado,
      razon: `El MEJOR POR RATING es ${n.favorito.replace(/\s*\[\d+\]|\s*(WC|Q|LL|A|SE|PR)$/g, '').trim()} `
        + `pero la casa lo paga a ${c.cuotaFav} — o sea que lo pone parejo o abajo. `
        + `Acá el FAVORITO DEL MERCADO es el otro. Por el acuerdo con Sebastián, en la zona 1.40–1.99 el precio NO decide solo: ahí el favorito del mercado gana apenas 67% y hay que mirar el resto: sabe algo que el `
        + `número no ve (una lesión, la superficie, el estilo, la cancha local).`,
      mercado: `Medido sobre nuestros partidos: cuando nuestro favorito paga ${c.nom}, pierde `
        + `${Math.round(c.pierde * 100)} de cada 100 (${c.n} casos).`,
      cuenta: `Apostarle a ${c.lado} a ${c.cuota} deja ${Math.round(c.rinde * 100)}% a la larga si ese `
        + `${Math.round(c.pierde * 100)}% es el número real.`,
      riesgo: `Lo que puede fallar: son sólo ${c.n} partidos. El margen del ${Math.round(c.pierde * 100)}% `
        + `va de ${Math.round(c.ic[0] * 100)}% a ${Math.round(c.ic[1] * 100)}%, y en el peor borde esto `
        + `pierde ${Math.abs(Math.round(c.rindeMalo * 100))}%. Es para probarla y medirla, no está probada.`,
    };
  }
  const fav = n.favorito.replace(/\s*\[\d+\]|\s*(WC|Q|LL|A|SE|PR)$/g, '').trim();
  const otro = n.favorito.startsWith(f.f1.nombre) ? f.f2 : f.f1;
  const d = n.d;
  const cuanto = d >= 6 ? 'mucho mejor jugador' : d >= 3 ? 'claramente mejor jugador'
    : d >= 1.5 ? 'algo mejor jugador' : 'apenas mejor jugador';
  const trozos = [`${fav} es ${cuanto} en el rating de la ITF: ${n.d.toFixed(1)} puntos de WTN de diferencia`];
  for (const x of n.partes) {
    if (x.nombre === 'sub18' && x.aporte > 0) trozos.push(`y encima tiene 18 años o menos, edad a la que el rating va atrasado`);
    if (x.nombre === 'sub18' && x.aporte < 0) trozos.push(`aunque ${otro.nombre} tiene 18 años y a esa edad el rating va atrasado`);
    if (x.nombre === 'forma' && x.aporte > 0) trozos.push(`llega ganando más cómodo que su rival en este mismo cuadro`);
    if (x.nombre === 'forma' && x.aporte < 0) trozos.push(`aunque su rival llega ganando más cómodo`);
    if (x.nombre === 'previo' && x.aporte > 0) trozos.push(`y la semana pasada llegó más lejos en su torneo`);
    if (x.nombre === 'previo' && x.aporte < 0) trozos.push(`aunque su rival llegó más lejos la semana pasada`);
  }
  const razon = trozos.join(', ').replace(/, y /g, ' y ') + '.';
  const mercado = `la casa lo paga a ${pr.cuota}: es como decir que gana ${Math.round(pr.devig * 100)} de cada 100. `
    + `Nosotros creemos que gana ${Math.round(n.p * 100)}.`;
  const cuenta = `Si tenemos razón, a la larga esto deja ${Math.round(pr.val * 100)}%. `
    + `Si la tiene Betano, pierde ${Math.abs(Math.round(pr.valMercado * 100))}%.`;
  const riesgo = `Lo que puede fallar: le damos ${Math.round(n.p * 100)}%, así que pierde 1 de cada `
    + `${Math.round(1 / Math.max(0.01, 1 - n.p))}. Cuando pase no es que nos equivocamos — a esta cuota una `
    + `derrota se lleva ${Math.ceil(1 / (pr.cuota - 1))} aciertos.`;
  if (j?.tipo === 'casilla') return { fav, razon, cuenta, riesgo,
    mercado: mercado + ` Es LA CASILLA del manual: favorito del mercado entre 1.20 y 1.39 con respaldo `
      + `fuerte nuestro — la única celda del decantador que hasta hoy apunta a plata (9/9, rindiendo +26% en el registro).` };
  return { fav, razon, mercado, cuenta, riesgo };
}

/* ============================================================
   VEREDICTOS + HISTORIA — quién gana según el modelo, y cómo nos fue.

   Pedido por Sebastián el 2026-08-27: lo que quiere ver TODOS LOS DÍAS
   es quién gana con nuestros datos, con su análisis, y la comparación
   contra lo que pasó de verdad. Cada corrida guarda los veredictos del
   día en veredictos-historia.json y califica los de días anteriores con
   los marcadores que trae el índice de OddsPapi (statusId 2 + scores).
   Así la página siempre abre con la tabla de hoy y el historial de
   aciertos acumulándose solo. Se califica también al favorito del
   mercado, para que la comparación modelo-contra-mercado sea con
   resultados reales y no con teoría.
   ============================================================ */
const VEREDICTOS = filas.filter(f => f.v?.nivel).map(f => {
  const lado = f.v.nivel.favorito.startsWith(f.f1.nombre) ? 1 : 2;
  const dev = (f.q.g1 && f.q.g2) ? (1 / (lado === 1 ? f.q.g1 : f.q.g2)) / (1 / f.q.g1 + 1 / f.q.g2) : null;
  /* crit: los campos que el decantador cruza, orientados al favorito del
     MERCADO (cuota más baja). Con esto cada día calificado afina solo
     las celdas de "qué criterios mandan". */
  const crit = (() => {
    if (!f.q.g1 || !f.q.g2) return null;
    const ladoFm = f.q.g1 <= f.q.g2 ? 1 : 2;
    const acuerdo = ladoFm === lado;
    const s = acuerdo ? 1 : -1;
    const fFm = ladoFm === 1 ? f.f1 : f.f2, fRi = ladoFm === 1 ? f.f2 : f.f1;
    const sg = n => { const x = (f.v.nivel.partes || []).find(p => p.nombre === n); return x ? Math.sign(s * x.aporte) : null };
    return {
      cuota: ladoFm === 1 ? f.q.g1 : f.q.g2, ladoFm, acuerdo,
      pFm: +(acuerdo ? f.v.nivel.p : 1 - f.v.nivel.p).toFixed(3),
      dW: fFm.wtn != null && fRi.wtn != null ? +(fRi.wtn - fFm.wtn).toFixed(2) : null,
      forma: sg('forma'), previo: sg('previo'),
      grupo: GRUPO[f.etapa] ?? null,
      edadFm: fFm.nacido ? 2026 - fFm.nacido : null,
      edadRi: fRi.nacido ? 2026 - fRi.nacido : null,
    };
  })();
  return {
    crit,
    /* la jugada del manual, tal cual la eligió la página (null = se mira) */
    jugada: f.jugada ? { tipo: f.jugada.tipo, quien: f.jugada.quien,
      cuota: f.jugada.cuota, prob: f.jugada.prob ?? null } : null,
    fixtureId: f.q.fixtureId ?? null, inicio: f.q.inicio ?? null,
    torneo: f.t.nombre, etapa: f.etapa, p1: f.f1.nombre, p2: f.f2.nombre,
    gana: f.v.nivel.favorito.replace(/\s*\[\d+\]|\s*(WC|Q|LL|A|SE|PR)$/g, '').trim(),
    lado, p: +(f.v.nivel.p).toFixed(3),
    pMercado: dev != null ? +dev.toFixed(3) : null,
    soloWtn: +(f.v.nivel.soloNivel).toFixed(3),
    señales: (f.v.nivel.partes || []).filter(x => x.nombre !== 'nivel').map(x => x.nombre),
    razon: f.v.razon,
  };
});
fs.writeFileSync(path.join(DIR, 'itf-veredictos.json'), JSON.stringify({
  generado: new Date().toISOString(), fuente: bet365 ? 'bet365' : 'betano', partidos: VEREDICTOS }, null, 1));

const HISTF = path.join(DATOS, 'veredictos-historia.json');
const HOY = new Date().toISOString().slice(0, 10);
const historia = leer(HISTF) || { dias: {} };
/* calificar lo pendiente con los marcadores del índice de OddsPapi */
const idxHist = leer(path.join(DATOS, 'historico-indice.json')) || { partidos: {} };
for (const arr of Object.values(historia.dias)) for (const v of arr) {
  if (v.res || !v.fixtureId) continue;
  const fx = idxHist.partidos[v.fixtureId];
  if (!fx || fx.statusId !== 2 || fx.s1 == null || fx.s2 == null || fx.s1 === fx.s2) continue;
  const ganoLado = fx.s1 > fx.s2 ? 1 : 2;
  v.res = { ganador: ganoLado === 1 ? fx.p1 : fx.p2, marcador: fx.s1 + '-' + fx.s2 };
  v.acerto = ganoLado === v.lado;
  if (v.pMercado != null) v.acertoMercado = (v.pMercado >= 0.5) === (ganoLado === v.lado);
}
/* los de hoy (misma corrida repetida = se reemplazan, no se duplican) */
if (bet365) historia.dias[HOY] = VEREDICTOS.map(v => {
  const previo = (historia.dias[HOY] || []).find(x => x.fixtureId && x.fixtureId === v.fixtureId);
  return previo?.res ? { ...v, res: previo.res, acerto: previo.acerto, acertoMercado: previo.acertoMercado } : v;
});
historia.actualizado = new Date().toISOString();
fs.writeFileSync(HISTF, JSON.stringify(historia, null, 1));

/* ---------- consola: las elegidas primero, el resto en una línea ---------- */
const T = (s, n) => String(s ?? '').slice(0, n).padEnd(n);
console.log(`\n${cuotas.length} partidos con cuota${bet365 ? ' · fuente bet365 vía API' : ''}${tandaDoc ? ` · ${tandaDoc.archivos.length} torneos` : ''}`
  + ` · ${filas.filter(f => f.v?.precio).length} analizados\n`);

if (ELEGIDAS.length) {
  console.log('═'.repeat(76));
  console.log(`  DÓNDE PARARSE HOY — ${ELEGIDAS.length} en la casilla`);
  console.log('═'.repeat(76));
  for (const [i, f] of ELEGIDAS.entries()) {
    const s = enSimple(f), j = f.jugada;
    console.log(`\n  ${i + 1}. ${j.tipo === 'contra' ? 'CONTRA · ' : ''}${s.fav}  a ${j.cuota}`);
    console.log(`     ${f.t.nombre} · ${f.etapa}${f.horario ? ' · ' + (f.horario.hora || f.horario.fecha) : ''}`);
    console.log(`\n     ${s.razon}`);
    console.log(`     ${s.mercado}`);
    console.log(`     ${s.cuenta}`);
    console.log(`     ${s.riesgo}`);
  }
} else {
  console.log('  HOY NADIE PISA LA CASILLA.');
  console.log('  Ningún favorito del mercado entre 1.20 y 1.39 con respaldo de 70%+ nuestro,');
  console.log('  y sin brecha contra bet365. El resto del tablero se mira, no se apuesta.');
}
const descartadas = filas.filter(f => f.v?.precio && !ELEGIDAS.includes(f));
if (descartadas.length) {
  console.log('\n' + '─'.repeat(76));
  console.log(`  LAS OTRAS ${descartadas.length}, y por qué no\n`);
  for (const f of descartadas.sort((a, b) => (b.v.precio.val ?? -9) - (a.v.precio.val ?? -9)))
    console.log(`  ${T(f.v.nivel?.favorito ?? '—', 28)} ${String(f.v.precio.cuota).padStart(5)}  ${motivoDe(f)}`);
}
const conRegla = filas.filter(f => f.v?.regla);
if (conRegla.length) {
  console.log('\n' + '─'.repeat(76));
  console.log('  REGLAS DE PERDEDOR QUE DISPARAN\n');
  for (const f of conRegla) {
    const r = f.v.regla;
    console.log(`  ${r.paga ? '►' : '·'} ${f.t.nombre} · ${f.etapa} — a favor de ${r.lado}`);
    console.log(`    necesita ${r.cuotaMin.toFixed(2)} · Betano paga ${r.cuotaOfrecida ?? '—'} → ${r.paga ? 'PAGA' : 'no alcanza'}`);
  }
}

/* ---------- HTML ----------
   Cuatro elegidas arriba, grandes, con la explicación en castellano.
   Todo lo demás en una tabla chica al final con el motivo del descarte:
   está a la vista pero no compite por la atención. */
const trayHtml = f => f.tray.length
  ? f.tray.map(x => `<i class="${x.gano ? 'g' : 'p'}">${x.etapa}${x.gano ? '✓' : '✗'}</i> `
    + x.sets.map((s, i) => `${s}-${x.setsRiv[i] ?? ''}`).join(' ')).join(' · ')
  : 'debuta';

const tarjeta = (f, i) => {
  const t = enSimple(f), n = f.v.nivel, pr = f.v.precio, j = f.jugada;
  const rival = j.tipo === 'contra' ? n.favorito : (n.favorito.startsWith(f.f1.nombre) ? f.f2.nombre : f.f2.nombre);
  const otroNom = n.favorito.startsWith(f.f1.nombre) ? f.f2.nombre : f.f1.nombre;
  return `<article class="pick ${j.tipo}">
    <div class="rank">${i + 1}</div>
    <div class="cuerpo">
      ${j.tipo === 'contra' ? '<div class="sello">en contra del rating</div>'
        : j.tipo === 'casilla' ? '<div class="sello">la casilla del manual</div>'
        : j.tipo === 'brecha' ? '<div class="sello">brecha contra bet365</div>' : ''}
      <h2>${esc(t.fav)} <span class="cuota">a ${j.cuota}</span></h2>
      <div class="donde">contra ${esc(j.tipo === 'contra' ? n.favorito.replace(/\s*\[\d+\]|\s*(WC|Q|LL|A|SE|PR)$/g, '').trim() : otroNom)} · ${esc(f.t.nombre)} · ${esc(f.etapa)}${f.horario ? ' · ' + esc(f.horario.hora || f.horario.fecha) : ''}</div>
      <p class="porque">${esc(t.razon)}</p>
      ${j.tipo === 'contra' ? `<div class="dosbarras">
        <div class="bl"><label>pierde</label><div class="bar"><span style="width:${Math.round(j.prob * 100)}%"></span></div><b>${Math.round(j.prob * 100)}%</b></div>
        <div class="bl"><label>hace falta</label><div class="bar mkt"><span style="width:${Math.round(100 / j.cuota)}%"></span></div><b>${Math.round(100 / j.cuota)}%</b></div>
      </div>
      <p class="cuenta"><b>Si ese ${Math.round(j.prob * 100)}% es real</b>, esto deja <b class="pos">${Math.round(j.rinde * 100)}%</b>.
        En el peor borde del margen, pierde <b class="neg">${Math.abs(Math.round(j.rindeMalo * 100))}%</b>.</p>`
      : `<div class="dosbarras">
        <div class="bl"><label>nosotros</label><div class="bar"><span style="width:${Math.round(n.p * 100)}%"></span></div><b>${Math.round(n.p * 100)}%</b></div>
        <div class="bl"><label>Betano</label><div class="bar mkt"><span style="width:${Math.round(pr.devig * 100)}%"></span></div><b>${Math.round(pr.devig * 100)}%</b></div>
      </div>
      <p class="cuenta"><b>Si tenemos razón</b>, a la larga esto deja <b class="pos">${Math.round(pr.val * 100)}%</b>.
        Si la tiene Betano, pierde <b class="neg">${Math.abs(Math.round(pr.valMercado * 100))}%</b>.</p>`}
      <p class="riesgo">${esc(t.riesgo)}</p>
      ${f.v.regla ? `<p class="reglaln"><b>${f.v.regla.clave === 'caida' ? 'Regla de caída' : 'Regla de firme'}:</b>
        ${esc(f.v.regla.texto)}</p>` : ''}
      <details><summary>los números crudos</summary>
        <div class="crudo">
          <div><b>${esc(f.f1.nombre)}</b> — WTN ${f.f1.wtn ?? '—'} · ${f.f1.nacido ? 2026 - f.f1.nacido + ' años' : 'edad —'} · ATP ${f.f1.atp ?? '—'} · ${trayHtml(f.f1)}</div>
          <div><b>${esc(f.f2.nombre)}</b> — WTN ${f.f2.wtn ?? '—'} · ${f.f2.nacido ? 2026 - f.f2.nacido + ' años' : 'edad —'} · ATP ${f.f2.atp ?? '—'} · ${trayHtml(f.f2)}</div>
          <div class="raz">${esc(f.v.razon)}</div>
        </div></details>
    </div></article>`;
};

const descart = filas.filter(f => f.v?.precio && !ELEGIDAS.includes(f))
  .sort((a, b) => (b.v.precio.val ?? -9) - (a.v.precio.val ?? -9));

const html = `<title>Las que elijo hoy</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,500;12..96,700&family=Source+Serif+4:opsz,wght@8..60,400;8..60,600&family=IBM+Plex+Mono:wght@400;500;600&display=swap">
<style>
:root{--ground:#F5F7F8;--panel:#FFFFFF;--sunk:#EDF1F3;--ink:#141F28;--ink2:#54687A;--ink3:#8496A5;
  --rule:#DBE3E8;--accent:#1B5B70;--accent-soft:#E2EEF2;--pos:#2C7A58;--pos-soft:#DEEDE5;
  --neg:#9E4C33;--ojo:#856512;--ojo-soft:#F6EEDC}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){
  --ground:#0D1319;--panel:#141C24;--sunk:#111920;--ink:#DDE6ED;--ink2:#93A5B4;--ink3:#647686;
  --rule:#222E39;--accent:#5BA9BF;--accent-soft:#15303A;--pos:#57B98A;--pos-soft:#142C22;
  --neg:#DE9077;--ojo:#CFA23F;--ojo-soft:#2A2415}}
:root[data-theme="dark"]{--ground:#0D1319;--panel:#141C24;--sunk:#111920;--ink:#DDE6ED;--ink2:#93A5B4;
  --ink3:#647686;--rule:#222E39;--accent:#5BA9BF;--accent-soft:#15303A;--pos:#57B98A;--pos-soft:#142C22;
  --neg:#DE9077;--ojo:#CFA23F;--ojo-soft:#2A2415}
*{box-sizing:border-box}
body{margin:0;background:var(--ground);color:var(--ink);font:400 17px/1.62 "Source Serif 4",Georgia,serif}
.env{max-width:760px;margin:0 auto;padding:0 18px 70px}
header{padding:46px 0 20px}
.kicker{font:500 11px/1 "IBM Plex Mono",monospace;letter-spacing:.15em;text-transform:uppercase;color:var(--accent);margin-bottom:13px}
h1{font:700 clamp(32px,7vw,52px)/1.02 "Bricolage Grotesque",system-ui,sans-serif;letter-spacing:-.03em;margin:0 0 12px}
.bajada{font-size:18px;color:var(--ink2);margin:0;max-width:54ch}
.pick{display:flex;gap:16px;background:var(--panel);border:1px solid var(--rule);border-radius:10px;
  padding:20px 22px;margin-bottom:14px}
.rank{font:700 30px/1 "Bricolage Grotesque",system-ui,sans-serif;color:var(--accent);
  opacity:.32;min-width:34px;padding-top:3px}
.cuerpo{flex:1;min-width:0}
.pick.contra{border-color:var(--ojo);border-left:4px solid var(--ojo)}
.pick.contra .rank{color:var(--ojo)}
.sello{display:inline-block;font:600 10px "IBM Plex Mono",monospace;letter-spacing:.1em;text-transform:uppercase;
  background:var(--ojo-soft);color:var(--ojo);padding:3px 8px;border-radius:3px;margin-bottom:8px}
.pick h2{font:700 25px/1.15 "Bricolage Grotesque",system-ui,sans-serif;letter-spacing:-.02em;margin:0 0 4px;text-wrap:balance}
.cuota{font:600 19px "IBM Plex Mono",monospace;color:var(--accent);white-space:nowrap}
.donde{font:500 12.5px "IBM Plex Mono",monospace;color:var(--ink3);margin-bottom:14px}
.porque{margin:0 0 15px;font-size:17px;line-height:1.6}
.dosbarras{display:flex;flex-direction:column;gap:7px;margin-bottom:15px;padding:12px 14px;background:var(--sunk);border-radius:7px}
.bl{display:flex;align-items:center;gap:11px}
.bl label{font:600 10px "IBM Plex Mono",monospace;letter-spacing:.07em;text-transform:uppercase;
  color:var(--ink3);min-width:66px}
.bl .bar{flex:1;height:9px;background:var(--rule);border-radius:5px;overflow:hidden}
.bl .bar span{display:block;height:100%;background:var(--accent);border-radius:5px}
.bl .bar.mkt span{background:var(--ink3)}
.bl b{font:600 14px "IBM Plex Mono",monospace;min-width:38px;text-align:right;font-variant-numeric:tabular-nums}
.cuenta{margin:0 0 9px;font-size:15.5px;line-height:1.55}
.cuenta b{font-weight:600} .pos{color:var(--pos)} .neg{color:var(--neg)}
.riesgo{margin:0;font-size:14px;line-height:1.55;color:var(--ink2)}
.reglaln{margin:12px 0 0;padding:11px 13px;background:var(--pos-soft);border-radius:6px;
  font-size:14px;line-height:1.55;color:var(--ink2)}
details{margin-top:14px;border-top:1px solid var(--rule);padding-top:11px}
summary{font:500 12px "IBM Plex Mono",monospace;color:var(--ink3);cursor:pointer;list-style:none}
summary::before{content:"▸ ";color:var(--accent)}
details[open] summary::before{content:"▾ "}
.crudo{margin-top:10px;font:11.5px/1.6 "IBM Plex Mono",monospace;color:var(--ink2);
  display:flex;flex-direction:column;gap:6px}
.crudo b{color:var(--ink)} .crudo .g{color:var(--pos);font-style:normal;font-weight:600}
.crudo .p{color:var(--neg);font-style:normal;font-weight:600}
.crudo .raz{color:var(--ink3);border-top:1px solid var(--rule);padding-top:7px;margin-top:2px}
.verd{margin-bottom:34px}
.vt{font:700 20px/1.2 "Bricolage Grotesque",system-ui,sans-serif;letter-spacing:-.015em;margin:0 0 12px}
.envt{overflow-x:auto;background:var(--panel);border:1px solid var(--rule);border-radius:8px}
.envt table{width:100%;min-width:640px;border-collapse:collapse;font:13px "IBM Plex Mono",monospace;font-variant-numeric:tabular-nums}
.envt thead th{text-align:left;padding:9px 10px;border-bottom:1.5px solid var(--rule);
  font:600 10px "IBM Plex Mono",monospace;letter-spacing:.09em;text-transform:uppercase;color:var(--ink3);white-space:nowrap}
.envt thead th.n{text-align:right}
.envt td{padding:7px 10px;border-bottom:1px solid var(--rule);white-space:nowrap}
.envt td.n{text-align:right} .envt td.sec{color:var(--ink3)}
.envt td.quien{font:600 14.5px "Bricolage Grotesque",system-ui,sans-serif;white-space:normal}
.envt tr.ok td.quien{color:var(--pos)} .envt tr.mal td.quien{color:var(--neg)}
.envt tr.det td{border-bottom:1px solid var(--rule);padding:0 10px 7px;white-space:normal}
.envt tr.det details{margin:0;border:0;padding:0}
.envt tr.det summary{font:500 10.5px "IBM Plex Mono",monospace;color:var(--ink3)}
.envt tr.det p{margin:6px 0 0;font:13px/1.55 "Source Serif 4",Georgia,serif;color:var(--ink2)}
.envt tr.tot td{border-top:2px solid var(--rule);border-bottom:0}
.envt tr.grupo td{background:var(--sunk);padding:10px;white-space:normal;border-bottom:1.5px solid var(--rule)}
.envt tr.grupo b{font:700 12px "Bricolage Grotesque",system-ui,sans-serif;letter-spacing:.02em}
.envt tr.grupo i{font:italic 12px/1.5 "Source Serif 4",Georgia,serif;color:var(--ink2)}
i.dif{font-style:normal;color:var(--ojo);font-weight:700}
.notaverd{margin:10px 2px 0;font-size:13.5px;line-height:1.55;color:var(--ink3)}
.nada{background:var(--panel);border:1px solid var(--rule);border-left:3px solid var(--ojo);border-radius:8px;
  padding:20px 22px;font-size:16px;line-height:1.6;color:var(--ink2)}
.nada b{color:var(--ink)}
.act{margin-top:14px;display:flex;flex-wrap:wrap;align-items:center;gap:10px}
.act button{font:600 14px/1 'Bricolage Grotesque',sans-serif;color:var(--panel);background:var(--accent);
  border:0;border-radius:6px;padding:9px 14px;cursor:pointer}
.act button:disabled{opacity:.5;cursor:default}
#act-token{flex-basis:100%;background:var(--sunk);border:1px solid var(--rule);border-radius:8px;padding:10px 14px;max-width:64ch}
#act-token p{margin:0 0 8px;font-size:13px}
#act-token input{font:13px 'IBM Plex Mono',monospace;color:var(--ink);background:var(--panel);
  border:1px solid var(--rule);border-radius:6px;padding:7px 9px;width:min(320px,60%)}
#act-token button{font-size:13px;padding:7px 11px;margin-left:6px}
#act-estado{font-size:13px}
.resto{margin-top:38px}
.resto h3{font:600 12px "IBM Plex Mono",monospace;letter-spacing:.13em;text-transform:uppercase;
  color:var(--ink3);margin:0 0 12px}
.resto table{width:100%;border-collapse:collapse;font:13px "IBM Plex Mono",monospace}
.resto td{padding:7px 8px;border-bottom:1px solid var(--rule);vertical-align:baseline}
.resto td:first-child{font-family:"Source Serif 4",Georgia,serif;font-size:14.5px;color:var(--ink)}
.resto td.c{text-align:right;white-space:nowrap;color:var(--ink2)}
.resto td.m{color:var(--ink3);font-family:"Source Serif 4",Georgia,serif;font-size:14px}
footer{border-top:1px solid var(--rule);padding-top:20px;margin-top:36px;font-size:14px;line-height:1.65;color:var(--ink3)}
footer b{color:var(--ink2)}
:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
@media(max-width:560px){.pick{padding:16px}.rank{font-size:22px;min-width:24px}.pick h2{font-size:21px}}
</style>
<div class="env">
<header>
  <div class="kicker">${bet365 ? 'cuotas bet365 vía API · ' + (doc.generado || '').slice(0, 10) : tandaDoc ? `${tandaDoc.archivos.length} torneos · ${tandaDoc.generado.slice(0, 10)}` : 'registro completo'} · ${cuotas.length} partidos mirados</div>
  <h1>Dónde pararse hoy</h1>
  <p class="bajada">${ELEGIDAS.length
    ? `${ELEGIDAS.length} de ${filas.filter(f => f.v?.precio).length} pisan la casilla. Las otras están abajo con el motivo por el que no.`
    : 'Hoy nadie pisa la casilla: se mira, no se apuesta.'}</p>
  <div class="act">
    <button id="act-btn" type="button">⟳ Actualizar cuotas y tablas</button>
    <span id="act-estado" class="sec"></span>
    <div id="act-token" hidden>
      <p class="sec">Para que el botón funcione hace falta, UNA sola vez, un token de GitHub que queda
        guardado solo en este navegador. Se crea en
        <b>github.com → Settings → Developer settings → Fine-grained tokens → Generate new token</b>,
        dándole acceso únicamente al repositorio <b>BETO</b> con el permiso <b>Actions: Read and write</b>.</p>
      <input id="act-pat" type="password" placeholder="pega el token acá" autocomplete="off">
      <button id="act-guardar" type="button">Guardar</button>
    </div>
  </div>
</header>
<div class="nada" style="border-left-color:var(--accent)">
  <b>El manual, mientras el decantador no diga otra cosa.</b>
  Se apuesta en dos lugares y nada más: <b>la casilla</b> — el favorito del mercado paga entre 1.20 y 1.39
  y nuestro modelo le da 70% o más (9/9 en el registro, +26%) — y <b>la brecha</b> — Betano paga 3%+ sobre el
  precio justo de bet365, en cualquier tramo. Todo lo demás se mira: bajo 1.20 no paga la pena; en 1.40–1.99
  ningún criterio separa todavía (y llevarle la contra al precio ahí perdió 5 de 6); sobre 2.00 no sabe nadie.
</div>
${ELEGIDAS.length ? ELEGIDAS.map(tarjeta).join('') : ''}
${''/* función de fila, definida inline */}
${(() => { globalThis.filaVeredicto = (v, i) => {
  const hoyV = (historia.dias[HOY] || []).find(x => x.fixtureId && x.fixtureId === v.fixtureId);
  const res = hoyV?.res;
  const dif = v.pMercado != null ? v.p - v.pMercado : null;
  return `<tr class="${res ? (hoyV.acerto ? 'ok' : 'mal') : ''}">
    <td class="n sec">${i}</td>
    <td class="quien">${esc(v.gana)}</td>
    <td class="sec">${esc(v.lado === 1 ? v.p2 : v.p1)}</td>
    <td class="sec">${esc(v.torneo.replace(/^M\d+\+?H? /, ''))} · ${esc(v.etapa)}</td>
    <td class="n"><b>${Math.round(v.p * 100)}%</b></td>
    <td class="n sec">${v.pMercado != null ? Math.round(v.pMercado * 100) + '%' : '—'}${dif != null && Math.abs(dif) >= 0.12 ? ' <i class="dif">±</i>' : ''}</td>
    <td class="sec">${v.señales.length ? esc(v.señales.join(' ')) : ''}</td>
    <td>${res ? (hoyV.acerto ? '✓ ' : '✗ ') + esc(res.ganador.split(' ').slice(-1)[0]) + ' ' + esc(res.marcador) : '<i class="sec">por jugar</i>'}</td>
  </tr>
  <tr class="det"><td></td><td colspan="7"><details><summary>análisis</summary><p>${esc(v.razon)}</p></details></td></tr>`;
}; return '' })()}
<section class="verd">
  <h2 class="vt">Quién gana hoy</h2>
  <p class="notaverd" style="margin:0 0 12px">Agrupado por el ACUERDO de tramos (2026-08-27): la categoría la fija
    la cuota del favorito del mercado, y lo que significa cada tramo está medido sobre nuestro registro.</p>
  <div class="envt"><table>
    <thead><tr><th></th><th>gana</th><th>contra</th><th>dónde</th>
      <th class="n">modelo</th><th class="n">mercado</th><th>señales</th><th>resultado</th></tr></thead>
    <tbody>${(() => {
      const cuotaFav = v => { const f = filas.find(x => x.q.fixtureId === v.fixtureId || (x.f1.nombre === v.p1 && x.f2.nombre === v.p2));
        if (!f?.q.g1 || !f?.q.g2) return null; return Math.min(f.q.g1, f.q.g2); };
      const tramoDe = c => c == null ? 3 : c < 1.20 ? 0 : c < 1.40 ? 1 : c < 2.00 ? 2 : 3;
      const TRAMOS = [
        ['TRÁMITE — favorito bajo 1.20', 'ganó 93% en nuestro registro (14/15). Casi nunca paga la pena apostarlo.'],
        ['FAVORITOS REALES — 1.20 a 1.39', 'ganó 75% (12/16); cuando el modelo también lo respalda, 83% (10/12). Ojo: a ese precio, apostarlos TODOS rindió −4% — acá se acierta el partido, no necesariamente la plata.'],
        ['ZONA DE ANÁLISIS — 1.40 a 1.99', 'el favorito del mercado gana solo 67% (14/21): acá el precio NO decide, se mira todo lo demás. (Honesto: nuestro modelo todavía no separa en esta zona — 67% con y sin su respaldo. Es donde el historial diario tiene que enseñarnos.)'],
        ['PAREJOS Y LARGOS — 2.00 o más', 'no hay favorito de verdad: nadie sabe, nosotros tampoco.'],
      ];
      const orden = [...VEREDICTOS].map(v => ({ v, c: cuotaFav(v), t: tramoDe(cuotaFav(v)) }))
        .sort((x, y) => x.t - y.t || y.v.p - x.v.p);
      let ultimo = -1, i = 0, out = '';
      for (const { v, t } of orden) {
        if (t !== ultimo) { ultimo = t;
          out += `<tr class="grupo"><td colspan="8"><b>${TRAMOS[t][0]}</b><i> — ${TRAMOS[t][1]}</i></td></tr>`; }
        out += filaVeredicto(v, ++i);
      }
      return out;
    })()}
  </tbody></table></div>
  <p class="notaverd">Cuando el modelo dice 90%, gana ~9 de 10: en una tanda como esta lo normal es que
    ${Math.max(1, Math.round(VEREDICTOS.reduce((s, v) => s + (1 - v.p), 0)))} salgan al revés, casi siempre en la mitad de abajo.
    El <i class="dif">±</i> marca donde el modelo y el mercado se separan 12 puntos o más.</p>
</section>
${(() => {
  const dias = Object.entries(historia.dias).sort((x, y) => y[0].localeCompare(x[0])).slice(0, 10);
  const conRes = dias.map(([f, arr]) => [f, arr.filter(v => v.res)]).filter(([, a]) => a.length);
  if (!conRes.length) return '';
  let tM = 0, tK = 0, tMk = 0, tKk = 0;
  const filasH = conRes.map(([f, a]) => {
    const kM = a.filter(v => v.acerto).length, kMk = a.filter(v => v.acertoMercado).length;
    tM += a.length; tK += kM; tMk += a.filter(v => v.acertoMercado != null).length; tKk += kMk;
    const fallos = a.filter(v => !v.acerto).map(v => esc(v.gana.split(' ').slice(-1)[0]) + ' cayó con ' + esc((v.lado === 1 ? v.p2 : v.p1).split(' ').slice(-1)[0]));
    return `<tr><td>${f}</td><td class="n"><b>${kM}/${a.length}</b></td>
      <td class="n sec">${kMk}/${a.filter(v => v.acertoMercado != null).length}</td>
      <td class="sec">${fallos.slice(0, 4).join(' · ')}${fallos.length > 4 ? ' · +' + (fallos.length - 4) : ''}</td></tr>`;
  }).join('');
  return `<section class="verd">
    <h2 class="vt">Cómo venimos — modelo contra mercado, con resultados reales</h2>
    <div class="envt"><table>
      <thead><tr><th>día</th><th class="n">el modelo acertó</th><th class="n">el mercado</th><th>los que fallamos</th></tr></thead>
      <tbody>${filasH}
      <tr class="tot"><td>total</td><td class="n"><b>${tK}/${tM}</b> (${tM ? Math.round(100 * tK / tM) : 0}%)</td>
        <td class="n sec">${tKk}/${tMk} (${tMk ? Math.round(100 * tKk / tMk) : 0}%)</td><td></td></tr></tbody>
    </table></div></section>`;
})()}
${(() => {
  /* EL DECANTADOR — pedido por Sebastián el 2026-08-26: dentro de cada
     tramo, qué criterios mandan. Cada criterio parte el tramo en dos y
     se muestra cómo le fue al favorito del mercado por lado, con su
     intervalo: si los intervalos se pisan, el criterio NO separa
     todavía. La tabla se recalcula sola con cada día calificado. */
  const filasD = cargarDecantador();
  const deDias = filasD.filter(c => c.origen !== 'registro').length;
  const pc = x => Math.round(100 * x) + '%';
  const ladoTd = l => l && l.n
    ? `<td class="n"><b>${l.k}/${l.n}</b> (${pc(l.pct)})</td><td class="n sec">${pc(l.ic[0])}–${pc(l.ic[1])}</td>`
    : `<td class="n sec">—</td><td class="n sec"></td>`;
  const bloques = celdasDecantador(filasD).map(t => {
    if (!t.base.n) return '';
    const filasT = t.crit.map(c => `<tr${separa(c) ? ' class="ok"' : ''}>
      <td>${esc(c.texto)}${separa(c) ? ' <b>← separa</b>' : ''}</td>
      ${ladoTd(c.si)}${ladoTd(c.no)}</tr>`).join('');
    return `<h3 style="margin:18px 0 6px">${esc(t.texto)} · base: gana ${pc(t.base.k / t.base.n)} (${t.base.k}/${t.base.n})</h3>
    <div class="envt"><table>
      <thead><tr><th>criterio (del favorito del mercado)</th><th class="n">con el criterio</th><th class="n">IC 95</th>
        <th class="n">sin el criterio</th><th class="n">IC 95</th></tr></thead>
      <tbody>${filasT}</tbody></table></div>`;
  }).join('');
  return `<section class="verd">
    <h2 class="vt">El decantador — qué criterios mandan dentro de cada tramo</h2>
    <p class="notaverd" style="margin:0 0 4px">Sobre ${filasD.length} partidos calificados (${filasD.length - deDias} del registro
      + ${deDias} de los días que siguen). Regla de lectura: un criterio manda solo cuando sus dos intervalos NO se tocan —
      con estos n casi ninguno llega todavía, y eso también es información.</p>
    <p class="notaverd" style="margin:0 0 12px">Lo que va decantando hasta hoy: en <b>1.20–1.39</b> el candidato más firme es
      el respaldo fuerte de nuestro modelo (9/9 cuando le da 70%+, 3/7 cuando no — le falta un pelo para separar formalmente).
      En <b>1.40–1.99</b> ningún criterio manda aún; el dato más incómodo es que cuando ahí el precio contradice al rating,
      el mercado acertó 5 de 6 — la misma lección de Wygona y Brown. Cada día calificado afina estas celdas.</p>
    ${bloques}</section>`;
})()}
<div class="resto">
  <h3>Las otras ${descart.length}, y por qué no</h3>
  <table><tbody>
    ${descart.map(f => `<tr><td>${esc(f.v.nivel?.favorito ?? '—')}</td>
      <td class="c">${f.v.precio.cuota}</td>
      <td class="m">${esc(motivoDe(f))}</td></tr>`).join('')}
  </tbody></table>
</div>
<footer>
  <p><b>De dónde sale nuestro número.</b> Cuánto mejor es cada uno según el rating WTN de la ITF, si alguno tiene 18 años
  o menos (a esa edad el rating va atrasado), cuántos games cedió cada uno en este mismo cuadro, y hasta dónde llegó cada
  uno la semana pasada. Probado sobre 1243 partidos jugados: acierta 76.5%.</p>
  <p><b>Y la advertencia de siempre.</b> La casilla lleva 9/9, pero son 9: el decantador de arriba muestra el
  intervalo real y todavía no separa formalmente. Se juega chico, se anota todo, y cada día calificado dice
  si el manual aguanta o se corrige.</p>
</footer>
<script>
/* El botón "Actualizar": dispara el workflow tabla.yml por la API de GitHub
   con un token que vive SOLO en el navegador de Sebastián (localStorage),
   espera a que termine y recarga. En copias sin red hacia GitHub (p. ej. el
   artefacto de Claude, que bloquea fetch externo) avisa y no rompe nada. */
(function(){
  var REPO='smartinoli/BETO', RAMA='claude/itf-scrapers-prize-money-7oy59k', WF='tabla.yml';
  var btn=document.getElementById('act-btn'), est=document.getElementById('act-estado'),
      caja=document.getElementById('act-token'), inp=document.getElementById('act-pat'),
      gu=document.getElementById('act-guardar');
  if(!btn) return;
  function lee(){ try{return localStorage.getItem('tabla-pat')||''}catch(e){return ''} }
  function guarda(t){ try{localStorage.setItem('tabla-pat',t)}catch(e){} }
  function borra(){ try{localStorage.removeItem('tabla-pat')}catch(e){} }
  function api(ruta,opts,tok){
    opts=opts||{};
    opts.headers={ 'Authorization':'Bearer '+tok, 'Accept':'application/vnd.github+json' };
    return fetch('https://api.github.com/repos/'+REPO+ruta,opts);
  }
  var desde=0;
  gu.onclick=function(){ var t=inp.value.trim(); if(!t)return; guarda(t); caja.hidden=true; inp.value=''; correr(); };
  btn.onclick=function(){ if(!lee()){ caja.hidden=false; inp.focus(); return; } correr(); };
  function correr(){
    btn.disabled=true; est.textContent='pidiendo la corrida…'; desde=Date.now()-120000;
    api('/actions/workflows/'+WF+'/dispatches',{method:'POST',body:JSON.stringify({ref:RAMA})},lee())
      .then(function(r){
        if(r.status===204){ est.textContent='corriendo: cuadros ITF + cuotas bet365 + veredictos (2–4 min)…'; setTimeout(mirar,20000); }
        else if(r.status===401||r.status===403){ borra(); est.textContent='el token no sirvió — pega uno nuevo'; caja.hidden=false; btn.disabled=false; }
        else { est.textContent='GitHub respondió '+r.status; btn.disabled=false; }
      })
      .catch(function(){ est.textContent='desde esta copia no se puede (bloquea la conexión a GitHub) — usa la página online: smartinoli.github.io/BETO'; btn.disabled=false; });
  }
  function mirar(){
    api('/actions/runs?branch='+encodeURIComponent(RAMA)+'&event=workflow_dispatch&per_page=1',{},lee())
      .then(function(r){return r.json()})
      .then(function(j){
        var run=(j.workflow_runs||[])[0];
        if(run && Date.parse(run.created_at)>=desde && run.status==='completed'){
          if(run.conclusion==='success'){ est.textContent='listo — recargando…'; setTimeout(function(){location.reload()},4000); }
          else { est.textContent='la corrida terminó "'+run.conclusion+'" — revisa la pestaña Actions en GitHub'; btn.disabled=false; }
        } else { est.textContent='corriendo… ('+((run&&run.status)||'en cola')+')'; setTimeout(mirar,15000); }
      })
      .catch(function(){ setTimeout(mirar,20000); });
  }
})();
</script>
</div>`;
fs.writeFileSync(path.join(DIR, 'itf-informe.html'), html);
console.log(`\n✓ vigia/itf-informe.html`);
if (sinTorneo.length) console.log(`  (${sinTorneo.length} cuotas sin torneo en el mapa)`);
