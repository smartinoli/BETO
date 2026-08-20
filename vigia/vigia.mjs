#!/usr/bin/env node
/* ============================================================
   VIGÍA — barrido Betano vs Cloudbet (OddsPapi v4), bajo demanda.

   Modo normal: el bot ESCUCHA tu chat de Telegram y no gasta ni un
   request de OddsPapi hasta que tú pides algo.

   MODO 100% FOCO (config: sombras=false, propsPrueba=false): solo se
   registra, liquida y muestra el foco (fútbol AH/DNB). Las sombras
   viejas quedan congeladas en registro.json — no se miden ni gastan
   requests; reencender "sombras" en config.json las reactiva.

   Comandos del chat:
     /barrer   barrido del foco sin límites (~110 requests) y te manda
               todo lo que pasa tus criterios, ordenado por ventaja
     /rapido   solo lo que empieza dentro de 6 h (~30 requests)
     /tablero  el balance del foco, liquidado solo con /settlements y
               /scores; "/tablero todo" = historial global
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
/* Qué espejo de Betano leer y quién hace de juez. El espejo importa: cada
   uno tiene su propio catálogo de mercados y líneas, y solo el que calza con
   tu vitrina sirve para apostar. Se cambia en config.json. */
const CASA = CFG.casa || 'betano';
const JUEZ = CFG.juez || 'cloudbet';
const KEY = process.env.ODDSPAPI_KEY;
const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TG_CHAT = process.env.TELEGRAM_CHAT_ID;
const MODO = process.env.MODO || 'escucha';            /* escucha | barrer | rapido */
const SEGUNDOS_ESCUCHA = +(process.env.SEGUNDOS_ESCUCHA || 780);
const DRY = !!process.env.DRY || !TG_TOKEN || !TG_CHAT;
if (!KEY) { console.error('Falta ODDSPAPI_KEY'); process.exit(1); }

let EST = { torneos: {}, fixtures: {}, cobertura: {}, mercados: {}, senales: {}, stats: {}, foto: {}, tgOffset: 0 };
try { EST = { ...EST, ...JSON.parse(fs.readFileSync(ESTADO_PATH, 'utf8')) } } catch {}
const guardarEstado = () => fs.writeFileSync(ESTADO_PATH, JSON.stringify(EST));

/* Tablero simulado: toda señal de un barrido queda anotada como apuesta
   ficticia (al monto Kelly sugerido) la PRIMERA vez que aparece. /tablero
   las liquida con /settlements y muestra qué familias ganan de verdad. */
const REGISTRO_PATH = path.join(DIR, 'registro.json');
let REG = {};
try { REG = JSON.parse(fs.readFileSync(REGISTRO_PATH, 'utf8')) } catch {}
const guardarRegistro = () => fs.writeFileSync(REGISTRO_PATH, JSON.stringify(REG));

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
  if (!iso || isNaN(t) || t.getFullYear() < 2020) return '¿hora?';
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
    /* grupo: familias que son LA MISMA apuesta con otro nombre comparten
       grupo y compiten entre sí — AH 0.0 ≡ Empate no válido (DNB). Queda
       solo la de mejor ventaja, nunca las dos. */
    if (/^asian handicap$/.test(n)) return { fam: 'AH tiempo completo', lado: 'ah', grupo: 'AH' };
    if (/^asian handicap first half$/.test(n)) return { fam: 'AH 1er tiempo', lado: 'ah', grupo: 'AH1T' };
    if (/^over under full time$/.test(n)) return { fam: 'Goles Más/Menos', lado: 'ou' };
    if (/^over under first half$/.test(n)) return { fam: 'Goles 1er tiempo', lado: 'ou' };
    if ((m = n.match(/^over under team ([12])(?: (first|second) half)?$/)))
      return { fam: 'Goles' + (m[2] ? (m[2] === 'first' ? ' 1T' : ' 2T') : ''), lado: 'ou', eq: +m[1] };
    if (/^draw no bet$/.test(n)) return { fam: 'Empate no válido', lado: 'ml', grupo: 'AH' };
    if (/^draw no bet first half$/.test(n)) return { fam: 'Empate no válido 1T', lado: 'ml', grupo: 'AH1T' };
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
    /* la 2ª mitad NO existe en lat.betano.com (solo en el feed RO): fuera */
    if (/^over under first half$/.test(n)) return { fam: 'Total 1ª mitad', lado: 'ou' };
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
    if (e.api && /RESTRICTED/.test(e.api.code || ''))
      throw new Error(`tu plan de OddsPapi no incluye "${casa}". Cámbiala en config.json `
        + `(campo "casa") o contrátala. Mándame /casas para ver cuáles tienes.`);
    throw e;
  }
}

/* ---------- señales de un partido ---------- */
function procesarSync(info, bet, cb, metas, salida) {
  const porFam = new Map();
  const porFamSombra = new Map();
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
    /* la llave de "una por familia" usa el grupo: AH y DNB compiten juntas */
    const famKey = (fam.grupo || fam.fam) + (fam.eq ? '·' + fam.eq : '');
    for (const oid of oids) {
      const cuota = pB[oid] * (1 - CFG.margenLocal);
      salida.candidatas++;
      const vent = cuota / justos[oid] - 1;
      /* RADAR DE DERIVA: foto del par vs el barrido anterior. Si el juez
         ACORTÓ su cuota (información fresca ya precificada por él) y Betano
         sigue igual, esa señal lleva la información antes que Betano. */
      let deriva = null;
      if (fam.grupo) {
        const kFoto = info.fixtureId + '|' + mid + '|' + oid;
        const prev = EST.foto[kFoto];
        if (prev && prev.c > 1 && prev.b > 1) {
          const dc = pC[oid] / prev.c - 1, db = pB[oid] / prev.b - 1;
          if (dc <= -0.025 && Math.abs(db) < 0.01)
            deriva = { dc: +(dc * 100).toFixed(1), min: Math.round((Date.now() - prev.ts) / 60e3) };
        }
        (salida.foto ||= {})[kFoto] = { b: pB[oid], c: pC[oid], ts: Date.now() };
      }
      const crudo = meta.outs[oid] || oid;
      let lado;
      if (fam.lado === 'ou') lado = (/over/i.test(crudo) ? 'Más de ' : 'Menos de ') + meta.h;
      else if (fam.lado === 'ah') {
        const hs = /^1$|home/i.test(crudo) ? meta.h : -meta.h;
        lado = (/^1$|home/i.test(crudo) ? info.p1 : info.p2) + ' ' + (hs > 0 ? '+' : '') + (hs === 0 ? '0.0' : hs);
      } else if (fam.lado === 'yn') lado = /yes/i.test(crudo) ? 'Sí' : 'No';
      else lado = /^1$|home/i.test(crudo) ? info.p1 : info.p2;
      if (cuota > CFG.cuotaMaxima || cuota < (CFG.cuotaMinima ?? 0) || vent < umbral) {
        if (cuota > CFG.cuotaMaxima) E.cuotaAlta++;
        else if (cuota < (CFG.cuotaMinima ?? 0)) E.cuotaBaja++;
        else if (vent > 0) E.ventajaBaja++;
        else E.sinVentaja++;
        /* SOMBRA: no pasa tus umbrales pero tiene ventaja positiva → va al
           tablero fantasma para calibrar. Nunca se avisa por Telegram. */
        if (CFG.sombras !== false && vent >= (CFG.sombraVentajaMinima ?? 0.005)
            && cuota <= (CFG.sombraCuotaMaxima ?? 3.5)) {
          const sm = {
            sig: info.fixtureId + '|' + mid + '|' + oid, fix: info.fixtureId,
            partido: info.p1 + ' vs ' + info.p2, liga: info.liga, sid: info.sid,
            inicio: info.startTime, familia: famLabel, lado,
            cuota: +cuota.toFixed(3), justo: +justos[oid].toFixed(3), vent: +vent.toFixed(4),
          };
          const prev = porFamSombra.get(famKey);
          if (!prev || sm.vent > prev.vent) porFamSombra.set(famKey, sm);
        }
        continue;
      }
      const s = {
        sig: info.fixtureId + '|' + mid + '|' + oid, fix: info.fixtureId,
        partido: info.p1 + ' vs ' + info.p2, liga: info.liga, sid: info.sid,
        inicio: info.startTime, familia: famLabel, lado, cuota: +cuota.toFixed(3),
        justo: +justos[oid].toFixed(3), vent: +vent.toFixed(4),
        bOid: idB[oid], bMid: bmid,
        link: linkDe(info, { oid: idB[oid], mid: bmid, lado, cuota: pB[oid].toFixed(2), fam: fam.fam }),
        deriva,
        sospechosa: vent > CFG.umbralSospechosa,
      };
      const mejor = porFam.get(famKey);
      if (mejor) {
        E.hermanas++;   /* otra línea de la misma familia con menos ventaja */
        if (E.ej.hermanas.length < 6) {
          const a = s.vent > mejor.vent ? s : mejor, b = s.vent > mejor.vent ? mejor : s;
          E.ej.hermanas.push(`${info.p1.slice(0, 14)} · ${famLabel}: gana "${a.lado}" `
            + `+${(a.vent * 100).toFixed(1)}% sobre "${b.lado}" +${(b.vent * 100).toFixed(1)}%`);
        }
      }
      if (!mejor || s.vent > mejor.vent) porFam.set(famKey, s);
    }
  }
  for (const s of porFam.values()) salida.senales.push(s);
  /* si la familia produjo señal real, su sombra sobra (el dato bueno ya está) */
  for (const [k, sm] of porFamSombra) if (!porFam.has(k)) salida.sombras.push(sm);
}

/* ---------- espejo de PRUEBA: props de jugador (SOLO sombras) ----------
   Viajan en los mismos requests del barrido (costo extra: cero). Nunca se
   avisan: van al tablero como sombras "Prop:" para medir si hay veta.
   · Básquet: "Over Under Player X" — dos lados por jugador, línea en h.
   · Béisbol: mercados de hitos — SOLO el par complementario 0 vs 1+ por
     jugador (≡ Más/Menos 0.5); 2+/3+… son acumulativos y no se pueden
     deviguear como par. Top 5 por ventaja por partido, para no inflar. */
function propsDe(sid, nombre) {
  const n = (nombre || '').toLowerCase();
  let m;
  if (sid === '11' && (m = n.match(/^over under player (points|rebounds|assists|3 point fg|points \+ rebounds|points \+ assists|points \+ assists \+ rebounds) \(incl\. overtime\)$/)))
    return { fam: 'Prop ' + m[1], tipo: 'ou' };
  if (sid === '13' && (m = n.match(/^(hits|total bases|runs batted in|singles|doubles|home runs|player stolen bases) \(incl\. extra innings\)$/)))
    return { fam: 'Prop ' + m[1], tipo: 'hitos' };
  return null;
}
function procesarProps(info, bet, cb, metas, salida) {
  if (CFG.propsPrueba === false) return;
  const cand = [];
  for (const mid of Object.keys(bet.markets || {})) {
    const meta = metas[mid];
    if (!meta) continue;
    const pd = propsDe(info.sid, meta.n);
    if (!pd) continue;
    const mkB = bet.markets[mid], mkC = (cb.markets || {})[mid];
    if (!mkC) continue;
    let par;
    if (pd.tipo === 'ou') {
      par = Object.keys(mkB.outcomes || {});
      if (par.length !== 2) continue;
    } else {
      const porNombre = Object.fromEntries(Object.entries(meta.outs || {}).map(([oid, nom]) => [nom, oid]));
      par = [porNombre['0'], porNombre['1+']];
      if (!par[0] || !par[1]) continue;
    }
    const jugadores = new Set([
      ...Object.keys(mkB.outcomes?.[par[0]]?.players || {}),
      ...Object.keys(mkB.outcomes?.[par[1]]?.players || {}),
    ]);
    jugadores.delete('0');
    for (const pid of jugadores) {
      const vivo = x => x && x.active && x.price > 1;
      const b1 = mkB.outcomes?.[par[0]]?.players?.[pid], b2 = mkB.outcomes?.[par[1]]?.players?.[pid];
      const c1 = mkC.outcomes?.[par[0]]?.players?.[pid], c2 = mkC.outcomes?.[par[1]]?.players?.[pid];
      if (!vivo(b1) || !vivo(b2) || !vivo(c1) || !vivo(c2)) continue;
      const [j1, j2] = desvigar(c1.price, c2.price);
      const justos = { [par[0]]: j1, [par[1]]: j2 };
      const nombreJ = b1.playerName || c1.playerName || ('#' + pid);
      for (const oid of par) {
        const cuota = mkB.outcomes[oid].players[pid].price;
        const vent = cuota / justos[oid] - 1;
        if (vent < (CFG.sombraVentajaMinima ?? 0.005) || cuota > (CFG.sombraCuotaMaxima ?? 3.5)) continue;
        const crudo = (meta.outs || {})[oid] || '';
        const lado = nombreJ + ' · ' + (pd.tipo === 'ou'
          ? (/over/i.test(crudo) ? 'Más de ' : 'Menos de ') + (meta.h ?? '')
          : (crudo === '0' ? '0 (ninguno)' : crudo));
        cand.push({
          sig: info.fixtureId + '|' + mid + '|' + oid + '|' + pid,
          fix: info.fixtureId, pid,
          partido: info.p1 + ' vs ' + info.p2, liga: info.liga, sid: info.sid,
          inicio: info.startTime, familia: pd.fam, lado,
          cuota: +cuota.toFixed(3), justo: +justos[oid].toFixed(3), vent: +vent.toFixed(4),
        });
      }
    }
  }
  cand.sort((a, b) => b.vent - a.vent);
  salida.sombras.push(...cand.slice(0, 5));
}

/* ---------- BARRIDO ---------- */
async function barrer({ completo = true, horasMax = null, sids = null } = {}) {
  const t0 = Date.now();
  const salida = {
    senales: [], sombras: [], candidatas: 0, ligas: 0, partidos: 0, porDeporte: {},
    embudo: { fueraWhitelist: 0, cuartos: 0, lineasLejanas: 0, sinJuez: 0, inactivos: 0,
              cuotaAlta: 0, cuotaBaja: 0, ventajaBaja: 0, sinVentaja: 0, hermanas: 0, sinCloudbet: 0,
              /* ejemplos reales para el comando /porque */
              ej: { lejanas: [], sinJuez: [], cuotaAlta: [], hermanas: [] },
              /* de los mercados sin juez: ¿Cloudbet tiene la familia con otra línea? */
              juezOtraLinea: 0, juezNiFamilia: 0, lejanasConJuez: 0 },
  };
  const antic = CFG.anticipacionMin * 60e3;
  const horizonte = (horasMax ?? CFG.horizonteHoras) * 3600e3;

  const porLiga = new Map();
  for (const sid of (sids && sids.length ? sids : (CFG.barridoDeportes || Object.keys(CFG.deportes)))) {
    /* un deporte sin acceso (ej: se soltó del plan al editar el panel) NO
       tumba el barrido: se salta y se avisa en el reporte */
    let tor, fx;
    try {
      tor = await torneosDe(sid);
      fx = await fixturesDe(sid);
    } catch (e) {
      (salida.deportesFuera ||= []).push(`${CFG.deportes[sid] || sid} (${e.message})`);
      continue;
    }
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
  let lotesMal = 0, lotesBien = 0, ultimoError = null;
  for (const lote of lotes) {
    if (REQ >= tope) { salida.tope = true; break; }
    /* un lote que falla NO tumba el barrido: se salta y se informa al final */
    let bet, cbt;
    try {
      bet = await oddsBatch(lote.tids, CASA);
      cbt = bet.length ? await oddsBatch(lote.tids, JUEZ) : [];
    } catch (e) {
      lotesMal++; ultimoError = e.message;
      console.error('Lote falló:', lote.tids.join(','), '·', e.message);
      if (lotesMal >= 8 && lotesBien === 0) break;   /* todos fallan: no insistir */
      continue;
    }
    lotesBien++;
    const cbIdx = new Map(cbt.map(f => [f.fixtureId, (f.bookmakerOdds || {})[JUEZ]]));
    const conBet = new Set(bet.map(f => f.tournamentId));
    for (const tid of lote.tids) EST.cobertura[tid] = { ok: !!(conBet.has(tid) || (EST.cobertura[tid] || {}).ok), ts: Date.now() };
    const dep = CFG.deportes[lote.sid] || lote.sid;
    salida.porDeporte[dep] = (salida.porDeporte[dep] || 0) + lote.tids.length;
    /* metadatos de todos los mercados vistos en el lote (1 request la 1ª vez) */
    const metas = {};
    for (const f of bet) {
      const b = (f.bookmakerOdds || {})[CASA];
      for (const mid of Object.keys(b?.markets || {})) if (!(mid in metas)) metas[mid] = await metaDe(mid);
    }
    /* también los de Cloudbet: sin esto no se puede saber si un mercado "sin
       juez" es que Cloudbet no lo cotiza o que lo cotiza en otra línea */
    for (const c of cbIdx.values()) {
      for (const mid of Object.keys(c?.markets || {})) if (!(mid in metas)) metas[mid] = await metaDe(mid);
    }
    for (const f of bet) {
      const info = fixIdx.get(f.fixtureId);
      const b = (f.bookmakerOdds || {})[CASA], c = cbIdx.get(f.fixtureId);
      if (!info || !b) continue;
      if (!c) { salida.embudo.sinCloudbet++; continue; }   /* partido sin juez */
      info.bookmakerFixtureId = b.bookmakerFixtureId || null;
      procesarSync(info, b, c, metas, salida);
      procesarProps(info, b, c, metas, salida);
    }
  }
  salida.segundos = Math.round((Date.now() - t0) / 1000);
  salida.requests = REQ;
  if (lotesMal) {
    salida.avisoLotes = lotesBien === 0
      ? `❌ TODAS las consultas de cuotas fallaron: OddsPapi responde "${ultimoError}" para `
        + `<b>${CASA}</b>. Parece problema del lado de ellos con esa casa — escríbeles a soporte, `
        + `o vuelve al espejo anterior poniendo "casa": "betano" en vigia/config.json.`
      : `⚠️ ${lotesMal} grupo(s) de ligas fallaron ("${ultimoError}") y se saltaron; `
        + `${lotesBien} funcionaron.`;
  }
  /* FOCO: solo lo que calza con el foco se avisa. Con sombras encendidas el
     resto baja a sombra (se registra y mide); con sombras apagadas (modo
     100% foco) se descarta sin gastar registro ni liquidación.
     El regex se prueba contra "familia · lado", así puede distinguir
     hasta la línea exacta (ej: AH 0.0 sí, AH -1 no). */
  if (CFG.foco && Object.keys(CFG.foco).length) {
    const visibles = [], ocultas = [];
    for (const s of salida.senales) {
      const re = CFG.foco[s.sid];
      const cadena = s.familia.split(' · ')[0] + ' · ' + s.lado;
      (re && new RegExp(re).test(cadena) ? visibles : ocultas).push(s);
    }
    salida.senales = visibles;
    if (CFG.sombras !== false) salida.sombras.push(...ocultas);
    salida.fueraDeFoco = ocultas.length;
  }
  /* foto de precios para el radar de deriva del próximo barrido */
  const corteFoto = Date.now() - 24 * 3600e3;
  for (const k of Object.keys(EST.foto)) if (EST.foto[k].ts < corteFoto) delete EST.foto[k];
  Object.assign(EST.foto, salida.foto || {});
  /* memoria: útil para el próximo barrido (marca lo ya visto) */
  const antes = new Set(Object.keys(EST.senales));
  EST.senales = {};
  for (const s of salida.senales) EST.senales[s.sig] = { ...s, ts: Date.now(), conocida: antes.has(s.sig) };
  EST.stats = { ultimo: new Date().toISOString(), requests: REQ, ...salida.porDeporte };
  guardarEstado();
  /* al tablero: se anota la PRIMERA aparición (cuota y monto de ese momento,
     como si la hubieras apostado ahí). Repeticiones en barridos posteriores
     no duplican ni pisan la anotación original. */
  salida.registradas = 0;
  salida.registradasSombra = 0;
  for (const s of salida.senales) {
    const ex = REG[s.sig];
    if (ex && !ex.sombra) continue;   /* una sombra que ahora es señal se asciende */
    const [fix, mid, oid] = s.sig.split('|');
    REG[s.sig] = {
      fix, mid, oid, visto: new Date().toISOString(),
      inicio: s.inicio, sid: s.sid, liga: s.liga, partido: s.partido,
      familia: s.familia, lado: s.lado, cuota: s.cuota, justo: s.justo,
      vent: s.vent, monto: montoDe(s.cuota, s.vent), estado: 'pendiente',
    };
    salida.registradas++;
  }
  for (const sm of salida.sombras) {
    if (REG[sm.sig]) continue;
    const [fix, mid, oid, pid] = sm.sig.split('|');
    REG[sm.sig] = {
      fix, mid, oid, ...(pid ? { pid } : {}), visto: new Date().toISOString(),
      inicio: sm.inicio, sid: sm.sid, liga: sm.liga, partido: sm.partido,
      familia: sm.familia, lado: sm.lado, cuota: sm.cuota, justo: sm.justo,
      vent: sm.vent, monto: montoDe(sm.cuota, sm.vent), estado: 'pendiente',
      sombra: true,
    };
    salida.registradasSombra++;
  }
  if (salida.registradas || salida.registradasSombra) guardarRegistro();
  return salida;
}

/* ---------- reporte ---------- */
const EMO = { 10: '⚽', 11: '🏀', 12: '🎾', 13: '⚾' };
function bloqueSenal(s, i) {
  return [
    `<b>${i}. ${EMO[s.sid] || ''} ${escHtml(s.partido)}</b>${s.deriva ? ' ⚡' : ''}${s.sospechosa ? ' ⚠️' : ''}`,
    `${escHtml(s.liga)} · ${horaTxt(s.inicio)}`,
    `<b>${escHtml(s.lado)}</b> · ${escHtml(s.familia)}`,
    `${s.cuota.toFixed(2)} vs justo ${s.justo.toFixed(2)} → <b>+${(s.vent * 100).toFixed(1)}%</b> · ${plata(montoDe(s.cuota, s.vent))}`,
    s.deriva ? `⚡ <b>El juez acortó ${Math.abs(s.deriva.dc)}% hace ${s.deriva.min} min y Betano no ha reaccionado</b> — información fresca` : '',
    `<a href="${escHtml(s.link)}">Abrir en Betano</a>`,
  ].filter(Boolean).join('\n');
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
    E.cuotaBaja && `${E.cuotaBaja} con cuota bajo ${CFG.cuotaMinima}` + (CFG.sombras !== false ? ' (a sombra)' : ''),
    E.ventajaBaja && `${E.ventajaBaja} con ventaja bajo tu mínimo`,
    E.sinVentaja && `${E.sinVentaja} sin ventaja (Betano paga bajo el justo)`,
    E.lineasLejanas && `${E.lineasLejanas} líneas lejos de la central`,
    E.cuartos && `${E.cuartos} de cuarto (0.25/0.75, no están en LAT)`,
    E.hermanas && `${E.hermanas} hermanas de la misma familia (queda la mejor)`,
  ].filter(Boolean);
  const cab = [
    `<b>${titulo}</b>`,
    `<i>espejo: ${escHtml(CASA)}</i>`,
    r.fueraDeFoco != null ? `<i>🎯 Foco: fútbol AH/DNB · cuota ${CFG.cuotaMinima ?? '—'}-${CFG.cuotaMaxima} · ${r.fueraDeFoco} señal(es) fuera del foco ${CFG.sombras !== false ? 'a la sombra' : 'descartada(s)'}</i>` : '',
    r.deportesFuera?.length ? `⚠️ Sin acceso en tu plan OddsPapi: ${r.deportesFuera.map(escHtml).join(' · ')} — se saltaron. Revisa el panel si no fue a propósito.` : '',
    r.avisoLotes || '',
    `${r.ligas} ligas · ${r.partidos} partidos · ${r.candidatas.toLocaleString('es-CL')} líneas evaluadas`,
    `${r.requests} requests · ${r.segundos}s`,
    Object.entries(r.porDeporte).map(([d, n]) => `${d} ${n}`).join(' · '),
    r.tope ? '⚠️ tope de requests alcanzado' : '',
    '',
    orden.length ? `<b>${orden.length} señal(es):</b>` : '<b>Sin señales que pasen tus criterios.</b>',
    orden.filter(s => s.deriva).length
      ? `⚡ <b>${orden.filter(s => s.deriva).length} con el juez recién movido</b> — la información aún no llega a Betano`
      : '',
    (r.registradas || r.registradasSombra)
      ? `<i>📒 Al tablero: ${r.registradas || 0} señal(es)`
        + (r.registradasSombra ? ` + ${r.registradasSombra} sombra(s) bajo tus umbrales, solo datos` : '') + '</i>'
      : '',
    descartes.length ? `\n<i>Quedó fuera: ${descartes.join(' · ')}</i>` : '',
  ].filter(Boolean).join('\n');
  await telegram(cab);
  if (!orden.length) return;
  const trozos = [];
  orden.forEach((s, i) => trozos.push(bloqueSenal(s, i + 1)));
  await telegram(trozos.join('\n\n'));
}

/* ---------- tablero simulado: liquidación y balance ---------- */
/* Resultados de /settlements → estados del registro. HALFWIN/HALFLOSS son
   los medio-ganada/medio-perdida de las líneas asiáticas enteras. */
const RESULTADO = { WIN: 'G', HALFWIN: 'MG', PUSH: 'E', CANCELLED: 'E', HALFLOSS: 'MP', LOSE: 'P' };
const CERRADO = ['G', 'MG', 'E', 'MP', 'P'];
function retornoDe(e) {
  switch (e.estado) {
    case 'G': return e.monto * e.cuota;
    case 'MG': return e.monto + e.monto * (e.cuota - 1) / 2;
    case 'E': return e.monto;
    case 'MP': return e.monto / 2;
    default: return 0;
  }
}
/* Busca el resultado de un outcome en la respuesta de /settlements,
   tolerando las dos formas del cuerpo (objeto o lista). */
function resultadoEn(d, mid, oid, pid = '0') {
  const cuerpo = Array.isArray(d) ? d[0] : (d && d.data ? (Array.isArray(d.data) ? d.data[0] : d.data) : d);
  const out = ((cuerpo || {}).markets || {})[mid]?.outcomes?.[oid];
  if (!out) return null;
  const raw = (out.players || {})[pid]?.result ?? (pid === '0' ? out.result : undefined) ?? (out.players || {})[pid]?.settlement;
  return raw ? RESULTADO[String(raw).toUpperCase()] || null : null;
}
/* ---- respaldo por marcador: /settlements no liquida varios mercados
   secundarios (córners, BTTS 1T, totales 2T) y demora en ITF. Para las
   familias cuyo resultado se deduce del marcador, /scores basta. ---- */
const periodosDe = d => {
  const c = Array.isArray(d) ? d[0] : (d && d.data ? (Array.isArray(d.data) ? d.data[0] : d.data) : d);
  return (c && c.scores && c.scores.periods) || null;
};
const COMPUTABLE = e => {
  const f = e.familia.split(' · ')[0];
  if (e.sid === '10') return /^(Goles|AH |AH$|Empate no válido|Ambos marcan)/.test(f);
  if (e.sid === '12') return /^Ganador( 1er set)?$/.test(f);
  if (e.sid === '13') return /^(Total de carreras|Total primeras 5|Run line|Ganador|Carreras)$/.test(f);
  if (e.sid === '11') return f === 'Total del partido';
  return false;
};
function liquidarPorMarcador(e, P) {
  const num = o => o && Number.isFinite(o.participant1Score) && Number.isFinite(o.participant2Score);
  const res = P.result, ft = num(P.fulltime) ? P.fulltime : P.result, p1 = P.p1;
  const [na, nb] = e.partido.split(' vs ');
  const lado1 = t => t === na ? 1 : t === nb ? 2 : 0;
  const famBase = e.familia.split(' · ')[0];
  const linea = parseFloat(String(e.lado).replace(/^(Más de|Menos de)\s*/, ''));
  const ou = (tot, h, over) => tot === h ? 'E' : (tot > h) === over ? 'G' : 'P';
  const ahDe = (s1, s2) => {
    const m = String(e.lado).match(/^(.*)\s([+-]?\d+(?:\.\d+)?)$/);
    if (!m) return null;
    const eq = lado1(m[1].trim());
    if (!eq) return null;
    const margen = (eq === 1 ? s1 - s2 : s2 - s1) + parseFloat(m[2]);
    return margen > 0 ? 'G' : margen < 0 ? 'P' : 'E';
  };
  if (e.sid === '10') {
    const mitad1 = /1T$|1er tiempo/.test(famBase), mitad2 = /2T$/.test(famBase);
    let sc = mitad1 ? p1
      : mitad2 ? (num(ft) && num(p1)
        ? { participant1Score: ft.participant1Score - p1.participant1Score,
            participant2Score: ft.participant2Score - p1.participant2Score } : null)
      : ft;
    if (!num(sc)) return null;
    const s1 = sc.participant1Score, s2 = sc.participant2Score;
    if (/^Goles/.test(famBase)) {
      if (!Number.isFinite(linea)) return null;
      const eqNombre = e.familia.includes(' · ') ? e.familia.split(' · ').slice(1).join(' · ') : null;
      const tot = !eqNombre ? s1 + s2 : lado1(eqNombre) === 1 ? s1 : lado1(eqNombre) === 2 ? s2 : null;
      if (tot == null) return null;
      return ou(tot, linea, e.lado.startsWith('Más'));
    }
    if (/^AH/.test(famBase)) return ahDe(s1, s2);
    if (/^Empate no válido/.test(famBase)) {
      const eq = lado1(e.lado.trim());
      if (!eq) return null;
      return s1 === s2 ? 'E' : (eq === 1) === (s1 > s2) ? 'G' : 'P';
    }
    if (/^Ambos marcan/.test(famBase)) return ((e.lado === 'Sí') === (s1 > 0 && s2 > 0)) ? 'G' : 'P';
    return null;
  }
  if (e.sid === '12') {
    const base = famBase === 'Ganador' ? res : famBase === 'Ganador 1er set' ? p1 : null;
    if (!num(base) || base.participant1Score === base.participant2Score) return null;
    const eq = lado1(e.lado.trim());
    if (!eq) return null;
    return (eq === 1) === (base.participant1Score > base.participant2Score) ? 'G' : 'P';
  }
  if (e.sid === '11' || e.sid === '13') {
    if (famBase === 'Total primeras 5') {
      const ps = ['p1', 'p2', 'p3', 'p4', 'p5'].map(k => P[k]);
      if (!ps.every(num) || !Number.isFinite(linea)) return null;
      const tot = ps.reduce((a, o) => a + o.participant1Score + o.participant2Score, 0);
      return ou(tot, linea, e.lado.startsWith('Más'));
    }
    if (!num(res)) return null;
    const s1 = res.participant1Score, s2 = res.participant2Score;
    if (famBase === 'Total del partido' || famBase === 'Total de carreras') {
      if (!Number.isFinite(linea)) return null;
      return ou(s1 + s2, linea, e.lado.startsWith('Más'));
    }
    if (famBase === 'Carreras') {
      const eqNombre = e.familia.split(' · ').slice(1).join(' · ');
      const eq = lado1(eqNombre);
      if (!eq || !Number.isFinite(linea)) return null;
      return ou(eq === 1 ? s1 : s2, linea, e.lado.startsWith('Más'));
    }
    if (famBase === 'Run line') return ahDe(s1, s2);
    if (famBase === 'Ganador') {
      if (s1 === s2) return null;
      const eq = lado1(e.lado.trim());
      if (!eq) return null;
      return (eq === 1) === (s1 > s2) ? 'G' : 'P';
    }
  }
  return null;
}

async function liquidar(maxFixtures = 60) {
  /* espera desde el inicio del partido antes de pedir resultado, por deporte:
     fútbol dura ~2 h, béisbol puede irse largo. Si la API aún no publica,
     no pasa nada: se reintenta en el próximo /tablero. */
  const ESPERA_H = { 10: 2, 11: 2.5, 12: 2.5, 13: 3.5 };
  /* con sombras apagadas no se gasta ni un request en liquidarlas: quedan
     congeladas como dato histórico (reversible: basta reencender sombras) */
  const listas = Object.values(REG).filter(e =>
    e.estado === 'pendiente' && !(CFG.sombras === false && e.sombra)
    && Date.now() - new Date(e.inicio).getTime() > (ESPERA_H[e.sid] || 3) * 3600e3);
  const porFix = new Map();
  for (const e of listas) {
    if (!porFix.has(e.fix)) porFix.set(e.fix, []);
    porFix.get(e.fix).push(e);
  }
  let consultados = 0, liquidadas = 0, quedaron = 0, porMarcador = 0;
  const vieja = e => Date.now() - new Date(e.inicio).getTime() > 7 * 864e5;
  for (const [fix, entradas] of porFix) {
    if (consultados >= maxFixtures) { quedaron += entradas.length; continue; }
    let d = null;
    consultados++;
    try { d = await api('settlements', { fixtureId: fix }, 2100); }
    catch { d = null; }   /* sin settlement todavía (o no disponible) */
    for (const e of entradas) {
      const est = d && resultadoEn(d, e.mid, e.oid, e.pid || '0');
      if (est) { e.estado = est; liquidadas++; }
    }
    /* lo que settlements no trajo se intenta por marcador (/scores) */
    const porScore = entradas.filter(e => e.estado === 'pendiente' && COMPUTABLE(e));
    if (porScore.length) {
      consultados++;
      let P = null;
      try { P = periodosDe(await api('scores', { fixtureId: fix }, 1100)); } catch {}
      if (P) for (const e of porScore) {
        const est = liquidarPorMarcador(e, P);
        if (est) { e.estado = est; e.marcador = true; liquidadas++; porMarcador++; }
      }
    }
    /* 7 días sin resultado por ninguna vía: se deja de pedir */
    for (const e of entradas) if (e.estado === 'pendiente' && vieja(e)) e.estado = 'X';
  }
  if (liquidadas || consultados) guardarRegistro();
  return { consultados, liquidadas, quedaron, porMarcador };
}
/* AH 0.0 ≡ Empate no válido (DNB): en el barrido ya compiten como una sola
   familia (mismo grupo); el tablero también los muestra juntos */
const famTablero = e => {
  const f = e.familia.split(' · ')[0];
  if (f === 'Empate no válido 1T') return 'AH 1er tiempo';
  if (f === 'Empate no válido') return 'AH tiempo completo';
  return f;
};
const netoDe = arr => arr.reduce((a, e) => a + retornoDe(e) - e.monto, 0);
const media = (arr, f) => arr.reduce((a, e) => a + f(e), 0) / arr.length;
const recTxt = arr => {
  const rec = { G: 0, P: 0, MG: 0, MP: 0, E: 0 };
  for (const e of arr) rec[e.estado]++;
  return ['G', 'P', 'MG', 'MP', 'E'].filter(k => rec[k]).map(k => rec[k] + k).join(' ');
};
const conSigno = n => (n >= 0 ? '🟢 +' : '🔴 −') + plata(Math.abs(n));
/* fila de un tipo de apuesta: n · cuota media · % sobre el justo · récord · neto */
const fila = (nombre, arr) => `· ${escHtml(nombre)} — ${arr.length} ap · cuota ${media(arr, e => e.cuota).toFixed(2)}`
  + ` · +${(media(arr, e => e.vent) * 100).toFixed(1)}% s/justo · ${recTxt(arr)} → <b>${conSigno(netoDe(arr))}</b>`;

/* ---- vista FOCO (el /tablero a secas): SOLO lo que estamos jugando hoy.
   Filtra por las familias del foco Y los criterios vigentes del config
   (cuota mín/máx, ventaja mínima): las señales anotadas con criterios
   viejos no ensucian la lectura — viven en /tablero todo. Sin bandas,
   sin sombras, sin punto ciego: el balance de lo definido y ya. ---- */
async function cmdTableroFoco(liq) {
  const todas = Object.values(REG);
  const reFoco = CFG.foco?.['10'] ? new RegExp(CFG.foco['10']) : /^AH/;
  const delFoco = e => e.sid === '10' && !e.sombra
    && reFoco.test(e.familia.split(' · ')[0] + ' · ' + e.lado);
  const okHoy = e => e.cuota >= (CFG.cuotaMinima ?? 0) && e.cuota <= CFG.cuotaMaxima
    && e.vent >= CFG.ventajaMinima['10'];
  const cerradas = todas.filter(e => CERRADO.includes(e.estado) && delFoco(e) && okHoy(e));
  const pend = todas.filter(e => e.estado === 'pendiente' && delFoco(e) && okHoy(e)).length;
  const viejas = todas.filter(e => CERRADO.includes(e.estado) && delFoco(e) && !okHoy(e)).length;
  const criterios = `cuota ${CFG.cuotaMinima ?? '—'}–${CFG.cuotaMaxima} · ventaja ≥ ${(CFG.ventajaMinima['10'] * 100).toFixed(1)}%`;
  const lineas = [
    '<b>📒 Tablero · 🎯 AH fútbol</b>',
    `<i>${criterios} · DNB cuenta como AH 0.0</i>`,
    '',
  ];
  if (!cerradas.length) {
    lineas.push(pend ? `Aún nada liquidado con tus criterios actuales. ${pend} pendiente(s).`
      : 'Aún no hay apuestas del foco: se anotan solas con cada /barrer o /rapido.');
  } else {
    const apostado = cerradas.reduce((a, e) => a + e.monto, 0);
    lineas.push(`<b>TOTAL</b> · ${cerradas.length} ap · ${plata(apostado)} apostados · ${recTxt(cerradas)}`
      + ` → <b>${conSigno(netoDe(cerradas))}</b> (ROI ${(netoDe(cerradas) / apostado * 100).toFixed(1)}%)`);
    const porFam = new Map();
    for (const e of cerradas) {
      const k = famTablero(e);
      if (!porFam.has(k)) porFam.set(k, []);
      porFam.get(k).push(e);
    }
    for (const [fam, sub] of [...porFam.entries()].sort((a, b) => netoDe(b[1]) - netoDe(a[1])))
      lineas.push(fila(fam, sub));
  }
  lineas.push('', `<i>${pend} pendiente(s)`
    + (liq.porMarcador ? ` · ${liq.porMarcador} por marcador` : '')
    + (liq.consultados ? ` · ${liq.consultados} requests` : '')
    + (viejas ? ` · ${viejas} liquidada(s) viejas fuera de tus criterios actuales` : '')
    + ' · <code>/tablero todo</code> = historial completo</i>');
  await telegram(lineas.join('\n'));
}

async function cmdTablero(sids, { foco = false } = {}) {
  const pendAntes = Object.values(REG).filter(e =>
    e.estado === 'pendiente' && !(CFG.sombras === false && e.sombra)).length;
  if (pendAntes) await telegram(`📒 Liquidando pendientes (${pendAntes})…`);
  const liq = await liquidar();
  if (foco) return cmdTableroFoco(liq);
  const todas = Object.values(REG);
  /* con deporte ("/tablero futbol") se filtra la vista y se agrega el
     desglose por % de ventaja prometida: el dato para ajustar ventajaMinima */
  const filtro = sids && sids.length ? new Set(sids) : null;
  /* sombras congeladas (modo foco): fuera de los conteos de pendientes */
  const activa = e => !(CFG.sombras === false && e.sombra);
  const enAmbito = e => (!filtro || filtro.has(e.sid)) && activa(e);
  const cerradasTodas = todas.filter(e => CERRADO.includes(e.estado));
  const enVista = filtro ? cerradasTodas.filter(e => filtro.has(e.sid)) : cerradasTodas;
  /* las sombras (bajo umbral, nunca avisadas) no entran al balance principal:
     son datos de calibración, no apuestas que habrías hecho */
  const cerradas = enVista.filter(e => !e.sombra);
  const sombras = enVista.filter(e => e.sombra);
  const pend = todas.filter(e => e.estado === 'pendiente' && enAmbito(e)).length;
  const sinDatos = todas.filter(e => e.estado === 'X' && enAmbito(e)).length;
  const titulo = '<b>📒 Tablero' + (filtro
    ? ' · ' + [...filtro].map(s => CFG.deportes[s] || s).join(' + ') : ' · todo el historial') + '</b>';
  if (!cerradas.length && !sombras.length) {
    await telegram([
      titulo,
      filtro && cerradasTodas.length
        ? 'Aún no hay apuestas liquidadas en esta vista. <code>/tablero todo</code> muestra el historial global.'
        : todas.length
          ? `Aún nada liquidado. ${pend} apuesta(s) esperando resultado`
            + (sinDatos ? ` · ${sinDatos} sin datos de la API` : '') + '.'
          : 'Todavía no hay apuestas anotadas: se anotan solas con cada /barrer o /rapido.',
      liq.consultados ? `<i>${liq.consultados} consultas de resultados usadas.</i>` : '',
    ].filter(Boolean).join('\n'));
    return;
  }
  const apostado = cerradas.reduce((a, e) => a + e.monto, 0);
  const agrupa = (arr, clave) => {
    const m = new Map();
    for (const e of arr) {
      const k = clave(e);
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(e);
    }
    return [...m.entries()].sort((a, b) => netoDe(b[1]) - netoDe(a[1]));
  };
  /* ordenado por deporte, y dentro por tipo de apuesta (la familia se agrega
     sin el sufijo del equipo: "Goles · Arsenal" → "Goles") */
  const secciones = [];
  for (const [sid, arr] of agrupa(cerradas, e => e.sid)) {
    secciones.push(`${EMO[sid] || ''} <b>${escHtml(CFG.deportes[sid] || sid)}</b> — ${arr.length} ap → <b>${conSigno(netoDe(arr))}</b>`);
    for (const [famBase, sub] of agrupa(arr, famTablero)) secciones.push(fila(famBase, sub));
    secciones.push('');
  }
  /* bandas en orden natural (no por neto): así se lee dónde empieza a sangrar */
  const porBanda = (base, clave, orden) => orden
    .map(k => [k, base.filter(e => clave(e) === k)])
    .filter(([, arr]) => arr.length)
    .map(([k, arr]) => fila(k, arr));
  /* por rango de cuota: mide si la banda alta (sobre la vieja cuotaMaxima
     2.1) aporta o sangra — el control de haberla subido */
  const bandas = porBanda(cerradas,
    e => e.cuota < 1.6 ? '< 1.60' : e.cuota <= 1.8 ? '1.60 – 1.80' : e.cuota <= 2.1 ? '1.81 – 2.10' : '2.11 +',
    ['< 1.60', '1.60 – 1.80', '1.81 – 2.10', '2.11 +']);
  /* por ventaja prometida (solo vista por deporte o foco), con las sombras
     si las hay: ahí se ve si el ventajaMinima está corto o largo */
  const bandasVent = filtro
    ? porBanda(cerradas.concat(sombras),
      e => e.vent <= 0.02 ? '≤ 2%' : e.vent <= 0.03 ? '2.1 – 3%' : e.vent <= 0.05 ? '3.1 – 5%' : '5.1% +',
      ['≤ 2%', '2.1 – 3%', '3.1 – 5%', '5.1% +'])
    : null;
  const lineas = [
    titulo,
    '<i>Como si hubieras apostado cada señal al monto sugerido, con la cuota del momento en que apareció.</i>',
    '',
  ];
  if (cerradas.length) {
    const roiTotal = (netoDe(cerradas) / apostado * 100).toFixed(1);
    lineas.push(
      `<b>TOTAL</b> · ${cerradas.length} ap · ${plata(apostado)} apostados · ${recTxt(cerradas)} → <b>${conSigno(netoDe(cerradas))}</b> (ROI ${roiTotal}%)`,
      '', ...secciones, '<b>Por cuota:</b>', ...bandas);
  } else {
    lineas.push('Aún ninguna señal real liquidada (solo sombras).');
  }
  if (sombras.length) lineas.push('',
    `👻 <b>Sombras</b> (bajo tus umbrales o cuota alta, nunca avisadas): ${sombras.length} ap `
    + `· cuota ${media(sombras, e => e.cuota).toFixed(2)} · +${(media(sombras, e => e.vent) * 100).toFixed(1)}% s/justo `
    + `→ <b>${conSigno(netoDe(sombras))}</b>`);
  if (bandasVent) lineas.push('', '<b>Por ventaja prometida (señales + sombras):</b>', ...bandasVent);
  /* EL PUNTO CIEGO: lo que no se logra liquidar no es azar — son los
     mercados raros (córners, ITF, divisiones menores), justo donde menos
     confiable es el juez. Se muestra siempre para que nunca sea invisible:
     una familia que vive aquí es candidata a salir del sistema. */
  const ciegas = todas.filter(enAmbito)
    .filter(e => e.estado === 'X' || (e.estado === 'pendiente' && Date.now() - new Date(e.inicio).getTime() > 24 * 3600e3));
  if (ciegas.length) {
    const porQue = {};
    for (const e of ciegas) {
      const k = e.familia.split(' · ')[0] + (e.sid !== '10' ? ` (${(CFG.deportes[e.sid] || '').toLowerCase().slice(0, 3)})` : '');
      porQue[k] = (porQue[k] || 0) + 1;
    }
    lineas.push('',
      `🕳 <b>Punto ciego</b> — sin resultado por ninguna vía: ${ciegas.length} ap · `
      + plata(ciegas.reduce((a, e) => a + e.monto, 0)) + ' que el tablero NO está midiendo\n<i>'
      + Object.entries(porQue).sort((a, b) => b[1] - a[1]).slice(0, 8)
        .map(([k, n]) => `${escHtml(k)} ${n}`).join(' · ') + '</i>');
  }
  /* recordatorio en la vista global de lo que quedó fuera del sistema */
  const congeladas = CFG.sombras === false
    ? todas.filter(e => e.sombra && e.estado === 'pendiente').length : 0;
  lineas.push('',
    `<i>${pend} pendiente(s)` + (liq.quedaron ? ` (${liq.quedaron} quedaron para el próximo /tablero)` : '')
      + (liq.porMarcador ? ` · ${liq.porMarcador} liquidadas por marcador` : '')
      + (sinDatos ? ` · ${sinDatos} sin datos` : '')
      + (congeladas ? ` · ${congeladas} sombras congeladas (modo foco: ya no se miden)` : '')
      + (liq.consultados ? ` · ${liq.consultados} requests en liquidar` : '') + '</i>');
  await telegram(lineas.join('\n'));
}

/* ---------- censo de props: ¿qué líneas de jugador trae tu feed? ----------
   Los props viajan DENTRO del request de odds normal: en cada outcome, el
   objeto players trae la clave '0' (el mercado a secas) y una clave por
   jugador. Este comando muestrea partidos próximos y cuenta qué mercados de
   jugador llegan por casa — dice si están contratados y si tienen juez. */
/* dónde vale la pena muestrear props: las casas solo los cotizan en ligas
   grandes, y el próximo partido puede ser de una liga menor sin ninguno */
const LIGA_GRANDE = { 10: /premier|laliga|bundesliga|serie a|ligue 1|champions/i,
  11: /wnba|\bnba\b|euroleague|euroliga/i, 12: /atp|wta/i, 13: /\bmlb\b|npb|kbo/i };
async function cmdProps(sids) {
  const objetivo = (sids && sids.length ? sids : ['11', '13']).filter(s => CFG.deportes[s]);
  const req0 = REQ;
  for (const sid of objetivo) {
    const todos = (await fixturesDe(sid))
      .filter(f => { const t = new Date(f.startTime).getTime(); return t > Date.now() && t < Date.now() + 48 * 3600e3; })
      .filter(f => !SIMU.test(f.liga + ' ' + f.p1 + ' ' + f.p2))
      .sort((a, b) => new Date(a.startTime) - new Date(b.startTime));
    const grandes = todos.filter(f => (LIGA_GRANDE[sid] || /$^/).test(f.liga));
    const fx = [...grandes, ...todos.filter(f => !grandes.includes(f))].slice(0, 3);
    if (!fx.length) {
      await telegram(`🎯 ${CFG.deportes[sid]}: sin partidos en las próximas 48 h para muestrear.`);
      continue;
    }
    const acc = new Map();   /* marketName → {b: Set(jugadores casa), c: Set(jugadores juez)} */
    const muestras = [];
    for (const f of fx) {
      let d;
      try { d = await api('odds', { fixtureId: f.fixtureId, oddsFormat: 'decimal' }, 600); }
      catch (e) { console.error('props: odds falló', f.fixtureId, e.message); continue; }
      const fxd = Array.isArray(d) ? d[0] : (d && d.data ? (Array.isArray(d.data) ? d.data[0] : d.data) : d);
      const bo = (fxd || {}).bookmakerOdds || {};
      muestras.push(`${f.p1} vs ${f.p2}`);
      for (const [casa, tag] of [[CASA, 'b'], [JUEZ, 'c']]) {
        const mk = (bo[casa] || {}).markets || {};
        for (const mid of Object.keys(mk)) {
          const meta = await metaDe(mid);
          if (!meta) continue;
          for (const o of Object.values(mk[mid].outcomes || {})) {
            const pls = Object.keys(o.players || {}).filter(p => p !== '0');
            if (!pls.length) continue;
            if (!acc.has(meta.n)) acc.set(meta.n, { b: new Set(), c: new Set() });
            pls.forEach(p => acc.get(meta.n)[tag].add(p));
          }
        }
      }
    }
    const filas = [...acc.entries()]
      .sort((a, b) => b[1].b.size - a[1].b.size)
      .slice(0, 20)
      .map(([n, v]) => `· ${escHtml(n)} — <b>${v.b.size}</b> jug. en ${escHtml(CASA)}`
        + (v.c.size ? ` · <b>${v.c.size}</b> con juez` : ' · <b>sin juez</b>'));
    const conJuez = [...acc.values()].filter(v => v.b.size && v.c.size).length;
    const diagnostico = !acc.size
      ? `Tu feed no trae NINGÚN mercado de jugador en estos partidos. Lo más probable: `
        + `"Props de jugadores" no está contratado (×1.5) para <b>${escHtml(CASA)}</b> en el panel de OddsPapi.`
      : ![...acc.values()].some(v => v.c.size)
        ? `${escHtml(CASA)} SÍ trae props, pero <b>${escHtml(JUEZ)}</b> no cotiza ninguno en tu feed: `
          + `sin juez no se puede calcular el justo. Habría que contratar props para ${escHtml(JUEZ)} también (×1.5).`
        : `<b>${conJuez} mercado(s) de jugador tienen las DOS casas</b> → ahí sí se podría comparar y buscar ventaja.`;
    await telegram([
      `<b>🎯 Líneas de jugador · ${CFG.deportes[sid]}</b>`,
      `<i>Muestra: ${muestras.map(escHtml).join(' · ') || 'ninguna'}</i>`,
      '',
      ...(filas.length ? filas : []),
      filas.length ? '' : null,
      diagnostico,
    ].filter(x => x !== null).join('\n'));
  }
  await telegram(`<i>${REQ - req0} requests usados en el censo.</i>`);
}

/* Diagnóstico: imprime en el log de Actions la respuesta CRUDA de
   /settlements y /scores para las pendientes más viejas (o un fixture dado).
   Sirve para ver por qué algo no liquida y qué forma tienen los marcadores. */
async function cmdDepurar(texto) {
  /* "/depurar deportes": catálogo completo de deportes de OddsPapi en el log */
  if (/deportes|sports/i.test(texto)) {
    const d = await api('sports');
    const arr = Array.isArray(d) ? d : [];
    console.log('=== CATÁLOGO deportes (' + arr.length + ') ===');
    for (const s of arr) console.log(JSON.stringify(s));
    await telegram(`🔬 Catálogo: ${arr.length} deportes — detalle en el log de Actions.`);
    return;
  }
  /* "/depurar plan": estado de la suscripción y qué deporte/casa quedó
     restringido — para cuando un cambio en el panel rompe el acceso. */
  if (/plan|cuenta|account/i.test(texto)) {
    const filas = [];
    try {
      const d = await api('account');
      console.log('=== account:', JSON.stringify(d).slice(0, 3000));
      const sub = (d.subscriptions || []).filter(x => x.is_active)[0];
      filas.push(sub
        ? `Suscripción activa · ${((sub.request_limit || 0) - (sub.request_count || 0)).toLocaleString('es-CL')} requests libres · casas: ${Object.keys(sub.bookmakers || {}).join(', ')}`
        : '⚠ SIN suscripción activa según /account');
    } catch (e) { filas.push('❌ /account: ' + e.message); }
    for (const sid of ['10', '11', '12', '13', '25']) {
      try {
        const t = await api('tournaments', { sportId: sid });
        filas.push(`✅ ${CFG.deportes[sid] || 'Tenis de mesa'} (${sid}): ${(t || []).length} torneos`);
      } catch (e) {
        filas.push(`❌ ${CFG.deportes[sid] || 'Tenis de mesa'} (${sid}): ${e.message}`);
      }
    }
    await telegram('<b>🔬 Diagnóstico del plan</b>\n' + filas.map(escHtml).join('\n'));
    return;
  }
  /* "/depurar mesa": sonda de tenis de mesa (sportId 25) recién agregado al
     plan — torneos, volumen de fixtures, qué cotiza cada casa, y si /scores
     acepta consulta masiva (define el costo de la cosecha de resultados). */
  if (/mesa|table/i.test(texto)) {
    const ts = await api('tournaments', { sportId: 25 });
    const tor = Array.isArray(ts) ? ts : [];
    console.log('=== TT torneos:', tor.length);
    tor.slice(0, 15).forEach(t => console.log(` ${t.tournamentId} | ${t.tournamentName} | ${t.categoryName || ''} | próximos:${t.upcomingFixtures}`));
    const d = new Date();
    const f1 = new Date(d.getTime() - 864e5).toISOString().slice(0, 10);
    const f2 = new Date(d.getTime() + 864e5).toISOString().slice(0, 10);
    const fx = await api('fixtures', { sportId: 25, from: f1, to: f2 }, 2100);
    const arr = (Array.isArray(fx) ? fx : fx.data || []);
    console.log('=== TT fixtures (ayer→mañana):', arr.length, '· con odds:', arr.filter(f => f.hasOdds).length);
    arr.slice(0, 5).forEach(f => console.log(` ${f.fixtureId} | ${f.startTime} | ${f.participant1Name} vs ${f.participant2Name} | ${f.tournamentName} | odds:${f.hasOdds}`));
    const tid = tor.sort((a, b) => (b.upcomingFixtures || 0) - (a.upcomingFixtures || 0))[0]?.tournamentId;
    if (tid) {
      for (const casa of [CASA, JUEZ]) {
        try {
          const o = await oddsBatch([tid], casa);
          const conM = o.filter(f => Object.keys(((f.bookmakerOdds || {})[casa] || {}).markets || {}).length);
          const mids = conM.length ? Object.keys(conM[0].bookmakerOdds[casa].markets) : [];
          console.log(`=== TT odds ${casa}: ${o.length} fixtures, ${conM.length} con mercados · mids ej: ${mids.slice(0, 6).join(',')}`);
          for (const mid of mids.slice(0, 6)) { const m = await metaDe(mid); console.log(`   mid ${mid} = "${m?.n}" h=${m?.h}`); }
        } catch (e) { console.log(`=== TT odds ${casa}: ERROR ${e.message}`); }
      }
      const viejo = arr.filter(f => new Date(f.startTime) < new Date(Date.now() - 3 * 3600e3))[0];
      for (const params of [{ sportId: 25, date: f1 }, { tournamentId: tid }, viejo ? { fixtureId: viejo.fixtureId } : null].filter(Boolean)) {
        try {
          const s = await api('scores', params, 2100);
          console.log('=== scores', JSON.stringify(params), '→', JSON.stringify(s).slice(0, 500));
        } catch (e) { console.log('=== scores', JSON.stringify(params), '→ ERROR', e.message); }
      }
    }
    await telegram(`🏓 Sonda tenis de mesa: ${tor.length} torneos · ${arr.length} fixtures en 3 días. Detalle en el log de Actions.`);
    return;
  }
  /* "/depurar props": imprime en el log UN mercado de jugador CRUDO por
     deporte (WNBA y MLB), de ambas casas, para conocer la estructura real
     (¿dónde vive la línea de cada jugador?) antes de construir encima. */
  if (/props/i.test(texto)) {
    for (const sid of ['11', '13']) {
      const todos = (await fixturesDe(sid))
        .filter(f => { const t = new Date(f.startTime).getTime(); return t > Date.now() && t < Date.now() + 48 * 3600e3; })
        .sort((a, b) => new Date(a.startTime) - new Date(b.startTime));
      const grandes = todos.filter(f => (LIGA_GRANDE[sid] || /$^/).test(f.liga));
      const f = (grandes[0] || todos[0]);
      if (!f) { console.log(`sid ${sid}: sin partidos`); continue; }
      let d;
      try { d = await api('odds', { fixtureId: f.fixtureId, oddsFormat: 'decimal' }, 600); }
      catch (e) { console.log(`sid ${sid}: odds falló ${e.message}`); continue; }
      const fxd = Array.isArray(d) ? d[0] : (d && d.data ? (Array.isArray(d.data) ? d.data[0] : d.data) : d);
      const bo = (fxd || {}).bookmakerOdds || {};
      console.log(`\n===== PROPS ${CFG.deportes[sid]} · ${f.p1} vs ${f.p2} (${f.fixtureId}) =====`);
      let impresos = 0;
      for (const mid of Object.keys((bo[CASA] || {}).markets || {})) {
        const mkB = bo[CASA].markets[mid], mkC = ((bo[JUEZ] || {}).markets || {})[mid];
        const tieneJug = o => Object.keys(o?.players || {}).some(p => p !== '0');
        const esProp = Object.values(mkB.outcomes || {}).some(tieneJug);
        if (!esProp) continue;
        const meta = await metaDe(mid);
        console.log(`\n--- mid ${mid} · "${meta?.n}" · h=${meta?.h} · outs=${JSON.stringify(meta?.outs)}`);
        console.log(`${CASA}: ` + JSON.stringify(mkB).slice(0, 2500));
        console.log(`${JUEZ}: ` + (mkC ? JSON.stringify(mkC).slice(0, 2500) : 'NO TIENE ESTE MID'));
        if (++impresos >= 3) break;
      }
      if (!impresos) console.log('sin mercados de jugador en este partido');
    }
    await telegram('🔬 Sonda de props lista — estructura cruda en el log de Actions.');
    return;
  }
  /* "/depurar casas [palabra]": lista el catálogo completo de bookmakers de
     OddsPapi en el log, con las que calzan la palabra destacadas por chat */
  if (/casas|bookmaker|pinnacle/i.test(texto)) {
    const palabra = (texto.match(/casas\s+(\S+)/i) || [])[1] || 'pinnacle';
    const lista = await api('bookmakers');
    const arr = Array.isArray(lista) ? lista : [];
    console.log('=== CATÁLOGO bookmakers (' + arr.length + ') ===');
    for (const b of arr) console.log(`${b.slug || b.bookmakerSlug} | ${b.bookmakerName || ''} | cloneOf:${b.cloneOf || '-'}`);
    const calzan = arr.filter(b => new RegExp(palabra, 'i').test((b.slug || b.bookmakerSlug || '') + ' ' + (b.bookmakerName || '')));
    await telegram(`🔍 Catálogo OddsPapi: ${arr.length} casas. Calzan con "${escHtml(palabra)}": `
      + (calzan.length ? calzan.map(b => '<code>' + escHtml(b.slug || b.bookmakerSlug) + '</code>').join(' · ') : 'NINGUNA')
      + '\nLista completa en el log de Actions.');
    return;
  }
  const idsPedidos = (texto.match(/id\d+/g) || []);
  let fixes = idsPedidos;
  if (!fixes.length) {
    const viejas = Object.values(REG)
      .filter(e => e.estado === 'pendiente' && Date.now() - new Date(e.inicio).getTime() > 4 * 3600e3)
      .sort((a, b) => a.inicio < b.inicio ? -1 : 1);
    fixes = [...new Set(viejas.map(e => e.fix))].slice(0, 3);
  }
  if (!fixes.length) { await telegram('🔬 No hay pendientes viejas que depurar.'); return; }
  const resumen = [];
  for (const fix of fixes) {
    const mias = Object.values(REG).filter(e => e.fix === fix);
    console.log(`\n===== FIXTURE ${fix} (${mias[0]?.partido || '?'}) =====`);
    console.log('mis apuestas:', mias.map(e => `${e.mid}|${e.oid} ${e.familia}·${e.lado} [${e.estado}]`).join(' · '));
    for (const ruta of ['settlements', 'scores']) {
      try {
        const d = await api(ruta, { fixtureId: fix }, 2100);
        console.log(`--- ${ruta}:\n` + JSON.stringify(d).slice(0, 4000));
        resumen.push(`${fix.slice(-8)} ${ruta}: ${JSON.stringify(d).slice(0, 60)}…`);
      } catch (e) {
        console.log(`--- ${ruta}: ERROR ${e.message}`);
        resumen.push(`${fix.slice(-8)} ${ruta}: ❌ ${e.message}`);
      }
    }
  }
  await telegram('<b>🔬 Depuración lista</b> — detalle completo en el log de Actions.\n\n<code>'
    + escHtml(resumen.join('\n').slice(0, 3000)) + '</code>');
}

/* Liquidación manual: para el punto ciego (córners, ITF) donde ninguna API
   publica el resultado pero tú lo viste. "/liquidar zakynthos G".
   Resultados: G ganada · P perdida · E empate/push · MG media ganada · MP media perdida */
async function cmdLiquidar(texto) {
  const partes = texto.replace(/^\/?\S+\s*/, '').trim().split(/\s+/);
  const resTxt = (partes[partes.length - 1] || '').toUpperCase();
  const RES = { G: 'G', P: 'P', E: 'E', MG: 'MG', MP: 'MP', GANADA: 'G', PERDIDA: 'P', PUSH: 'E', EMPATE: 'E' };
  const estado = RES[resTxt];
  const claves = (estado ? partes.slice(0, -1) : partes).join(' ').toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '');
  if (!claves) {
    await telegram('Uso: <code>/liquidar palabras del partido G</code>\n'
      + 'Resultados: G ganada · P perdida · E push · MG media ganada · MP media perdida\n'
      + 'Sin resultado al final, solo muestra las que calzan.');
    return;
  }
  const norm = s => String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  const cand = Object.values(REG).filter(e =>
    (e.estado === 'pendiente' || e.estado === 'X')
    && claves.split(/\s+/).every(p => norm(e.partido + ' ' + e.familia + ' ' + e.lado + ' ' + e.liga).includes(p)));
  if (!cand.length) { await telegram('No encontré pendientes que calcen con "' + escHtml(claves) + '".'); return; }
  if (cand.length > 1 || !estado) {
    await telegram('<b>' + cand.length + ' calzan:</b>\n\n' + cand.slice(0, 8).map(e =>
      `${escHtml(e.partido)}\n${escHtml(e.familia)} · <b>${escHtml(e.lado)}</b> @${e.cuota} [${e.estado}]`).join('\n\n')
      + (cand.length > 8 ? '\n\n…y más.' : '')
      + '\n\n' + (estado ? 'Afina las palabras hasta que quede UNA.' : 'Agrega el resultado al final: G, P, E, MG o MP.'));
    return;
  }
  const e = cand[0];
  e.estado = estado;
  e.manual = true;
  guardarRegistro();
  const neto = retornoDe(e) - e.monto;
  await telegram(`✅ Liquidada a mano: <b>${escHtml(e.lado)}</b> (${escHtml(e.familia)})\n`
    + `${escHtml(e.partido)}\n${estado} → ${neto >= 0 ? '+' : '−'}${plata(Math.abs(neto))}`);
}

/* ---------- COSECHA tenis de mesa: base de datos PROPIA ----------
   Fase 1 del camino "justo propio": cada /cosechar recoge los resultados
   (set por set) de las ligas industriales y los guarda en mesa.json.
   Con 2-3 semanas de datos se monta un Elo por jugador — sin depender de
   la opinión de ninguna casa. Costo: ~1 request por partido nuevo. */
async function cmdCosechar() {
  const MESA_PATH = path.join(DIR, 'mesa.json');
  let DB = { partidos: {}, sin: {} };
  try { DB = { ...DB, ...JSON.parse(fs.readFileSync(MESA_PATH, 'utf8')) } } catch {}
  const LIGAS = CFG.mesaLigas || ['Czech Liga Pro', 'TT Elite Series'];
  const d = new Date();
  const f1 = new Date(d.getTime() - 2 * 864e5).toISOString().slice(0, 10);
  const f2 = d.toISOString().slice(0, 10);
  const fx = await api('fixtures', { sportId: 25, from: f1, to: f2 }, 2100);
  const cand = (Array.isArray(fx) ? fx : fx.data || [])
    .filter(f => LIGAS.some(l => (f.tournamentName || '').includes(l)))
    .filter(f => new Date(f.startTime).getTime() < Date.now() - 40 * 60e3)
    .filter(f => !DB.partidos[f.fixtureId] && (DB.sin[f.fixtureId] || 0) < 3);
  const TOPE = 250;
  let ok = 0, fallas = 0;
  const req0 = REQ;
  for (const f of cand.slice(0, TOPE)) {
    let P = null;
    try { P = periodosDe(await api('scores', { fixtureId: f.fixtureId }, 1100)); } catch {}
    const res = P && P.result;
    if (!res || !Number.isFinite(res.participant1Score)) {
      DB.sin[f.fixtureId] = (DB.sin[f.fixtureId] || 0) + 1;
      fallas++;
      continue;
    }
    const sets = Object.entries(P).filter(([k]) => /^p\d+$/.test(k))
      .sort((a, b) => +a[0].slice(1) - +b[0].slice(1))
      .map(([, v]) => [v.participant1Score, v.participant2Score]);
    DB.partidos[f.fixtureId] = {
      t: f.startTime, liga: f.tournamentName,
      p1: f.participant1Name, p2: f.participant2Name,
      s1: res.participant1Score, s2: res.participant2Score, sets,
    };
    delete DB.sin[f.fixtureId];
    ok++;
  }
  fs.writeFileSync(MESA_PATH, JSON.stringify(DB));
  const total = Object.keys(DB.partidos).length;
  const jugadores = new Set();
  for (const p of Object.values(DB.partidos)) { jugadores.add(p.p1); jugadores.add(p.p2); }
  await telegram([
    '<b>🏓 Cosecha de tenis de mesa</b>',
    `Nuevos: ${ok} partidos` + (fallas ? ` · ${fallas} aún sin resultado` : '')
      + (cand.length > TOPE ? ` · quedaron ${cand.length - TOPE} para la próxima` : ''),
    `Base propia: <b>${total} partidos</b> · <b>${jugadores.size} jugadores</b>`,
    `Ligas: ${LIGAS.join(' · ')}`,
    `<i>${REQ - req0} requests. Cosecha 1-2 veces al día y en 2-3 semanas hay masa para el Elo.</i>`,
  ].join('\n'));
}

/* ---------- ITF: Betano vs bet365 (el estándar de ese circuito) ----------
   Comparación bajo demanda, fuera del foco: partidos ITF de las próximas
   N horas, devig de bet365 como justo, ventajas de Betano. Se anotan como
   sombras (juez: bet365) para que el tablero las mida aparte. */
/* Tablero ITF de favoritos: cada /itf registra TODOS los partidos con la
   cuota del favorito (Betano y bet365); /itf resultados los liquida por
   marcador y muestra: ¿gana el favorito lo que su cuota promete, en qué
   rangos, y por cuánto (2-0 vs 2-1)? */
const ITF_PATH = path.join(DIR, 'itf.json');
let ITFDB = null;
function cargarItf() {
  if (!ITFDB) {
    ITFDB = { partidos: {}, sin: {} };
    try { ITFDB = { ...ITFDB, ...JSON.parse(fs.readFileSync(ITF_PATH, 'utf8')) } } catch {}
  }
  return ITFDB;
}
const guardarItf = () => ITFDB && fs.writeFileSync(ITF_PATH, JSON.stringify(ITFDB));
async function cmdItfResultados() {
  const db = cargarItf();
  const pend = Object.entries(db.partidos)
    .filter(([fix, e]) => e.estado === 'pendiente'
      && Date.now() - new Date(e.t || e.visto).getTime() > 4 * 3600e3
      && (db.sin[fix] || 0) < 3);
  let liq = 0;
  const req0 = REQ;
  for (const [fix, e] of pend.slice(0, 120)) {
    let P = null;
    try { P = periodosDe(await api('scores', { fixtureId: fix }, 1100)); } catch {}
    const res = P && P.result;
    if (!res || !Number.isFinite(res.participant1Score) || res.participant1Score === res.participant2Score) {
      db.sin[fix] = (db.sin[fix] || 0) + 1;
      continue;
    }
    const ganador = res.participant1Score > res.participant2Score ? 1 : 2;
    e.estado = ganador === e.fav ? 'F' : 'D';
    e.marcador = Math.max(res.participant1Score, res.participant2Score) + '-' + Math.min(res.participant1Score, res.participant2Score);
    delete db.sin[fix];
    liq++;
  }
  guardarItf();
  const cer = Object.values(db.partidos).filter(e => e.estado === 'F' || e.estado === 'D');
  const pendN = Object.values(db.partidos).filter(e => e.estado === 'pendiente').length;
  if (!cer.length) {
    await telegram(`📈 Tablero ITF: aún nada liquidado (${pendN} esperando resultado · ${liq} recién liquidados · ${REQ - req0} requests).`);
    return;
  }
  const BANDAS = [['≤1.15', e => e.cB <= 1.15], ['1.16-1.30', e => e.cB > 1.15 && e.cB <= 1.3],
    ['1.31-1.50', e => e.cB > 1.3 && e.cB <= 1.5], ['1.51-1.80', e => e.cB > 1.5 && e.cB <= 1.8],
    ['1.81+', e => e.cB > 1.8]];
  const filas = [];
  for (const [nom, fil] of BANDAS) {
    const a = cer.filter(fil);
    if (!a.length) continue;
    const gano = a.filter(e => e.estado === 'F').length;
    const impl = a.reduce((x, e) => x + 1 / e.cB, 0) / a.length;
    const triunfos = a.filter(e => e.estado === 'F');
    const dosCero = triunfos.filter(e => e.marcador === '2-0' || e.marcador === '3-0').length;
    filas.push(`<b>${nom}</b> · n${a.length} · favorito gana <b>${(gano / a.length * 100).toFixed(0)}%</b> `
      + `(cuota implica ${(impl * 100).toFixed(0)}%)`
      + (triunfos.length ? ` · liso [${dosCero}/${triunfos.length}]` : ''));
  }
  await telegram([
    '<b>📈 Tablero ITF · ¿gana el favorito?</b>',
    `<i>Favorito según cuota de Betano al momento del barrido. "liso" = ganó sin ceder set.</i>`,
    '',
    ...filas,
    '',
    `<i>${cer.length} liquidados · ${pendN} pendientes · ${liq} nuevos ahora · ${REQ - req0} requests.</i>`,
  ].join('\n'));
}
async function cmdItf(horas = 6) {
  const req0 = REQ;
  let tor;
  try { tor = await api('tournaments', { sportId: '12' }); }
  catch (e) {
    await telegram('❌ Tu plan no tiene acceso a tenis (sport 12): ' + escHtml(e.message)
      + '\nMárcalo en el panel de OddsPapi junto a bet365 y reintenta.');
    return;
  }
  let itf = tor.filter(t => /itf|m15|m25|w15|w25|w35|w50|w75|w100/i.test((t.categoryName || '') + ' ' + (t.tournamentName || '')));
  if (!itf.length) itf = tor.filter(t =>
    !/atp|wta|challenger|davis|united|billie|exhibition|utr|grand/i.test((t.categoryName || '') + ' ' + (t.tournamentName || '')));
  const idsItf = new Set(itf.map(t => t.tournamentId));
  const d = new Date();
  const fx = await api('fixtures', {
    sportId: '12',
    from: d.toISOString().slice(0, 10),
    to: new Date(d.getTime() + 864e5).toISOString().slice(0, 10),
  }, 2100);
  /* OJO: la bandera hasOdds de /fixtures es poco confiable (lo vimos en tenis
     de mesa) — NO se filtra por ella; el batch de cuotas dirá la verdad */
  const todos = (Array.isArray(fx) ? fx : fx.data || []);
  const cand = todos
    .filter(f => idsItf.has(f.tournamentId))
    .filter(f => { const t = new Date(f.startTime).getTime(); return t > Date.now() + 10 * 60e3 && t < Date.now() + horas * 3600e3; });
  console.log(`itf: ${tor.length} torneos tenis, ${itf.length} ITF, ${todos.length} fixtures hoy/mañana, ${cand.length} en ventana ${horas}h`);
  /* los torneos a consultar salen del CATÁLOGO (upcomingFixtures), no del
     índice de fixtures que viene incompleto en ITF */
  /* el contador upcomingFixtures TAMBIÉN viene desactualizado: se incluye
     todo torneo ITF con cualquier señal de vida (próximos O futuros) */
  const activos = itf.filter(t => (t.upcomingFixtures || 0) + (t.futureFixtures || 0) > 0)
    .sort((a, b) => ((b.upcomingFixtures || 0) + (b.futureFixtures || 0)) - ((a.upcomingFixtures || 0) + (a.futureFixtures || 0)))
    .slice(0, 75);
  console.log(`itf torneos activos por catálogo: ${activos.length} · ej: ${activos.slice(0, 8).map(t => t.tournamentName + '(' + t.upcomingFixtures + ')').join(', ')}`);
  if (!activos.length) {
    await telegram(`🎾 ITF: el catálogo no muestra torneos ITF con partidos próximos.`);
    return;
  }
  const tids = [...new Set([...activos.map(t => t.tournamentId), ...cand.map(f => f.tournamentId)])];
  const idx = new Map(cand.map(f => [f.fixtureId, f]));
  for (const f of cand.slice(0, 20))
    console.log(`itf cand: ${f.fixtureId} | ${f.startTime} | ${f.participant1Name} vs ${f.participant2Name} | ${f.tournamentName}`);
  const JB = 'bet365';
  let filas = [];
  let ambos = 0, soloBet = 0, logPath = 0, grabados = 0;
  for (let i = 0; i < tids.length && i < 60; i += 5) {
    const lote = tids.slice(i, i + 5);
    let bet, b365;
    try {
      bet = await oddsBatch(lote, CASA);
      b365 = bet.length ? await oddsBatch(lote, JB) : [];
    } catch (e) { await telegram('❌ ' + escHtml(e.message)); return; }
    const jIdx = new Map(b365.map(f => [f.fixtureId, (f.bookmakerOdds || {})[JB]]));
    console.log(`itf lote ${lote.join(',')}: betano trae ${bet.length} fixtures, bet365 trae ${b365.length}`);
    for (const f of bet) {
      const b = (f.bookmakerOdds || {})[CASA], j = jIdx.get(f.fixtureId);
      if (!b) continue;
      let info = idx.get(f.fixtureId);
      if (!info) {
        /* el índice /fixtures de OddsPapi viene incompleto en ITF: el partido
           existe en el feed de cuotas — los nombres se rescatan del slug del
           link de Betano y la hora queda estimada */
        const crudoPath = String(b.fixturePath || '');
        if (logPath++ < 3) console.log('itf fixturePath ej:', JSON.stringify(crudoPath));
        const partes = crudoPath.split('/').filter(x => x && !/^https?:$/.test(x) && !/betano/.test(x));
        const slugNom = partes.filter(x => /[a-z]-[a-z]/i.test(x)).pop() || partes[partes.length - 2] || '';
        if (!slugNom) continue;
        info = {
          participant1Name: slugNom.replace(/-/g, ' '), participant2Name: '',
          startTime: new Date(Date.now() + 2 * 3600e3).toISOString(),
          tournamentName: 'ITF (sin índice)', sinIndice: true,
        };
      }
      if (!j) { soloBet++; continue; }
      ambos++;
      for (const mid of Object.keys(b.markets || {})) {
        const meta = await metaDe(mid);
        if (!meta || meta.len !== 2) continue;
        const fam = familiaDe('12', meta.n);
        if (!fam) continue;
        const oB = b.markets[mid].outcomes || {}, oJ = (j.markets || {})[mid]?.outcomes || {};
        const oids = Object.keys(oB);
        if (oids.length !== 2) continue;
        const pB = {}, pJ = {}; let ok = true;
        for (const oid of oids) {
          const b0 = (oB[oid].players || {})['0'], j0 = ((oJ[oid] || {}).players || {})['0'];
          if (!b0?.active || !(b0.price > 1) || !j0?.active || !(j0.price > 1)) { ok = false; break; }
          pB[oid] = b0.price; pJ[oid] = j0.price;
        }
        if (!ok) continue;
        const [jA, jB2] = desvigar(pJ[oids[0]], pJ[oids[1]]);
        const justos = { [oids[0]]: jA, [oids[1]]: jB2 };
        /* tablero de favoritos: se anota TODO partido con mercado Ganador */
        if (fam.fam === 'Ganador' && !info.sinIndice
            && new Date(info.startTime).getTime() > Date.now()) {
          const db = cargarItf();
          if (!db.partidos[f.fixtureId]) {
            const o1 = oids.find(o => /^1$|home/i.test(meta.outs[o] || o)) || oids[0];
            const o2 = oids.find(o => o !== o1) || oids[1];
            const favLado = pB[o1] <= pB[o2] ? 1 : 2;
            const favOid = favLado === 1 ? o1 : o2, dogOid = favLado === 1 ? o2 : o1;
            db.partidos[f.fixtureId] = {
              visto: new Date().toISOString(), t: info.sinIndice ? null : info.startTime,
              torneo: info.tournamentName || 'ITF',
              p1: info.sinIndice ? null : info.participant1Name, p2: info.sinIndice ? null : info.participant2Name,
              fav: favLado, cB: +pB[favOid].toFixed(2), cJ: +pJ[favOid].toFixed(2),
              dB: +pB[dogOid].toFixed(2), estado: 'pendiente',
            };
            grabados++;
          }
        }
        for (const oid of oids) {
          const vent = pB[oid] / justos[oid] - 1;
          if (vent <= 0.005 || pB[oid] > (CFG.sombraCuotaMaxima ?? 3.5)) continue;
          const crudo = meta.outs[oid] || oid;
          const n1 = info.sinIndice ? 'Jugador 1' : (info.participant1Name || '?');
          const n2 = info.sinIndice ? 'Jugador 2' : (info.participant2Name || '?');
          const lado = fam.lado === 'yn' ? (/yes/i.test(crudo) ? 'Sí' : 'No')
            : (/^1$|home/i.test(crudo) ? n1 : n2) + (fam.lado === 'ah' ? ' ' + (/^1$|home/i.test(crudo) ? meta.h : -meta.h) : '');
          filas.push({
            sig: f.fixtureId + '|' + mid + '|' + oid, fix: f.fixtureId,
            bFixId: b.bookmakerFixtureId || null, tReal: !info.sinIndice,
            partido: info.sinIndice ? info.participant1Name : n1 + ' vs ' + n2,
            liga: info.tournamentName || 'ITF',
            inicio: info.startTime, familia: fam.fam, lado,
            cuota: +pB[oid].toFixed(3), justo: +justos[oid].toFixed(3), vent: +vent.toFixed(4),
          });
        }
      }
    }
  }
  filas.sort((a, b) => b.vent - a.vent);
  /* Betano manda slug "e-e" en ITF (sin nombres): se rescatan del endpoint
     /fixture individual, solo para lo que se va a reportar (~1 req c/u) */
  let corregidas = 0;
  const sinNombre = [...new Set(filas.slice(0, 14)
    .filter(s => /^e e$|^Jugador/.test(s.partido) || /^Jugador/.test(s.lado))
    .map(s => s.fix))].slice(0, 14);
  for (const fixId of sinNombre) {
    try {
      const d = await api('fixture', { fixtureId: fixId }, 2100);
      const c = Array.isArray(d) ? d[0] : (d && d.data ? (Array.isArray(d.data) ? d.data[0] : d.data) : d);
      const n1 = c?.participant1Name, n2 = c?.participant2Name;
      if (!n1 || !n2) continue;
      console.log('itf /fixture', fixId, '→ startTime:', JSON.stringify(c.startTime), '·', n1, 'vs', n2);
      /* hora válida solo si es cuerda (la API a veces manda basura/época) */
      const tOk = c.startTime && !isNaN(new Date(c.startTime)) && new Date(c.startTime).getFullYear() >= 2020;
      for (const s of filas.filter(x => x.fix === fixId)) {
        s.partido = n1 + ' vs ' + n2;
        s.lado = s.lado.replace(/^Jugador 1/, n1).replace(/^Jugador 2/, n2);
        if (tOk) { s.inicio = c.startTime; s.tReal = true; }
        if (c.tournamentName) s.liga = c.tournamentName;
      }
      /* y se corrigen las ya anotadas en el registro con nombre de relleno */
      for (const e of Object.values(REG)) {
        if (e.fix !== fixId || e.juez !== 'bet365') continue;
        e.partido = n1 + ' vs ' + n2;
        e.lado = e.lado.replace(/^Jugador 1/, n1).replace(/^Jugador 2/, n2).replace(/^e e /, n1 + ' ');
        if (c.startTime) e.inicio = c.startTime;
        if (c.tournamentName) e.liga = c.tournamentName;
        corregidas++;
      }
    } catch (e) { console.log('itf /fixture falló', fixId, e.message); }
  }
  /* fuera los partidos YA COMENZADOS: sus cuotas prematch quedan congeladas
     en el feed y las "ventajas" gigantes son líneas muertas, no valor. Solo
     se reporta/anota lo verificado como futuro. */
  const empezados = filas.filter(s => s.tReal && new Date(s.inicio).getTime() <= Date.now()).length;
  const dudosos = filas.filter(s => !s.tReal).length;
  filas = filas.filter(s => s.tReal && new Date(s.inicio).getTime() > Date.now());
  /* con sombras apagadas (modo 100% foco) el /itf no escribe al registro:
     solo alimenta su propio tablero de favoritos (itf.json) */
  let nuevas = 0;
  if (CFG.sombras !== false) for (const s of filas) {
    if (REG[s.sig]) continue;
    REG[s.sig] = {
      fix: s.fix, mid: s.sig.split('|')[1], oid: s.sig.split('|')[2],
      visto: new Date().toISOString(), inicio: s.inicio, sid: '12',
      liga: s.liga, partido: s.partido, familia: s.familia, lado: s.lado,
      cuota: s.cuota, justo: s.justo, vent: s.vent,
      monto: montoDe(s.cuota, s.vent), estado: 'pendiente', sombra: true, juez: 'bet365',
    };
    nuevas++;
  }
  if (nuevas || corregidas) guardarRegistro();
  if (grabados) guardarItf();
  /* las mejores 15 por margen, mostradas agrupadas por torneo y horario */
  const mostrar = filas.slice(0, 15);
  mostrar.sort((a, b) => a.liga.localeCompare(b.liga)
    || (a.inicio < b.inicio ? -1 : a.inicio > b.inicio ? 1 : 0) || b.vent - a.vent);
  const top = [];
  let ligaAct = null;
  for (const s of mostrar) {
    if (s.liga !== ligaAct) { ligaAct = s.liga; top.push(`🏆 <b>${escHtml(s.liga)}</b>`); }
    const [pa, pb] = String(s.partido).split(' vs ');
    const rival = s.lado.startsWith(pa) ? pb : pa;
    top.push(`· ${horaTxt(s.inicio)} — <b>${escHtml(s.lado)}</b>${rival ? ' (vs ' + escHtml(rival) + ')' : ''}`
      + ` @${s.cuota.toFixed(2)} (justo ${s.justo.toFixed(2)}) → <b>+${(s.vent * 100).toFixed(1)}%</b> · ${escHtml(s.familia)}`
      + (s.bFixId ? ` · <a href="https://lat.betano.com/cuotas-de-partido/e-e/${escHtml(s.bFixId)}/">Abrir</a>` : ''));
  }
  await telegram([
    `<b>🎾 ITF · Betano vs bet365 · próximas ${horas} h</b>`,
    `Torneos revisados: ${tids.length} · ${ambos} partidos cotizados por ambos · ${soloBet} sin bet365`,
    `${filas.length} lados con ventaja positiva`
      + (CFG.sombras !== false ? ` · ${nuevas} anotados al tablero (sombra, juez bet365)` : ' · solo vista, nada al registro (sombras apagadas)'),
    grabados ? `📈 ${grabados} partidos nuevos al tablero de favoritos (/itf resultados)` : '',
    (empezados || dudosos) ? `<i>🚫 fuera: ${empezados} ya comenzados (línea congelada) · ${dudosos} sin hora verificable</i>` : '',
    '',
    ...(top.length ? top : ['Sin ventajas sobre el justo de bet365.']),
    '',
    `<i>${REQ - req0} requests. OJO: reglas de retiro pueden diferir entre casas — en ITF eso importa.</i>`,
  ].join('\n'));
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
  const anotadas = Object.values(REG);
  const pend = anotadas.filter(e => e.estado === 'pendiente').length;
  await telegram([
    '<b>Estado del Vigía</b>',
    `Cuota API: ${cuota}`,
    `Último barrido: ${ult} (${EST.stats.requests || 0} requests)`,
    `Señales del último barrido: ${vivas.length}`,
    `Tablero simulado: ${anotadas.length} apuestas anotadas · ${pend} pendientes`,
    '',
    'Comandos: /barrer · /rapido · /tablero · /estado · /ayuda',
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
  const aProbar = [...new Set([CASA, ...mias.filter(s => /betano/i.test(s))])];
  for (const slug of aProbar) {
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
    `<i>El Vigía está leyendo: <b>${escHtml(CASA)}</b> (juez: ${escHtml(JUEZ)})</i>`,
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
/* Compara, para un partido concreto, lo que cotiza cada casa del plan.
   Sirve para saber qué espejo de Betano calza con lo que ves en pantalla:
   abres el partido en tu Betano y miras cuál columna coincide. */
async function cmdComparar(busca) {
  let elegido = null;
  for (const sid of Object.keys(CFG.deportes)) {
    const fx = await fixturesDe(sid);
    const cands = fx
      .filter(f => new Date(f.startTime).getTime() > Date.now() + 10 * 60e3)
      .filter(f => !busca || (f.p1 + ' ' + f.p2 + ' ' + f.liga).toLowerCase().includes(busca));
    cands.sort((a, b) => new Date(a.startTime) - new Date(b.startTime));
    if (cands.length && (!elegido || new Date(cands[0].startTime) < new Date(elegido.startTime))) {
      elegido = cands[0];
    }
    if (busca && elegido) break;
  }
  if (!elegido) { await telegram('No encontré un partido próximo con ese texto.'); return; }

  const d = await api('odds', { fixtureId: elegido.fixtureId, oddsFormat: 'decimal' });
  const fx = Array.isArray(d) ? d[0] : (d.data ? d.data[0] : d);
  const bo = fx?.bookmakerOdds || {};
  const casas = Object.keys(bo);
  if (!casas.length) { await telegram('Ese partido no trae cuotas todavía.'); return; }

  /* mercados whitelisted que cotice al menos una casa */
  const filas = [];
  const vistos = new Set();
  for (const casa of casas) {
    for (const mid of Object.keys(bo[casa].markets || {})) {
      if (vistos.has(mid)) continue;
      const meta = await metaDe(mid);
      if (!meta || meta.len !== 2) continue;
      const fam = familiaDe(elegido.sid || '10', meta.n);
      if (!fam) continue;
      vistos.add(mid);
      const precios = casas.map(c => {
        const outs = (bo[c].markets || {})[mid]?.outcomes || {};
        const ps = Object.keys(outs).map(oid => (outs[oid].players || {})['0']?.price)
          .filter(p => p > 1).map(p => p.toFixed(2));
        return ps.length ? ps.join('/') : '—';
      });
      if (precios.filter(p => p !== '—').length) {
        filas.push(`<code>${escHtml((meta.n + ' ' + (meta.h ?? '')).slice(0, 30).padEnd(30))}</code> ${precios.join(' · ')}`);
      }
      if (filas.length >= 14) break;
    }
    if (filas.length >= 14) break;
  }
  await telegram([
    `<b>⚖️ ${escHtml(elegido.p1)} vs ${escHtml(elegido.p2)}</b>`,
    `${escHtml(elegido.liga)} · ${horaTxt(elegido.startTime)}`,
    '',
    '<b>Casas:</b> ' + casas.map(escHtml).join(' · '),
    '',
    ...filas,
    '',
    '<i>Cada columna es una casa, en ese orden. Abre este partido en tu Betano '
      + 'y compara: la columna que coincida con lo que ves es tu espejo real.</i>',
    elegido.bookmakerFixtureId ? '' : '',
  ].filter(Boolean).join('\n'));
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
  if (['comparar', 'compara', 'cuotas', 'ver'].includes(c)) {
    const busca = texto.replace(/^\/?\S+\s*/, '').trim().toLowerCase();
    await telegram('⚖️ Buscando' + (busca ? ' "' + escHtml(busca) + '"' : ' el próximo partido') + '…');
    await cmdComparar(busca);
    return true;
  }
  if (['props', 'jugadores', 'players', 'prop'].includes(c)) {
    await telegram(`🎯 Censando líneas de jugador · <b>${sids ? queDeportes : 'básquet + béisbol'}</b>…`);
    await cmdProps(sids);
    return true;
  }
  if (['tablero', 'resultados', 'balance', 'registro', 'historial'].includes(c)) {
    /* 100% foco: /tablero a secas muestra SOLO el foco (fútbol AH/DNB, señales
       reales, bandas de cuota y ventaja). "/tablero futbol" = todo fútbol;
       "/tablero todo" = historial global con sombras */
    const global = /todo|global/i.test(texto);
    await cmdTablero(global ? null : (sids || ['10']), { foco: !global && !sids });
    return true;
  }
  if (['depurar', 'debug'].includes(c)) { await cmdDepurar(texto); return true; }
  if (['liquidar', 'liquida', 'resultado'].includes(c)) { await cmdLiquidar(texto); return true; }
  if (['cosechar', 'cosecha', 'mesa'].includes(c)) { await cmdCosechar(); return true; }
  if (['itf'].includes(c)) {
    if (/resultado|tablero|favorito/i.test(texto)) await cmdItfResultados();
    else await cmdItf(horas ?? 6);
    return true;
  }
  if (['estado', 'status', 'cuota'].includes(c)) { await cmdEstado(); return true; }
  if (['ayuda', 'help', 'start', 'comandos'].includes(c)) {
    await telegram([
      '<b>Vigía · comandos</b>',
      '',
      `<b>/barrer</b> — fútbol (el foco) en las próximas ${CFG.horizonteHoras} h; agrega deporte para barrer otro`,
      '<b>/rapido</b> — el foco, dentro de 6 h',
      '<b>/tablero</b> — el balance de lo que estamos jugando: AH fútbol con tus criterios actuales, DNB contado como AH 0.0 (<code>/tablero todo</code> = historial completo)',
      '<b>/props</b> — qué líneas de jugador trae tu feed (WNBA, MLB) y si tienen juez (~7 requests)',
      '<b>/liquidar zakynthos G</b> — cierra a mano una del punto ciego que tú viste (G/P/E/MG/MP)',
      '<b>/cosechar</b> — recoge resultados de tenis de mesa para la base propia del Elo (~200 req)',
      '<b>/estado</b> — cuota de API y último barrido (gratis)',
      '<b>/porque</b> — qué quedó fuera y por qué, con ejemplos reales',
      '<b>/casas</b> — qué espejos de Betano existen y a qué dominio apuntan',
      '<b>/comparar equipo</b> — cuotas de cada casa en un partido, para calzar con tu pantalla',
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
