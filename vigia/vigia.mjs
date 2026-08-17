#!/usr/bin/env node
/* ============================================================
   VIGÍA — barrido Betano vs Cloudbet (OddsPapi v4), bajo demanda.

   Modo normal: el bot ESCUCHA tu chat de Telegram y no gasta ni un
   request de OddsPapi hasta que tú pides algo.

   Comandos del chat:
     /barrer   barrido COMPLETO sin límites (~110 requests) y te manda
               todo lo que pasa tus criterios, ordenado por ventaja
     /rapido   solo lo que empieza dentro de 6 h (~30 requests)
     /estado   señales vivas + cuota de API restante (gratis)
     /ayuda    esta lista

   Sin dependencias: Node 20+ (fetch nativo).
   ============================================================ */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const CFG = JSON.parse(fs.readFileSync(path.join(DIR, 'config.json'), 'utf8'));
const ESTADO_PATH = path.join(DIR, 'estado.json');
const KEY = process.env.ODDSPAPI_KEY;
const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TG_CHAT = process.env.TELEGRAM_CHAT_ID;
const MODO = process.env.MODO || 'escucha';            /* escucha | barrer | rapido */
const SEGUNDOS_ESCUCHA = +(process.env.SEGUNDOS_ESCUCHA || 780);
const DRY = !!process.env.DRY || !TG_TOKEN || !TG_CHAT;
if (!KEY) { console.error('Falta ODDSPAPI_KEY'); process.exit(1); }

let EST = { torneos: {}, fixtures: {}, cobertura: {}, mercados: {}, senales: {}, stats: {}, tgOffset: 0 };
try { EST = { ...EST, ...JSON.parse(fs.readFileSync(ESTADO_PATH, 'utf8')) } } catch {}
const guardarEstado = () => fs.writeFileSync(ESTADO_PATH, JSON.stringify(EST));

/* ---------- API OddsPapi: pacing, timeout y reintentos ---------- */
let REQ = 0, ULTIMO = 0;
const espera = ms => new Promise(r => setTimeout(r, ms));
async function api(ruta, params = {}, cooldown = 1100) {
  const u = new URL('https://api.oddspapi.io/v4/' + ruta);
  Object.entries({ ...params, apiKey: KEY }).forEach(([k, v]) => u.searchParams.set(k, v));
  for (let intento = 0; ; intento++) {
    const falta = ULTIMO + cooldown - Date.now();
    if (falta > 0) await espera(falta);
    ULTIMO = Date.now();
    let r = null, errRed = null;
    try {
      r = await fetch(u, { signal: AbortSignal.timeout(20000), headers: { 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) vigia/2.0' } });
    } catch (e) { errRed = e; }
    if ((errRed || r.status === 429 || r.status >= 500) && intento < 3) { await espera(1000 * 2 ** intento); continue; }
    if (errRed) throw new Error('red: ' + errRed.message);
    const cuerpo = await r.json().catch(() => null);
    if (cuerpo && cuerpo.error) { const e = new Error(cuerpo.error.code || cuerpo.error.message); e.api = cuerpo.error; throw e; }
    if (!r.ok) throw new Error('HTTP ' + r.status);
    REQ++;
    return cuerpo;
  }
}

/* ---------- Telegram ---------- */
const escHtml = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
async function telegram(html) {
  if (DRY) { console.log('\n[TELEGRAM]\n' + html.replace(/<[^>]+>/g, '') + '\n'); return true; }
  for (const trozo of partir(html)) {
    const r = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TG_CHAT, text: trozo, parse_mode: 'HTML', disable_web_page_preview: true }),
    });
    if (!r.ok) { console.error('Telegram falló:', await r.text().catch(() => r.status)); return false; }
    await espera(400);   /* límite de Telegram: ~1 mensaje/seg por chat */
  }
  return true;
}
/* Telegram corta en 4096 caracteres: se parte por líneas dobles */
function partir(html, max = 3500) {
  if (html.length <= max) return [html];
  const bloques = html.split('\n\n'), out = []; let acc = '';
  for (const b of bloques) {
    if ((acc + '\n\n' + b).length > max && acc) { out.push(acc); acc = b; }
    else acc = acc ? acc + '\n\n' + b : b;
  }
  if (acc) out.push(acc);
  return out;
}
async function tgUpdates() {
  if (DRY) return [];
  const u = `https://api.telegram.org/bot${TG_TOKEN}/getUpdates?timeout=25&offset=${EST.tgOffset || 0}`;
  try {
    const r = await fetch(u, { signal: AbortSignal.timeout(35000) });
    const d = await r.json();
    if (!d.ok) return [];
    const msgs = [];
    for (const up of d.result || []) {
      EST.tgOffset = up.update_id + 1;
      const m = up.message || up.edited_message;
      if (!m || String(m.chat?.id) !== String(TG_CHAT)) continue;   /* solo tu chat */
      if (m.text) msgs.push(m.text.trim());
    }
    if (d.result?.length) guardarEstado();
    return msgs;
  } catch { return []; }
}

/* ---------- helpers de dominio ---------- */
const hoyKey = new Intl.DateTimeFormat('sv-SE', { timeZone: 'America/Santiago' }).format(new Date());
const plata = n => '$' + Math.round(n).toLocaleString('es-CL');
const slug = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '')
  .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
/* El link lleva un hash propio (#vg=...) que Betano ignora pero el marcador
   "Llenar boleta" lee para ubicar y clickear la selección exacta. */
const linkDe = (f, sel) => {
  const base = f.bookmakerFixtureId
    ? `https://lat.betano.com/cuotas-de-partido/${slug(f.p1)}-${slug(f.p2)}/${f.bookmakerFixtureId}/`
    : 'https://lat.betano.com/';
  if (!sel) return base;
  const h = [sel.oid || '', sel.mid || '', sel.lado || '', sel.cuota || '', sel.fam || '']
    .map(encodeURIComponent).join('~');
  return base + '#vg=' + h;
};
const horaTxt = iso => {
  const t = new Date(iso);
  const dia = new Intl.DateTimeFormat('sv-SE', { timeZone: 'America/Santiago' }).format(t);
  const hh = new Intl.DateTimeFormat('es-CL', { timeZone: 'America/Santiago', hour: '2-digit', minute: '2-digit' }).format(t);
  if (dia === hoyKey) return 'HOY ' + hh;
  const man = new Intl.DateTimeFormat('sv-SE', { timeZone: 'America/Santiago' }).format(new Date(Date.now() + 864e5));
  if (dia === man) return 'MAÑANA ' + hh;
  return new Intl.DateTimeFormat('es-CL', { timeZone: 'America/Santiago', weekday: 'short', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }).format(t);
};
const SIMU = /srl|e-?soccer|esports|ebasketball|simulated|cyber/i;

/* Whitelist del censo (14-08-2026). {fam, lado:'ou'|'ah'|'ml'|'yn', eq?, castigada?}
   Las familias que solo cotiza una casa no se listan: sin juez no hay señal. */
function familiaDe(sid, nombre) {
  const n = (nombre || '').toLowerCase();
  if (/player|scorer|assist|shot|offside|throw/.test(n)) return null;
  let m;
  if (sid === '10') {
    if (/^asian handicap$/.test(n)) return { fam: 'AH tiempo completo', lado: 'ah' };
    if (/^asian handicap first half$/.test(n)) return { fam: 'AH 1er tiempo', lado: 'ah' };
    if (/^over under full time$/.test(n)) return { fam: 'Goles Más/Menos', lado: 'ou' };
    if (/^over under first half$/.test(n)) return { fam: 'Goles 1er tiempo', lado: 'ou' };
    if ((m = n.match(/^over under team ([12])(?: (first|second) half)?$/)))
      return { fam: 'Goles' + (m[2] ? (m[2] === 'first' ? ' 1T' : ' 2T') : ''), lado: 'ou', eq: +m[1] };
    if (/^draw no bet$/.test(n)) return { fam: 'Empate no válido', lado: 'ml' };
    if (/^draw no bet first half$/.test(n)) return { fam: 'Empate no válido 1T', lado: 'ml' };
    if (/^both teams to score$/.test(n)) return { fam: 'Ambos marcan', lado: 'yn' };
    if (/^both teams to score first half$/.test(n)) return { fam: 'Ambos marcan 1T', lado: 'yn' };
    if (/^corners - over under full time$/.test(n)) return { fam: 'Córners Más/Menos', lado: 'ou', castigada: true };
    if (/^corners - over under first half$/.test(n)) return { fam: 'Córners 1T', lado: 'ou', castigada: true };
    if (/^corners - handicap$/.test(n)) return { fam: 'Córners hándicap', lado: 'ah', castigada: true };
    if (/^bookings - handicap$/.test(n)) return { fam: 'Tarjetas hándicap', lado: 'ah', castigada: true };
    return null;
  }
  if (sid === '11') {
    if (/^over under \(incl\. overtime\)$/.test(n)) return { fam: 'Total del partido', lado: 'ou' };
    if ((m = n.match(/^over under (first|second) half$/)))
      return { fam: 'Total ' + (m[1] === 'first' ? '1ª' : '2ª') + ' mitad', lado: 'ou' };
    if ((m = n.match(/^over under (first|second|third|fourth) quarter$/)))
      return { fam: 'Total ' + { first: '1er', second: '2º', third: '3er', fourth: '4º' }[m[1]] + ' cuarto', lado: 'ou' };
    return null;
  }
  if (sid === '12') {
    if (/^game handicap$/.test(n)) return { fam: 'Hándicap de juegos', lado: 'ah' };
    if (/^winner$/.test(n)) return { fam: 'Ganador', lado: 'ml' };
    if (/^first set winner$/.test(n)) return { fam: 'Ganador 1er set', lado: 'ml' };
    if ((m = n.match(/^participant ([12]) to win a set$/))) return { fam: 'Gana un set', lado: 'yn', eq: +m[1] };
    return null;
  }
  if (sid === '13') {
    if (/^handicap \(incl\. extra innings\)$/.test(n)) return { fam: 'Run line', lado: 'ah' };
    if (/^over under \(incl\. extra innings\)$/.test(n)) return { fam: 'Total de carreras', lado: 'ou' };
    if (/^over under first to fifth inning$/.test(n)) return { fam: 'Total primeras 5', lado: 'ou' };
    if (/^over under first inning$/.test(n)) return { fam: 'Total 1ª entrada', lado: 'ou' };
    if (/^winner \(incl\. extra innings\)$/.test(n)) return { fam: 'Ganador', lado: 'ml' };
    if ((m = n.match(/^over under team ([12]) \(incl\. extra innings\)$/))) return { fam: 'Carreras', lado: 'ou', eq: +m[1] };
    if (/^will there be an extra inning$/.test(n)) return { fam: 'Entrada extra', lado: 'yn', castigada: true };
    return null;
  }
  return null;
}

function desvigar(pA, pB) {
  if (CFG.devig === 'pow') {
    const qa = 1 / pA, qb = 1 / pB;
    if (qa + qb > 1) {
      let lo = 1, hi = 3;
      for (let i = 0; i < 40; i++) { const k = (lo + hi) / 2; (qa ** k + qb ** k > 1) ? lo = k : hi = k; }
      const k = (lo + hi) / 2;
      return [1 / qa ** k, 1 / qb ** k];
    }
  }
  const S = 1 / pA + 1 / pB;
  return [S * pA, S * pB];
}
function montoDe(cuota, vent) {
  const f = Math.max(0, vent) / (cuota - 1) / CFG.kellyDivisor;
  const m = Math.min(CFG.banca * CFG.topePctBanca, CFG.banca * f);
  return Math.max(CFG.montoMinimo, Math.round(m / 1000) * 1000);
}

/* ---------- catálogo de mercados (cacheado en el estado) ---------- */
let CATALOGO = null;
async function metaDe(mid) {
  if (EST.mercados[mid]) return EST.mercados[mid];
  if (!CATALOGO) {
    CATALOGO = {};
    (await api('markets')).forEach(m => { CATALOGO[m.marketId] = m; });
  }
  const m = CATALOGO[mid] || CATALOGO[+mid];
  if (!m) return null;
  EST.mercados[mid] = {
    n: m.marketName, h: m.handicap ?? null, len: m.marketLength,
    outs: Array.isArray(m.outcomes) ? Object.fromEntries(m.outcomes.map(o => [String(o.outcomeId), o.outcomeName])) : {},
  };
  return EST.mercados[mid];
}

/* ---------- datos base ---------- */
async function torneosDe(sid) {
  const c = EST.torneos[sid];
  if (c && c.fecha === hoyKey) return c.lista;
  const ts = await api('tournaments', { sportId: sid });
  const lista = ts
    .filter(t => (t.upcomingFixtures || 0) + (t.futureFixtures || 0) > 0)
    .filter(t => !SIMU.test((t.tournamentName || '') + ' ' + (t.categoryName || '')))
    .map(t => ({ id: t.tournamentId, n: t.tournamentName, cat: t.categoryName }));
  EST.torneos[sid] = { fecha: hoyKey, lista };
  return lista;
}
async function fixturesDe(sid, frescoMin = 60) {
  const c = EST.fixtures[sid];
  if (c && Date.now() - c.ts < frescoMin * 60e3) return c.lista;
  const d = new Date();
  const f1 = new Date(d.getTime() - 864e5).toISOString().slice(0, 10);
  const f2 = new Date(d.getTime() + 3 * 864e5).toISOString().slice(0, 10);
  const arr = await api('fixtures', { sportId: sid, from: f1, to: f2 }, 2100);
  const lista = (Array.isArray(arr) ? arr : arr.data || [])
    .filter(f => f.hasOdds)
    .map(f => ({
      fixtureId: f.fixtureId, tournamentId: f.tournamentId, startTime: f.startTime,
      p1: f.participant1Name || '#' + f.participant1Id, p2: f.participant2Name || '#' + f.participant2Id,
      liga: f.tournamentName || '',
    }));
  EST.fixtures[sid] = { ts: Date.now(), lista };
  return lista;
}
async function oddsBatch(tids, casa) {
  try {
    const d = await api('odds-by-tournaments', { tournamentIds: tids.join(','), bookmaker: casa, oddsFormat: 'decimal' }, 1100);
    return Array.isArray(d) ? d : d.data || [];
  } catch (e) {
    if (e.api && /FIXTURE_NOT_FOUND/.test(e.api.code || '')) return [];
    throw e;
  }
}

/* ---------- señales de un partido ---------- */
function procesarSync(info, bet, cb, metas, salida) {
  const porFam = new Map();
  const cand = [];
  const E = salida.embudo;
  for (const mid of Object.keys(bet.markets || {})) {
    const meta = metas[mid];
    if (!meta || meta.len !== 2) continue;
    const fam = familiaDe(info.sid, meta.n);
    if (!fam) { E.fueraWhitelist++; continue; }
    if (CFG.sinCuartos && meta.h != null && Math.abs(meta.h * 2) % 1 !== 0) { E.cuartos++; continue; }
    let central = null;
    for (const o of Object.values(bet.markets[mid].outcomes || {})) {
      const p0 = (o.players || {})['0'];
      if (p0?.mainLine === true) { central = true; break; }
      if (p0?.mainLine === false) central = false;
    }
    cand.push({ mid, meta, fam, central });
  }
  /* qué líneas se miran: la central del feed ± vecinas */
  const porGrupo = new Map();
  for (const c of cand) {
    const k = c.meta.n + '|' + (c.fam.eq || '');
    if (!porGrupo.has(k)) porGrupo.set(k, []);
    porGrupo.get(k).push(c);
  }
  const elegidos = [];
  for (const grupo of porGrupo.values()) {
    if (!CFG.soloLineaCentral || grupo.length === 1 || grupo[0].meta.h == null) { elegidos.push(...grupo); continue; }
    grupo.sort((a, b) => a.meta.h - b.meta.h);
    const ic = grupo.findIndex(c => c.central === true);
    if (ic < 0) { elegidos.push(...grupo.filter(c => c.central !== false)); continue; }
    /* cuántas líneas a cada lado de la central: 0 = solo la central,
       1 = una vecina por lado, 99 = todas las que ofrezca el feed */
    const paso = CFG.vecinas != null ? CFG.vecinas : (CFG.lineasVecinas ? 1 : 0);
    const sel = grupo.slice(Math.max(0, ic - paso), Math.min(grupo.length, ic + paso + 1));
    const fuera = grupo.filter(g => !sel.includes(g));
    E.lineasLejanas += fuera.length;
    /* ¿cuántas de las descartadas SÍ tenían juez? Son las recuperables */
    const conJuez = fuera.filter(g => (cb.markets || {})[g.mid]);
    E.lejanasConJuez += conJuez.length;
    if (fuera.length && E.ej.lejanas.length < 7) {
      E.ej.lejanas.push(`${grupo[0].meta.n}: central ${grupo[ic].meta.h}, se miran `
        + `${sel.map(g => g.meta.h).join('/')} · fuera ${fuera.map(g => g.meta.h).join(', ')}`
        + (conJuez.length ? ` (${conJuez.map(g => g.meta.h).join(', ')} con juez)` : ' (ninguna con juez)'));
    }
    elegidos.push(...sel);
  }
  for (const { mid, meta, fam } of elegidos) {
    const oB = bet.markets[mid].outcomes || {}, oC = (cb.markets || {})[mid]?.outcomes || {};
    const oids = Object.keys(oB);
    if (oids.length !== 2) continue;
    const pB = {}, pC = {}, idB = {}; let ok = true, faltaJuez = false;
    for (const oid of oids) {
      const b0 = (oB[oid].players || {})['0'], c0 = ((oC[oid] || {}).players || {})['0'];
      if (!b0?.active || !(b0.price > 1)) { ok = false; break; }
      if (!c0?.active || !(c0.price > 1)) { ok = false; faltaJuez = true; break; }
      pB[oid] = b0.price; pC[oid] = c0.price;
      idB[oid] = b0.bookmakerOutcomeId || null;   /* id nativo de Betano */
    }
    if (!ok) {
      if (!faltaJuez) { E.inactivos++; continue; }
      E.sinJuez++;
      /* ¿es que Cloudbet no cotiza NADA de esa familia, o solo tiene otras
         líneas? Distinguirlo dice si estamos perdiendo señales de verdad. */
      const otras = [];
      for (const omid of Object.keys(cb.markets || {})) {
        const om = metas[omid];
        if (om && om.n === meta.n && om.h != null && om.h !== meta.h) otras.push(om.h);
      }
      if (otras.length) {
        E.juezOtraLinea++;
        if (E.ej.sinJuez.length < 7) E.ej.sinJuez.push(
          `${info.p1.slice(0, 16)} · ${meta.n} ${meta.h} → Cloudbet tiene ${otras.sort((a, b) => a - b).slice(0, 4).join(', ')}`);
      } else {
        E.juezNiFamilia++;
        if (E.ej.sinJuez.length < 7) E.ej.sinJuez.push(
          `${info.p1.slice(0, 16)} · ${meta.n} ${meta.h ?? ''} → Cloudbet no tiene esa familia`);
      }
      continue;
    }
    const bmid = bet.markets[mid].bookmakerMarketId || null;
    const [jA, jB] = desvigar(pC[oids[0]], pC[oids[1]]);
    const justos = { [oids[0]]: jA, [oids[1]]: jB };
    const umbral = Math.max(CFG.ventajaMinima[info.sid], fam.castigada ? (CFG.umbralCastigado ?? 0.05) : 0);
    const famLabel = fam.fam + (fam.eq ? ' · ' + (fam.eq === 1 ? info.p1 : info.p2) : '');
    for (const oid of oids) {
      const cuota = pB[oid] * (1 - CFG.margenLocal);
      salida.candidatas++;
      if (cuota > CFG.cuotaMaxima) { E.cuotaAlta++; continue; }
      const vent = cuota / justos[oid] - 1;
      if (vent < umbral) { if (vent > 0) E.ventajaBaja++; else E.sinVentaja++; continue; }
      const crudo = meta.outs[oid] || oid;
      let lado;
      if (fam.lado === 'ou') lado = (/over/i.test(crudo) ? 'Más de ' : 'Menos de ') + meta.h;
      else if (fam.lado === 'ah') {
        const hs = /^1$|home/i.test(crudo) ? meta.h : -meta.h;
        lado = (/^1$|home/i.test(crudo) ? info.p1 : info.p2) + ' ' + (hs > 0 ? '+' : '') + (hs === 0 ? '0.0' : hs);
      } else if (fam.lado === 'yn') lado = /yes/i.test(crudo) ? 'Sí' : 'No';
      else lado = /^1$|home/i.test(crudo) ? info.p1 : info.p2;
      const s = {
        sig: info.fixtureId + '|' + mid + '|' + oid, fix: info.fixtureId,
        partido: info.p1 + ' vs ' + info.p2, liga: info.liga, sid: info.sid,
        inicio: info.startTime, familia: famLabel, lado, cuota: +cuota.toFixed(3),
        justo: +justos[oid].toFixed(3), vent: +vent.toFixed(4),
        bOid: idB[oid], bMid: bmid,
        link: linkDe(info, { oid: idB[oid], mid: bmid, lado, cuota: pB[oid].toFixed(2), fam: fam.fam }),
        sospechosa: vent > CFG.umbralSospechosa,
      };
      const mejor = porFam.get(famLabel);
      if (mejor) {
        E.hermanas++;   /* otra línea de la misma familia con menos ventaja */
        if (E.ej.hermanas.length < 6) {
          const a = s.vent > mejor.vent ? s : mejor, b = s.vent > mejor.vent ? mejor : s;
          E.ej.hermanas.push(`${info.p1.slice(0, 14)} · ${famLabel}: gana "${a.lado}" `
            + `+${(a.vent * 100).toFixed(1)}% sobre "${b.lado}" +${(b.vent * 100).toFixed(1)}%`);
        }
      }
      if (!mejor || s.vent > mejor.vent) porFam.set(famLabel, s);
    }
  }
  for (const s of porFam.values()) salida.senales.push(s);
}

/* ---------- BARRIDO ---------- */
async function barrer({ completo = true, horasMax = null, sids = null } = {}) {
  const t0 = Date.now();
  const salida = {
    senales: [], candidatas: 0, ligas: 0, partidos: 0, porDeporte: {},
    embudo: { fueraWhitelist: 0, cuartos: 0, lineasLejanas: 0, sinJuez: 0, inactivos: 0,
              cuotaAlta: 0, ventajaBaja: 0, sinVentaja: 0, hermanas: 0, sinCloudbet: 0,
              /* ejemplos reales para el comando /porque */
              ej: { lejanas: [], sinJuez: [], cuotaAlta: [], hermanas: [] },
              /* de los mercados sin juez: ¿Cloudbet tiene la familia con otra línea? */
              juezOtraLinea: 0, juezNiFamilia: 0, lejanasConJuez: 0 },
  };
  const antic = CFG.anticipacionMin * 60e3;
  const horizonte = (horasMax ?? CFG.horizonteHoras) * 3600e3;

  const porLiga = new Map();
  for (const sid of (sids && sids.length ? sids : Object.keys(CFG.deportes))) {
    const tor = await torneosDe(sid);
    const fx = await fixturesDe(sid);
    const nombres = new Map(tor.map(t => [t.id, t.n + (t.cat ? ' (' + t.cat + ')' : '')]));
    for (const f of fx) {
      const t = new Date(f.startTime).getTime();
      if (t < Date.now() + antic || t > Date.now() + horizonte) continue;
      if (SIMU.test(f.liga + ' ' + f.p1 + ' ' + f.p2)) continue;
      if (!nombres.has(f.tournamentId)) continue;
      f.liga = f.liga || nombres.get(f.tournamentId);
      f.sid = sid;
      if (!porLiga.has(f.tournamentId)) porLiga.set(f.tournamentId, { sid, fixtures: [] });
      porLiga.get(f.tournamentId).fixtures.push(f);
      salida.partidos++;
    }
  }
  /* ligas sin cobertura de Betano: se reintentan una vez al día */
  const ligas = [...porLiga.entries()].filter(([tid]) => {
    const c = EST.cobertura[tid];
    return !(c && !c.ok && Date.now() - c.ts < 20 * 3600e3);
  });
  salida.ligas = ligas.length;

  const porSid = {};
  for (const [tid, L] of ligas) (porSid[L.sid] ||= []).push(tid);
  const colas = Object.entries(porSid).map(([sid, tids]) => {
    const lotes = [];
    for (let i = 0; i < tids.length; i += 5) lotes.push({ sid, tids: tids.slice(i, i + 5) });
    return lotes;
  });
  const lotes = [];
  while (colas.some(c => c.length)) for (const c of colas) if (c.length) lotes.push(c.shift());

  const fixIdx = new Map();
  for (const [, L] of porLiga) for (const f of L.fixtures) fixIdx.set(f.fixtureId, f);

  const tope = completo ? Infinity : CFG.maxRequestsPorCiclo;
  for (const lote of lotes) {
    if (REQ >= tope) { salida.tope = true; break; }
    const bet = await oddsBatch(lote.tids, 'betano');
    const cbt = bet.length ? await oddsBatch(lote.tids, 'cloudbet') : [];
    const cbIdx = new Map(cbt.map(f => [f.fixtureId, (f.bookmakerOdds || {}).cloudbet]));
    const conBet = new Set(bet.map(f => f.tournamentId));
    for (const tid of lote.tids) EST.cobertura[tid] = { ok: !!(conBet.has(tid) || (EST.cobertura[tid] || {}).ok), ts: Date.now() };
    const dep = CFG.deportes[lote.sid] || lote.sid;
    salida.porDeporte[dep] = (salida.porDeporte[dep] || 0) + lote.tids.length;
    /* metadatos de todos los mercados vistos en el lote (1 request la 1ª vez) */
    const metas = {};
    for (const f of bet) {
      const b = (f.bookmakerOdds || {}).betano;
      for (const mid of Object.keys(b?.markets || {})) if (!(mid in metas)) metas[mid] = await metaDe(mid);
    }
    /* también los de Cloudbet: sin esto no se puede saber si un mercado "sin
       juez" es que Cloudbet no lo cotiza o que lo cotiza en otra línea */
    for (const c of cbIdx.values()) {
      for (const mid of Object.keys(c?.markets || {})) if (!(mid in metas)) metas[mid] = await metaDe(mid);
    }
    for (const f of bet) {
      const info = fixIdx.get(f.fixtureId);
      const b = (f.bookmakerOdds || {}).betano, c = cbIdx.get(f.fixtureId);
      if (!info || !b) continue;
      if (!c) { salida.embudo.sinCloudbet++; continue; }   /* partido sin juez */
      info.bookmakerFixtureId = b.bookmakerFixtureId || null;
      procesarSync(info, b, c, metas, salida);
    }
  }
  salida.segundos = Math.round((Date.now() - t0) / 1000);
  salida.requests = REQ;
  /* memoria: útil para el próximo barrido (marca lo ya visto) */
  const antes = new Set(Object.keys(EST.senales));
  EST.senales = {};
  for (const s of salida.senales) EST.senales[s.sig] = { ...s, ts: Date.now(), conocida: antes.has(s.sig) };
  EST.stats = { ultimo: new Date().toISOString(), requests: REQ, ...salida.porDeporte };
  guardarEstado();
  return salida;
}

/* ---------- reporte ---------- */
const EMO = { 10: '⚽', 11: '🏀', 12: '🎾', 13: '⚾' };
function bloqueSenal(s, i) {
  return [
    `<b>${i}. ${EMO[s.sid] || ''} ${escHtml(s.partido)}</b>${s.sospechosa ? ' ⚠️' : ''}`,
    `${escHtml(s.liga)} · ${horaTxt(s.inicio)}`,
    `<b>${escHtml(s.lado)}</b> · ${escHtml(s.familia)}`,
    `${s.cuota.toFixed(2)} vs justo ${s.justo.toFixed(2)} → <b>+${(s.vent * 100).toFixed(1)}%</b> · ${plata(montoDe(s.cuota, s.vent))}`,
    `<a href="${escHtml(s.link)}">Abrir en Betano</a>`,
  ].join('\n');
}
async function reportar(r, titulo) {
  const orden = r.senales.slice().sort((a, b) => b.vent - a.vent);
  const E = r.embudo;
  /* el embudo dice qué quedó fuera y por qué: sin esto, "no hay señales"
     es indistinguible de "el filtro está demasiado apretado" */
  const descartes = [
    E.sinCloudbet && `${E.sinCloudbet} partidos sin Cloudbet (sin juez)`,
    E.sinJuez && `${E.sinJuez} mercados que Cloudbet no cotiza`,
    E.cuotaAlta && `${E.cuotaAlta} líneas con cuota > ${CFG.cuotaMaxima}`,
    E.ventajaBaja && `${E.ventajaBaja} con ventaja bajo tu mínimo`,
    E.sinVentaja && `${E.sinVentaja} sin ventaja (Betano paga bajo el justo)`,
    E.lineasLejanas && `${E.lineasLejanas} líneas lejos de la central`,
    E.cuartos && `${E.cuartos} de cuarto (0.25/0.75, no están en LAT)`,
    E.hermanas && `${E.hermanas} hermanas de la misma familia (queda la mejor)`,
  ].filter(Boolean);
  const cab = [
    `<b>${titulo}</b>`,
    `${r.ligas} ligas · ${r.partidos} partidos · ${r.candidatas.toLocaleString('es-CL')} líneas evaluadas`,
    `${r.requests} requests · ${r.segundos}s`,
    Object.entries(r.porDeporte).map(([d, n]) => `${d} ${n}`).join(' · '),
    r.tope ? '⚠️ tope de requests alcanzado' : '',
    '',
    orden.length ? `<b>${orden.length} señal(es):</b>` : '<b>Sin señales que pasen tus criterios.</b>',
    descartes.length ? `\n<i>Quedó fuera: ${descartes.join(' · ')}</i>` : '',
  ].filter(Boolean).join('\n');
  await telegram(cab);
  if (!orden.length) return;
  const trozos = [];
  orden.forEach((s, i) => trozos.push(bloqueSenal(s, i + 1)));
  await telegram(trozos.join('\n\n'));
}

/* ---------- comandos ---------- */
async function cmdEstado() {
  let cuota = 'no disponible';
  try {
    const d = await api('account');   /* gratis: no descuenta */
    const sub = (d.subscriptions || []).filter(x => x.is_active)[0];
    if (sub?.request_limit) {
      const libre = sub.request_limit - (sub.request_count || 0);
      cuota = `${libre.toLocaleString('es-CL')} de ${sub.request_limit.toLocaleString('es-CL')} libres`;
    }
  } catch {}
  const vivas = Object.values(EST.senales);
  const ult = EST.stats.ultimo ? horaTxt(EST.stats.ultimo) : 'nunca';
  await telegram([
    '<b>Estado del Vigía</b>',
    `Cuota API: ${cuota}`,
    `Último barrido: ${ult} (${EST.stats.requests || 0} requests)`,
    `Señales del último barrido: ${vivas.length}`,
    '',
    'Comandos: /barrer · /rapido · /estado · /ayuda',
  ].join('\n'));
}
/* Deportes por como los escribas: "/barrer futbol 6", "/rapido tenis nba"… */
const ALIAS = {
  '10': /f[uú]tbol|futbol|soccer|balomp/i,
  '11': /b[aá]squet|basquet|basket|nba|wnba|euroliga/i,
  '12': /tenis|tennis|atp|wta|itf/i,
  '13': /b[eé]isbol|beisbol|baseball|mlb|npb/i,
};
function deportesDe(texto) {
  const sids = Object.entries(ALIAS).filter(([, re]) => re.test(texto)).map(([sid]) => sid);
  return sids.length ? sids : null;   /* null = todos */
}
/* ¿Qué espejos de Betano existen, cuáles cubre tu plan, y a qué dominio
   apuntan de verdad? Lo mide en vez de suponerlo. */
async function cmdCasas() {
  const lista = await api('bookmakers');
  const betanos = (Array.isArray(lista) ? lista : []).filter(b =>
    /betano/i.test(b.slug || b.bookmakerSlug || '') || /betano/i.test(b.bookmakerName || ''));
  let mias = [];
  try {
    const d = await api('account');
    const sub = (d.subscriptions || []).filter(x => x.is_active)[0];
    mias = Object.keys(sub?.bookmakers || {});
  } catch {}
  const filas = betanos.map(b => {
    const slug = b.slug || b.bookmakerSlug;
    const tengo = mias.includes(slug);
    return `${tengo ? '✅' : '⬜'} <code>${escHtml(slug)}</code> — ${escHtml(b.bookmakerName || '')}`
      + (b.cloneOf ? ` <i>(clon de ${escHtml(b.cloneOf)})</i>` : '');
  });

  /* prueba real: ¿a qué dominio apuntan los links de las casas que sí tengo? */
  const dominios = [];
  for (const slug of mias.filter(s => /betano/i.test(s))) {
    let dom = 'sin datos';
    try {
      const tor = await torneosDe('10');
      for (const t of tor.slice(0, 6)) {
        const d = await oddsBatch([t.id], slug);
        const f = d.find(x => (x.bookmakerOdds || {})[slug]?.fixturePath);
        if (f) { dom = new URL(f.bookmakerOdds[slug].fixturePath).host; break; }
      }
    } catch (e) { dom = 'error: ' + e.message; }
    dominios.push(`<code>${escHtml(slug)}</code> → <b>${escHtml(dom)}</b>`);
  }

  await telegram([
    '<b>🏠 Espejos de Betano en OddsPapi</b>',
    '',
    ...filas,
    '',
    '<b>Tu plan cubre:</b> ' + (mias.length ? mias.map(escHtml).join(', ') : 'no pude leerlo'),
    '',
    '<b>Dominio real de los links:</b>',
    ...dominios,
    '',
    '<i>✅ = incluida en tu plan · ⬜ = existe pero no la tienes contratada.</i>',
  ].join('\n'));
}
async function ejecutar(texto) {
  const c = texto.toLowerCase().replace(/^\//, '').split(/[\s@]/)[0];
  /* horizonte opcional en el propio mensaje: "/barrer 48" = próximas 48 h.
     Sin número manda config.horizonteHoras. Tope de 72 h (el feed no da más). */
  const num = (texto.match(/\d+/) || [])[0];
  const horas = num ? Math.min(72, Math.max(1, +num)) : null;
  const sids = deportesDe(texto);
  const queDeportes = sids ? sids.map(s => CFG.deportes[s]).join(' + ') : 'todos los deportes';
  if (['barrer', 'barrido', 'todo', 'buscar'].includes(c)) {
    const h = horas ?? CFG.horizonteHoras;
    await telegram(`🔎 Barriendo <b>${queDeportes}</b> · próximas <b>${h} h</b>…`);
    const r = await barrer({ completo: true, horasMax: h, sids });
    await reportar(r, `📋 ${sids ? queDeportes : 'Barrido completo'} · ${h} h`);
    return true;
  }
  if (['rapido', 'rápido', 'ya', 'pronto'].includes(c)) {
    const h = horas ?? 6;
    await telegram(`⚡ Barriendo <b>${queDeportes}</b> · dentro de <b>${h} h</b>…`);
    const r = await barrer({ completo: true, horasMax: h, sids });
    await reportar(r, `📋 Rápido · ${sids ? queDeportes : 'todo'} · ${h} h`);
    return true;
  }
  if (['porque', 'porqué', 'detalle', 'embudo', 'diagnostico', 'diagnóstico'].includes(c)) {
    const h = horas ?? 6;
    await telegram(`🔬 Analizando qué queda fuera · <b>${queDeportes}</b> · ${h} h…`);
    const r = await barrer({ completo: true, horasMax: h, sids });
    const E = r.embudo;
    const bloques = [
      `<b>🔬 Qué quedó fuera</b>\n${r.ligas} ligas · ${r.partidos} partidos · `
        + `${r.candidatas.toLocaleString('es-CL')} líneas · ${r.senales.length} señales`,
    ];
    if (E.sinJuez) bloques.push(
      `<b>Sin juez de Cloudbet: ${E.sinJuez}</b>\n`
      + `· ${E.juezOtraLinea} son mercados que Cloudbet <b>sí</b> tiene, pero en otra línea\n`
      + `· ${E.juezNiFamilia} son familias que Cloudbet no cotiza\n`
      + (E.ej.sinJuez.length ? '\n<i>' + E.ej.sinJuez.map(escHtml).join('\n') + '</i>' : ''));
    if (E.lineasLejanas) bloques.push(
      `<b>Líneas lejos de la central: ${E.lineasLejanas}</b>\n`
      + `· <b>${E.lejanasConJuez} tienen juez en Cloudbet</b> → se recuperan subiendo "vecinas"\n`
      + `· ${E.lineasLejanas - E.lejanasConJuez} no tienen juez igual\n`
      + (E.ej.lejanas.length ? '\n<i>' + E.ej.lejanas.map(escHtml).join('\n') + '</i>' : ''));
    if (E.hermanas) bloques.push(
      `<b>Hermanas descartadas: ${E.hermanas}</b> (queda la de mayor ventaja)\n`
      + (E.ej.hermanas.length ? '<i>' + E.ej.hermanas.map(escHtml).join('\n') + '</i>' : ''));
    if (E.cuotaAlta || E.ventajaBaja || E.sinVentaja) bloques.push(
      `<b>Por tus criterios</b>\n· ${E.cuotaAlta} con cuota > ${CFG.cuotaMaxima}\n`
      + `· ${E.ventajaBaja} con ventaja positiva pero bajo tu mínimo\n`
      + `· ${E.sinVentaja} sin ventaja (Betano paga bajo el justo)`);
    if (E.sinCloudbet || E.cuartos) bloques.push(
      `<b>Otros</b>\n· ${E.sinCloudbet} partidos que Cloudbet no cubre\n`
      + `· ${E.cuartos} líneas de cuarto (0.25/0.75)`);
    await telegram(bloques.join('\n\n'));
    return true;
  }
  if (['casas', 'betanos', 'bookmakers', 'espejos'].includes(c)) { await cmdCasas(); return true; }
  if (['estado', 'status', 'cuota'].includes(c)) { await cmdEstado(); return true; }
  if (['ayuda', 'help', 'start', 'comandos'].includes(c)) {
    await telegram([
      '<b>Vigía · comandos</b>',
      '',
      `<b>/barrer</b> — todo lo disponible en las próximas ${CFG.horizonteHoras} h (~110 requests, ~2 min)`,
      '<b>/rapido</b> — solo lo que empieza dentro de 6 h (~30 requests)',
      '<b>/estado</b> — cuota de API y último barrido (gratis)',
      '<b>/porque</b> — qué quedó fuera y por qué, con ejemplos reales',
      '<b>/casas</b> — qué espejos de Betano existen y a qué dominio apuntan',
      '',
      'Se les puede agregar <b>deporte</b> y <b>horas</b>, en cualquier orden:',
      '· <code>/barrer futbol 6</code>',
      '· <code>/rapido tenis</code>',
      '· <code>/barrer nba 48</code>',
      '· <code>/barrer futbol tenis 12</code>',
      '',
      'Entiende: fútbol · básquet (nba, euroliga) · tenis (atp, wta) · béisbol (mlb).',
      'Sin deporte busca en los cuatro; sin número usa tu horizonte del config.',
      '',
      `<i>Criterios activos: cuota ≤ ${CFG.cuotaMaxima} · ventaja mín. fútbol ${(CFG.ventajaMinima['10'] * 100).toFixed(1)}% · básquet ${(CFG.ventajaMinima['11'] * 100).toFixed(1)}% · tenis ${(CFG.ventajaMinima['12'] * 100).toFixed(1)}% · béisbol ${(CFG.ventajaMinima['13'] * 100).toFixed(1)}% · desde ${CFG.anticipacionMin} min antes del inicio</i>`,
    ].join('\n'));
    return true;
  }
  return false;
}

/* ---------- main ---------- */
try {
  if (MODO === 'comando') {
    /* el puente (Cloudflare Worker) manda el texto tal cual lo escribiste */
    const texto = (process.env.COMANDO || 'barrer').trim();
    console.log('Comando:', texto);
    if (!await ejecutar(texto))
      await telegram('No conozco ese comando. Prueba <b>/barrer</b>, <b>/rapido</b>, '
        + '<b>/estado</b> o <b>/ayuda</b>.');
  } else if (MODO === 'barrer' || MODO === 'rapido') {
    const r = await barrer({ completo: true, horasMax: MODO === 'rapido' ? 6 : null });
    await reportar(r, MODO === 'rapido' ? '📋 Barrido rápido (6 h)' : '📋 Barrido completo');
  } else {
    /* ESCUCHA: no gasta requests de OddsPapi hasta que pidas algo */
    const hasta = Date.now() + SEGUNDOS_ESCUCHA * 1000;
    console.log(`Escuchando comandos hasta ${new Date(hasta).toISOString()}`);
    let atendidos = 0;
    while (Date.now() < hasta) {
      const msgs = await tgUpdates();
      for (const m of msgs) {
        console.log('Comando recibido:', m);
        try {
          if (await ejecutar(m)) atendidos++;
          else await telegram('No conozco ese comando. Prueba <b>/barrer</b>, <b>/rapido</b>, '
            + '<b>/estado</b> o <b>/ayuda</b>.');   /* siempre contesta: así sabes que estoy despierto */
        } catch (e) { await telegram('❌ Error: ' + escHtml(e.message)); }
      }
      if (!msgs.length) await espera(2000);
    }
    console.log(`Escucha terminada · ${atendidos} comando(s) atendidos · ${REQ} requests`);
  }
  guardarEstado();
} catch (err) {
  guardarEstado();
  console.error('Error:', err.message);
  try { await telegram('❌ El Vigía falló: ' + escHtml(err.message)); } catch {}
  process.exit(1);
}
