#!/usr/bin/env node
/* ============================================================
   VIGÍA — barrido total Betano vs Cloudbet (OddsPapi v4)
   Corre en GitHub Actions cada 15 min. Manda señales a Telegram.
   Sin dependencias: Node 20+ (fetch nativo).

   Flujo de un ciclo:
   1. torneos activos por deporte (cache diario en estado.json)
   2. fixtures con nombres/hora/liga (cache 1 h)
   3. odds batch por lotes de 5 ligas × 2 casas (betano, cloudbet)
   4. señales = whitelist de familias del censo + criterios config
   5. Telegram: nueva señal / ventana ▼ / muerta — con memoria
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
const DRY = !!process.env.DRY || !TG_TOKEN || !TG_CHAT;
if (!KEY) { console.error('Falta ODDSPAPI_KEY'); process.exit(1); }

/* ---------- estado persistente (se commitea tras cada ciclo) ---------- */
let EST = { torneos: {}, fixtures: {}, cobertura: {}, barridas: {}, mercados: {}, senales: {}, stats: {} };
try { EST = { ...EST, ...JSON.parse(fs.readFileSync(ESTADO_PATH, 'utf8')) } } catch {}

/* ---------- horario activo (hora de Santiago) ---------- */
const horaScl = +new Intl.DateTimeFormat('en-GB', { timeZone: 'America/Santiago', hour: 'numeric', hour12: false }).format(new Date());
const { inicio, fin } = CFG.horarioSantiago;
const activo = fin > 24 ? (horaScl >= inicio || horaScl < fin - 24) : (horaScl >= inicio && horaScl < fin);
if (!activo) { console.log(`Fuera de horario (Santiago ${horaScl}h) — ciclo omitido.`); process.exit(0); }

/* ---------- API con pacing, timeout y reintentos ---------- */
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
      r = await fetch(u, { signal: AbortSignal.timeout(20000), headers: { 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) vigia/1.0' } });
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
  if (DRY) { console.log('\n[TELEGRAM]\n' + html.replace(/<[^>]+>/g, '')); return true; }
  const r = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: TG_CHAT, text: html, parse_mode: 'HTML', disable_web_page_preview: true }),
  });
  if (!r.ok) { console.error('Telegram falló:', await r.text().catch(() => r.status)); return false; }
  return true;
}

/* ---------- helpers de dominio ---------- */
const hoyKey = new Intl.DateTimeFormat('sv-SE', { timeZone: 'America/Santiago' }).format(new Date());
const plata = n => '$' + Math.round(n).toLocaleString('es-CL');
const slug = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '')
  .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
const linkDe = (f) => f.bookmakerFixtureId
  ? `https://lat.betano.com/cuotas-de-partido/${slug(f.p1)}-${slug(f.p2)}/${f.bookmakerFixtureId}/`
  : 'https://lat.betano.com/';
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

/* Whitelist ampliada (censo 14-08-2026). Devuelve
   {fam, lado:'ou'|'ah'|'ml'|'yn', eq?:1|2, castigada?:true} o null.
   'yn' = mercados Sí/No · 'eq' = familia por equipo/jugador (1=local, 2=visita).
   'castigada' = juez borroso (córners/tarjetas/nicho): usa umbralCastigado.
   Las familias que solo cotiza una casa NO se listan: sin juez jamás disparan. */
function familiaDe(sid, nombre, h) {
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
    if ((m = n.match(/^participant ([12]) to win a set$/)))
      return { fam: 'Gana un set', lado: 'yn', eq: +m[1] };
    return null;
  }
  if (sid === '13') {
    if (/^handicap \(incl\. extra innings\)$/.test(n)) return { fam: 'Run line', lado: 'ah' };
    if (/^over under \(incl\. extra innings\)$/.test(n)) return { fam: 'Total de carreras', lado: 'ou' };
    if (/^over under first to fifth inning$/.test(n)) return { fam: 'Total primeras 5', lado: 'ou' };
    if (/^over under first inning$/.test(n)) return { fam: 'Total 1ª entrada', lado: 'ou' };
    if (/^winner \(incl\. extra innings\)$/.test(n)) return { fam: 'Ganador', lado: 'ml' };
    if ((m = n.match(/^over under team ([12]) \(incl\. extra innings\)$/)))
      return { fam: 'Carreras', lado: 'ou', eq: +m[1] };
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

/* ---------- 1 · torneos activos (cache diario) ---------- */
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

/* ---------- 2 · fixtures en ventana (cache 1 h) ---------- */
async function fixturesDe(sid) {
  const c = EST.fixtures[sid];
  if (c && Date.now() - c.ts < 3600e3) return c.lista;
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

/* ---------- 3 · odds batch por lotes de ligas ---------- */
async function oddsBatch(tids, casa) {
  try {
    const d = await api('odds-by-tournaments', { tournamentIds: tids.join(','), bookmaker: casa, oddsFormat: 'decimal' }, 1100);
    return Array.isArray(d) ? d : d.data || [];
  } catch (e) {
    if (e.api && /FIXTURE_NOT_FOUND/.test(e.api.code || '')) return [];
    throw e;
  }
}

/* ---------- catálogo de mercados: solo los ids que aparecen ---------- */
let CATALOGO = null;
async function metaDe(mid) {
  if (EST.mercados[mid]) return EST.mercados[mid];
  if (!CATALOGO) {
    console.log('Bajando catálogo de mercados (1 request)...');
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

/* ---------- ciclo principal ---------- */
const ahora = Date.now();
const antic = CFG.anticipacionMin * 60e3;
const horizonte = CFG.horizonteHoras * 3600e3;
const nuevas = [], ventanas = [], muertas = [];
let candidatas = 0;

async function ciclo() {
  /* fixtures apostables por deporte, y las ligas que los contienen */
  const porLiga = new Map();   /* tid -> {sid, fixtures:[...], pronto:ts mínimo} */
  for (const sid of Object.keys(CFG.deportes)) {
    const [tor, fx] = [await torneosDe(sid), await fixturesDe(sid)];
    const nombres = new Map(tor.map(t => [t.id, t.n + ' (' + (t.cat || '') + ')']));
    for (const f of fx) {
      const t = new Date(f.startTime).getTime();
      if (t < ahora + antic || t > ahora + horizonte) continue;
      if (SIMU.test(f.liga + ' ' + f.p1 + ' ' + f.p2)) continue;
      if (!nombres.has(f.tournamentId)) continue;   /* liga simulada o inactiva */
      f.liga = f.liga || nombres.get(f.tournamentId);
      f.sid = sid;
      if (!porLiga.has(f.tournamentId)) porLiga.set(f.tournamentId, { sid, fixtures: [], pronto: Infinity });
      const L = porLiga.get(f.tournamentId);
      L.fixtures.push(f);
      L.pronto = Math.min(L.pronto, t);
    }
  }

  /* ligas con alguna señal viva: se barren SIEMPRE (siguen deriva y muerte) */
  const fixVivos = new Set(Object.values(EST.senales).map(s => s.fix));

  /* Polling escalonado: cada liga tiene su ritmo según cuán pronto juega.
     Inminente (≤2 h) o con señal viva: cada ciclo. Hoy (≤8 h): cada ~30 min.
     Lejana: cada ~90 min. Esto libera presupuesto para cubrir TODO. */
  function leToca(tid, L) {
    const c = EST.cobertura[tid];
    if (c && !c.ok && Date.now() - c.ts < 20 * 3600e3) return false;   /* sin betano: 1 vez/día */
    if (L.fixtures.some(f => fixVivos.has(f.fixtureId))) return true;
    const falta = L.pronto - Date.now();
    const desde = Date.now() - (EST.barridas[tid] || 0);
    if (falta <= 2 * 3600e3) return true;
    if (falta <= 8 * 3600e3) return desde >= 30 * 60e3;
    return desde >= 90 * 60e3;
  }
  const ligas = [...porLiga.entries()].filter(([tid, L]) => leToca(tid, L))
    .sort((a, b) => a[1].pronto - b[1].pronto);
  console.log(`Ligas apostables: ${porLiga.size} · les toca este ciclo: ${ligas.length}`);

  /* lotes de 5 ligas del mismo deporte, y ROTACIÓN entre deportes:
     una tanda de cada deporte por turno — fútbol ya no acapara el tope */
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

  const porDeporte = {};
  let tope = false;
  for (const lote of lotes) {
    if (REQ >= CFG.maxRequestsPorCiclo) { tope = true; break; }
    const bet = await oddsBatch(lote.tids, 'betano');
    const cbt = bet.length ? await oddsBatch(lote.tids, 'cloudbet') : [];
    const cbIdx = new Map(cbt.map(f => [f.fixtureId, (f.bookmakerOdds || {}).cloudbet]));
    const conBet = new Set(bet.map(f => f.tournamentId));
    for (const tid of lote.tids) {
      EST.cobertura[tid] = { ok: !!(conBet.has(tid) || (EST.cobertura[tid] || {}).ok), ts: Date.now() };
      EST.barridas[tid] = Date.now();
    }
    porDeporte[CFG.deportes[lote.sid] || lote.sid] = (porDeporte[CFG.deportes[lote.sid] || lote.sid] || 0) + lote.tids.length;
    for (const f of bet) {
      const info = fixIdx.get(f.fixtureId);
      const b = (f.bookmakerOdds || {}).betano, c = cbIdx.get(f.fixtureId);
      if (!info || !b || !c) continue;
      info.bookmakerFixtureId = b.bookmakerFixtureId || null;
      await procesar(info, b, c);
    }
  }
  console.log('Ligas barridas por deporte:', JSON.stringify(porDeporte),
    tope ? '· tope de requests alcanzado (lo pendiente sigue el próximo ciclo)' : '· todo cubierto');
  EST.stats = { ...EST.stats, porDeporte, tope };
}

/* ---------- señales de un partido ---------- */
async function procesar(info, bet, cb) {
  const porFam = new Map();   /* familia -> mejor señal (una por familia) */
  /* pase 1: mercados whitelisted, con su marca de línea central */
  const cand = [];
  for (const mid of Object.keys(bet.markets || {})) {
    const meta = await metaDe(mid);
    if (!meta || meta.len !== 2) continue;
    const fam = familiaDe(info.sid, meta.n, meta.h);
    if (!fam) continue;
    if (CFG.sinCuartos && meta.h != null && Math.abs(meta.h * 2) % 1 !== 0) continue;
    let central = null;   /* true/false si el feed marca mainLine; null = no dice */
    for (const o of Object.values(bet.markets[mid].outcomes || {})) {
      const p0 = (o.players || {})['0'];
      if (p0?.mainLine === true) { central = true; break; }
      if (p0?.mainLine === false) central = false;
    }
    cand.push({ mid, meta, fam, central });
  }
  /* pase 2: qué líneas de cada familia se miran.
     Con lineasVecinas: la central y sus dos adyacentes (±1 paso).
     Sin marca de central en el grupo: se miran todas (una-por-familia poda). */
  const porGrupo = new Map();
  for (const c of cand) {
    const k = c.meta.n + '|' + (c.fam.eq || '');
    if (!porGrupo.has(k)) porGrupo.set(k, []);
    porGrupo.get(k).push(c);
  }
  const elegidos = [];
  for (const grupo of porGrupo.values()) {
    if (!CFG.soloLineaCentral || grupo.length === 1 || grupo[0].meta.h == null) {
      elegidos.push(...grupo); continue;
    }
    grupo.sort((a, b) => a.meta.h - b.meta.h);
    const ic = grupo.findIndex(c => c.central === true);
    if (ic < 0) { elegidos.push(...grupo.filter(c => c.central !== false)); continue; }
    const paso = CFG.lineasVecinas ? 1 : 0;
    elegidos.push(...grupo.slice(Math.max(0, ic - paso), Math.min(grupo.length, ic + paso + 1)));
  }
  /* pase 3: valor contra el juez */
  for (const { mid, meta, fam } of elegidos) {
    const oB = bet.markets[mid].outcomes || {}, oC = (cb.markets || {})[mid]?.outcomes || {};
    const oids = Object.keys(oB);
    if (oids.length !== 2) continue;
    const pB = {}, pC = {}; let ok = true;
    for (const oid of oids) {
      const b0 = (oB[oid].players || {})['0'], c0 = ((oC[oid] || {}).players || {})['0'];
      if (!b0?.active || !(b0.price > 1) || !c0?.active || !(c0.price > 1)) { ok = false; break; }
      pB[oid] = b0.price; pC[oid] = c0.price;
    }
    if (!ok) continue;
    const [jA, jB] = desvigar(pC[oids[0]], pC[oids[1]]);
    const justos = { [oids[0]]: jA, [oids[1]]: jB };
    const umbral = Math.max(CFG.ventajaMinima[info.sid],
      fam.castigada ? (CFG.umbralCastigado ?? 0.05) : 0);
    const famLabel = fam.fam + (fam.eq ? ' · ' + (fam.eq === 1 ? info.p1 : info.p2) : '');
    for (const oid of oids) {
      const cuota = pB[oid] * (1 - CFG.margenLocal);
      if (cuota > CFG.cuotaMaxima) continue;
      const vent = cuota / justos[oid] - 1;
      candidatas++;
      if (vent < umbral) continue;
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
        link: linkDe(info), sospechosa: vent > CFG.umbralSospechosa,
      };
      const mejor = porFam.get(famLabel);
      if (!mejor || s.vent > mejor.vent) porFam.set(famLabel, s);
    }
  }
  /* memoria: nueva / ventana / actualización */
  for (const s of porFam.values()) {
    const prev = EST.senales[s.sig];
    if (!prev) { EST.senales[s.sig] = { ...s, ts: Date.now(), avisada: false }; nuevas.push(EST.senales[s.sig]); }
    else {
      const probSubio = 1 / s.justo - 1 / prev.justo > 0.004;
      const cuotaQuieta = Math.abs(s.cuota - prev.cuota) < 0.005;
      if (CFG.avisarVentana && probSubio && cuotaQuieta && !prev.ventanaAvisada) {
        prev.ventanaAvisada = true; ventanas.push({ ...s, justoAnt: prev.justo });
      }
      Object.assign(prev, s, { ts: Date.now() });
    }
  }
}

/* ---------- avisos de muerte + poda ---------- */
function podar() {
  for (const [sig, s] of Object.entries(EST.senales)) {
    const empezo = new Date(s.inicio).getTime() < Date.now();
    const vieja = Date.now() - s.ts > 40 * 60e3;   /* 2 ciclos sin verse */
    if (empezo || (vieja && !empezo)) {
      if (CFG.avisarMuerte && s.avisada && !empezo && vieja) muertas.push(s);
      if (empezo || vieja) delete EST.senales[sig];
    }
  }
}

/* ---------- formato de mensajes ---------- */
const EMO = { 10: '⚽', 11: '🏀', 12: '🎾', 13: '⚾' };
function msjSenal(s, tipo) {
  const cab = tipo === 'ventana'
    ? '▼ <b>VENTANA</b> — el justo bajó y Betano no siguió'
    : '🎯 <b>SEÑAL</b>' + (s.sospechosa ? ' ⚠️ <i>ventaja muy alta: verifica en pantalla</i>' : '');
  return [
    cab,
    `${EMO[s.sid] || ''} <b>${escHtml(s.partido)}</b>`,
    `${escHtml(s.liga)} · ${horaTxt(s.inicio)}`,
    `<b>${escHtml(s.lado)}</b> · ${escHtml(s.familia)}`,
    `Cuota <b>${s.cuota.toFixed(2)}</b> · justo ${s.justo.toFixed(2)}` +
      (tipo === 'ventana' ? ` (antes ${s.justoAnt.toFixed(2)})` : '') +
      ` · ventaja <b>+${(s.vent * 100).toFixed(1)}%</b>`,
    `Monto sugerido: <b>${plata(montoDe(s.cuota, s.vent))}</b>`,
    `<a href="${escHtml(s.link)}">Abrir en Betano</a>`,
  ].join('\n');
}

/* ---------- main ---------- */
try {
  await ciclo();
  podar();
  let enviadas = 0;
  for (const s of nuevas.sort((a, b) => b.vent - a.vent)) {
    if (enviadas >= CFG.maxAlertasPorCiclo) break;
    /* solo se marca avisada si Telegram la recibió: si falla, queda
       pendiente y se reintenta en el próximo ciclo */
    if (await telegram(msjSenal(s, 'nueva'))) { s.avisada = true; enviadas++; }
    else break;
  }
  /* señales vivas que quedaron sin avisar por un fallo anterior de Telegram */
  for (const s of Object.values(EST.senales)) {
    if (s.avisada || nuevas.includes(s)) continue;
    if (enviadas >= CFG.maxAlertasPorCiclo) break;
    if (await telegram(msjSenal(s, 'nueva'))) { s.avisada = true; enviadas++; }
    else break;
  }
  const resto = nuevas.length - Math.min(nuevas.length, CFG.maxAlertasPorCiclo);
  if (resto > 0) await telegram(`…y ${resto} señal(es) más bajo el tope por ciclo (suben la próxima si siguen vivas).`);
  for (const s of ventanas) await telegram(msjSenal(s, 'ventana'));
  if (muertas.length) await telegram('✕ Ajustadas por Betano (ya no valen): ' +
    muertas.map(s => `${escHtml(s.partido)} · ${escHtml(s.lado)}`).join(' — '));
  EST.stats = { ...EST.stats, ultimo: new Date().toISOString(), requests: REQ, candidatas, vivas: Object.keys(EST.senales).length, nuevas: nuevas.length, ventanas: ventanas.length };
  fs.writeFileSync(ESTADO_PATH, JSON.stringify(EST));
  console.log(`Ciclo OK · ${REQ} requests · ${candidatas} líneas evaluadas · ${nuevas.length} nuevas · ${ventanas.length} ventanas · ${Object.keys(EST.senales).length} vivas`);
} catch (err) {
  fs.writeFileSync(ESTADO_PATH, JSON.stringify(EST));   /* lo avanzado no se pierde */
  console.error('Ciclo con error tras ' + REQ + ' requests:', err.message);
  process.exit(1);
}
