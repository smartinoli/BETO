#!/usr/bin/env node
/* ============================================================
   ITF-NAVEGADOR — saca del WAF lo que el fetch pelado no puede.

   GetCalendar y GetAcceptanceList están tras Incapsula: desde IP de
   datacenter exigen resolver el desafío JS. Este script levanta un
   Chromium real (Playwright), carga UNA página del sitio para ganarse
   las cookies, y desde adentro (fetch same-origin) baja los endpoints
   protegidos a ritmo humano.

   La acceptance list es la joya: entry list original con ranking
   ATP/WTA, ITF, nacional y WTN de cada inscrito, separada en
   MDA (main draw) / Q (qualis) / A (alternates) / W (retiros CON FECHA).
   Es la historia de "qué cambió" antes del torneo.

   Requiere playwright (npm i playwright) — dependencia OPCIONAL, solo
   para este script; el scraper base (itf.mjs) sigue sin dependencias.
   Config por entorno:
     ITF_CHROME      ruta del binario de Chromium (def: el de Playwright)
     HTTPS_PROXY     si está, se pasa al navegador (con certificados laxos)

   OJO — medido el 2026-08-20: cuando un torneo TERMINA, la API devuelve
   [] para su acceptance list (ITF la borra). Solo existe para torneos en
   curso o futuros: hay que cosecharla cada semana y archivarla acá para
   construir la historia. Los retiros de torneos ya jugados solo quedan
   como huella en el cuadro (LL, walkovers, alternates).

   Uso:
     node vigia/itf-navegador.mjs calendario [MT|WT] [desde] [hasta]
     node vigia/itf-navegador.mjs aceptacion <claves…>
     node vigia/itf-navegador.mjs cosecha         aceptación de TODO torneo
                                                  del caché aún no terminado
     node vigia/itf-navegador.mjs cuadros [N]     cuadros de los últimos N
                                                  terminados (def 20) — misma
                                                  salida que itf-cosecha, pero
                                                  por navegador (útil si el WAF
                                                  tiene marcada la IP)
     node vigia/itf-navegador.mjs liquidar        liquida el tablero de vigía
                                                  (itf.json) por cuadro oficial
                                                  usando el navegador como
                                                  transporte
   ============================================================ */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizarEventos, normalizarCuadro } from './itf.mjs';
import { liquidarConItf, resumenEntradas } from './itf-cruce.mjs';

const DIR = path.dirname(fileURLToPath(import.meta.url));
export const DATOS = path.join(DIR, 'datos', 'itf');
export const CACHE_CALENDARIO = path.join(DIR, 'itf-calendario.json');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

export const espera = ms => new Promise(r => setTimeout(r, ms));
export const pausaHumana = () => espera(2500 + Math.random() * 2500);

export async function abrirNavegador() {
  let chromium;
  try { ({ chromium } = await import('playwright')); }
  catch { console.error('Falta playwright: npm i playwright (o NODE_PATH hacia donde esté)'); process.exit(1); }
  const proxy = process.env.HTTPS_PROXY;
  const browser = await chromium.launch({
    executablePath: process.env.ITF_CHROME || undefined,
    headless: true,
    proxy: proxy ? { server: proxy } : undefined,
    args: ['--no-sandbox', '--disable-blink-features=AutomationControlled',
      ...(proxy ? ['--ignore-certificate-errors', '--ssl-version-max=tls1.2'] : [])],
  });
  const ctx = await browser.newContext({ ignoreHTTPSErrors: !!proxy, userAgent: UA, locale: 'en-GB', viewport: { width: 1366, height: 900 } });
  return { browser, ctx };
}

/* Carga una página real para resolver el desafío y deja el tab listo
   para hacer fetch same-origin desde adentro. */
export async function calentar(ctx, url) {
  const page = await ctx.newPage();
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(6000);
  const titulo = await page.title();
  if (!titulo || /momento|robot|captcha/i.test(titulo)) console.error('⚠ posible desafío sin resolver (título: ' + JSON.stringify(titulo) + ')');
  return page;
}

export async function fetchDesdePagina(page, url) {
  const r = await page.evaluate(async u => {
    const res = await fetch(u, { headers: { Accept: 'application/json, text/plain, */*' } });
    return { status: res.status, texto: await res.text() };
  }, url);
  if (r.texto.trimStart().startsWith('<')) throw new Error('desafío WAF incluso dentro del navegador para ' + url);
  return JSON.parse(r.texto);
}

/* ---------- calendario ---------- */
export async function bajarCalendario(page, circuito, desde, hasta) {
  const u = 'https://www.itftennis.com/tennis/api/TournamentApi/GetCalendar?' + new URLSearchParams({
    circuitCode: circuito, searchString: '', skip: 0, take: 200,
    nationCodes: '', zoneCodes: '', dateFrom: desde, dateTo: hasta,
    indoorOutdoor: '', categories: '', isOrderAscending: true,
    orderField: 'startDate', surfaceCodes: '', singlesDrawFormat: '',
  });
  const crudo = await fetchDesdePagina(page, u);
  return (crudo.items || []).map(t => ({
    clave: (t.tournamentKey || '').toLowerCase(),
    nombre: t.name, promocional: t.promotionalName || null,
    categoria: t.category, bolsa: t.prizeMoney,
    superficie: t.surfaceDesc, techo: t.indoorOrOutDoor,
    pais: t.hostNation, sede: t.venue,
    desde: (t.startDate || '').slice(0, 10), hasta: (t.endDate || '').slice(0, 10),
    enlace: t.tournamentLink ? 'https://www.itftennis.com' + t.tournamentLink : null,
  }));
}

/* ---------- acceptance list ---------- */
const numero = s => { const n = parseInt(String(s ?? '').replace(/[^\d]/g, ''), 10); return isNaN(n) ? null : n; };

export function normalizarAceptacion(crudo, clave) {
  const bloque = Array.isArray(crudo) ? crudo[0] : crudo;
  const out = { clave, bajado: new Date().toISOString(), secciones: {} };
  for (const ec of bloque?.entryClassifications || []) {
    const cod = ec.entryClassificationCode;
    out.secciones[cod] = (ec.entries || []).map(e => {
      const p = (e.players || [])[0] || {};
      return {
        pos: numero(e.positionDisplay),
        id: p.playerId ?? null,
        nombre: [p.givenName, p.familyName].filter(Boolean).join(' '),
        pais: p.nationalityCode || null,
        atp: numero(p.atpWtaRank),
        itf: numero(p.itfWorldTennisRanking),
        nacional: numero(p.nationalRanking),
        wtn: p.worldRating ? +p.worldRating : null,
        /* shouldDisplayWtn=false → la web tapa el numero con la insignia
           "ProZone" (descubierto 2026-08-22, Bastad: Slavic y Couto la
           llevan y la API igual trae 8.58/8.99). Se guarda como señal de
           rating de baja confianza; snapshots viejos no tienen el campo. */
        wtnVisible: p.shouldDisplayWtn !== false,
        nacido: p.birthYear || null,
        /* En W viene "W 25 Jul 2026": la fecha del retiro. */
        info: e.information || null,
      };
    });
  }
  return out;
}

export async function bajarAceptacion(page, clave) {
  const circuito = clave.startsWith('w') ? 'WT' : 'MT';
  const u = `https://www.itftennis.com/tennis/api/TournamentApi/GetAcceptanceList?tournamentKey=${clave}&circuitCode=${circuito}&matchTypeCode=S`;
  return normalizarAceptacion(await fetchDesdePagina(page, u), clave);
}


/* ---------- cosecha de UN torneo: order of play + cuadros ----------
   Navega DIRECTO a la página del torneo (nunca pasar antes por el
   calendario: marca la sesión y el WAF bloquea, medido 2026-08-21).
   Reutilizable desde el CLI (comando oop) y desde itf-scrap.mjs. */
export async function cosecharTorneo(page, t, hoy = new Date().toISOString().slice(0, 10)) {
  const api = 'https://www.itftennis.com/tennis/api/TournamentApi/';
  const OOP = path.join(DATOS, 'oop');
  fs.mkdirSync(OOP, { recursive: true });
  fs.mkdirSync(path.join(DATOS, 'vivo'), { recursive: true });
  const capt = new Map();
  const oyente = async r => {
    if (!/TournamentApi\/Get/i.test(r.url())) return;
    try { capt.set(r.url(), await r.text()) } catch {}
  };
  page.on('response', oyente);
  try {
    await page.goto(t.enlace + 'order-of-play/', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(6000);
    const parse = s => { try { return JSON.parse(s) } catch { return null } };
    let dias = null;
    for (const [u, cuerpo] of capt) if (/GetOrderOfPlayDays/i.test(u)) dias = parse(cuerpo);
    if (!Array.isArray(dias)) throw new Error('sin días de order of play');
    const futuros = dias.filter(d => (d.playDate || '').slice(0, 10) >= hoy);
    for (const d of futuros) {
      const url = `${api}GetOrderOfPlay?orderOfPlayDayId=${d.orderOfPlayDayId}`;
      let crudo = null;
      for (const [u, cuerpo] of capt) if (u.includes('orderOfPlayDayId=' + d.orderOfPlayDayId)) crudo = parse(cuerpo);
      if (!crudo) { await pausaHumana(); crudo = await fetchDesdePagina(page, url); }
      const partidos = [];
      for (const cancha of (Array.isArray(crudo) ? crudo : [])) {
        let orden = 0;
        for (const m of cancha.matches || []) {
          orden++;
          partidos.push({
            matchId: m.matchId, cancha: cancha.courtName || '', orden,
            horario: m.schedule || '', evento: m.eventClassificationCode || '',
            eventoDesc: m.eventDesc || '', tipo: m.matchDescription || '',
            ronda: m.roundGroupDesc || '',
            estado: m.playStatusCode === 'PC' ? 'jugado' : m.playStatusCode === 'TP' ? 'pendiente' : (m.playStatusDesc || '?'),
            nota: m.resultStatusDesc || null,
            lados: (m.teams || []).map(eq => {
              const j = (eq.players || []).filter(Boolean).map(x => ({
                id: x.playerId, nombre: [x.givenName, x.familyName].filter(Boolean).join(' '), pais: x.nationality,
              }));
              return { jugadores: j, nombre: j.map(x => x.nombre).join(' / ') || null, seed: eq.seeding ?? null, entrada: eq.entryStatus || null, ganador: !!eq.isWinner, sets: [] };
            }),
          });
        }
      }
      const fecha = (d.playDate || '').slice(0, 10);
      fs.writeFileSync(path.join(OOP, `${t.clave}-${fecha}.json`),
        JSON.stringify({ clave: t.clave, fecha, fechaTxt: d.playDateString || '', bajado: new Date().toISOString(), partidos }));
      console.log(`  ✓ oop ${t.clave} ${fecha}: ${partidos.length} partidos`);
    }
    await pausaHumana();
    const ev = normalizarEventos(await fetchDesdePagina(page, `${api}GetEventFilters?tournamentKey=${t.clave}`), t.clave);
    const cuadros = {};
    for (const c of ev.cuadros.filter(c => c.tipo === 'S')) {
      await pausaHumana();
      cuadros[c.evento] = normalizarCuadro(await fetchDesdePagina(page,
        `${api}GetDrawsheet?eventClassificationCode=${c.evento}&matchTypeCode=S&tourType=${ev.tourType}&tournamentId=${ev.tournamentId}&weekNumber=0`));
    }
    fs.writeFileSync(path.join(DATOS, 'vivo', t.clave + '.json'),
      JSON.stringify({ clave: t.clave, bajado: new Date().toISOString(), cuadros }));
    console.log(`  ✓ cuadro ${t.clave}`);
    return { dias: futuros.length };
  } finally { page.off('response', oyente); }
}

/* ---------- CLI ---------- */
const esCli = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
const [cmd, ...args] = esCli ? process.argv.slice(2) : [null];
if (esCli && !cmd) {
  console.log('Uso: node vigia/itf-navegador.mjs calendario [MT|WT] [desde] [hasta] | aceptacion <claves…> | cosecha [N]');
  process.exit(0);
}

const { browser, ctx } = esCli ? await abrirNavegador() : {};
if (esCli)
try {
  /* 'oop' navega directo a cada torneo: pasar antes por el calendario marca
     la sesión y despues Incapsula bloquea las llamadas API de las páginas de
     torneo (medido 2026-08-21). Los demás comandos sí necesitan esa página. */
  const page = cmd === 'oop'
    ? await ctx.newPage()
    : await calentar(ctx, 'https://www.itftennis.com/en/tournament-calendar/mens-world-tennis-tour-calendar/');

  if (cmd === 'calendario') {
    /* Ambos circuitos (MT hombres, WT mujeres) en un solo caché: el cruce
       con las cuotas necesita resolver ciudades sin saber el género. */
    const [circuitos0 = 'MT,WT', desde0, hasta0] = args;
    const hoy = new Date();
    const desde = desde0 || new Date(hoy.getTime() - 28 * 864e5).toISOString().slice(0, 10);
    const hasta = hasta0 || new Date(hoy.getTime() + 14 * 864e5).toISOString().slice(0, 10);
    const torneos = [];
    for (const circuito of circuitos0.toUpperCase().split(',')) {
      await pausaHumana();
      torneos.push(...await bajarCalendario(page, circuito, desde, hasta));
      console.log(`  ${circuito}: acumulados ${torneos.length}`);
    }
    fs.writeFileSync(CACHE_CALENDARIO, JSON.stringify({ actualizado: new Date().toISOString(), nota: `${circuitos0} ${desde} a ${hasta} vía navegador`, torneos }, null, 1));
    console.log(`✓ ${torneos.length} torneos → vigia/itf-calendario.json`);
  } else if (cmd === 'aceptacion' || cmd === 'cosecha') {
    fs.mkdirSync(DATOS, { recursive: true });
    let claves;
    if (cmd === 'aceptacion') claves = args.map(c => c.toLowerCase());
    else {
      /* Todo torneo aún no terminado: es la última chance de fotografiar
         su entry list antes de que ITF la borre. */
      const hoy = new Date().toISOString().slice(0, 10);
      const cache = JSON.parse(fs.readFileSync(CACHE_CALENDARIO, 'utf8'));
      claves = cache.torneos.filter(t => t.hasta >= hoy).sort((a, b) => a.desde.localeCompare(b.desde)).map(t => t.clave);
    }
    console.log(`Bajando acceptance list de ${claves.length} torneos…`);
    for (const clave of claves) {
      const destino = path.join(DATOS, clave + '.aceptacion.json');
      if (fs.existsSync(destino)) { console.log(`  = ${clave} ya estaba`); continue; }
      await pausaHumana();
      try {
        const a = await bajarAceptacion(page, clave);
        if (!Object.keys(a.secciones).length) { console.log(`  ∅ ${clave}: lista vacía (torneo terminado — ITF la borra)`); continue; }
        fs.writeFileSync(destino, JSON.stringify(a));
        const n = Object.fromEntries(Object.entries(a.secciones).map(([k, v]) => [k, v.length]));
        console.log(`  ✓ ${clave}  MDA:${n.MDA ?? 0} Q:${n.Q ?? 0} A:${n.A ?? 0} W:${n.W ?? 0}`);
      } catch (e) { console.log(`  ✗ ${clave}: ${e.message.split('\n')[0]}`); }
    }
  } else if (cmd === 'cuadros') {
    fs.mkdirSync(DATOS, { recursive: true });
    const n = +args[0] || 20;
    const hoy = new Date().toISOString().slice(0, 10);
    const cache = JSON.parse(fs.readFileSync(CACHE_CALENDARIO, 'utf8'));
    const lista = cache.torneos.filter(t => t.hasta < hoy).sort((a, b) => b.hasta.localeCompare(a.hasta)).slice(0, n);
    console.log(`Bajando cuadros de ${lista.length} torneos terminados…`);
    const api = 'https://www.itftennis.com/tennis/api/TournamentApi/';
    for (const t of lista) {
      const destino = path.join(DATOS, t.clave + '.json');
      if (fs.existsSync(destino)) { console.log(`  = ${t.clave} ya estaba`); continue; }
      try {
        await pausaHumana();
        const ev = normalizarEventos(await fetchDesdePagina(page, `${api}GetEventFilters?tournamentKey=${t.clave}`), t.clave);
        const out = { clave: ev.clave, tournamentId: ev.tournamentId, ...t, cuadros: {} };
        for (const c of ev.cuadros.filter(c => c.tipo === 'S')) {
          await pausaHumana();
          out.cuadros[c.evento] = normalizarCuadro(await fetchDesdePagina(page,
            `${api}GetDrawsheet?eventClassificationCode=${c.evento}&matchTypeCode=S&tourType=${ev.tourType}&tournamentId=${ev.tournamentId}&weekNumber=0`));
        }
        fs.writeFileSync(destino, JSON.stringify(out));
        const nM = (out.cuadros.M?.rondas || []).reduce((s, r) => s + r.partidos.filter(p => p.estado === 'jugado').length, 0);
        const nQ = (out.cuadros.Q?.rondas || []).reduce((s, r) => s + r.partidos.filter(p => p.estado === 'jugado').length, 0);
        console.log(`  ✓ ${t.clave}  ${t.nombre || ''}  main:${nM} qualis:${nQ}`);
      } catch (e) { console.log(`  ✗ ${t.clave}: ${e.message.split('\n')[0]}`); }
    }
  } else if (cmd === 'oop') {
    /* Programación + cuadro de cada torneo en juego, para la mesa.
       CLAVE (medido 2026-08-21): Incapsula bloquea el fetch a la API si la
       página abierta no es la del propio torneo, pero NAVEGAR a la página
       del torneo pasa siempre, y desde ahí los fetch al mismo torneo también.
       Por eso: un goto por torneo y todo lo demás desde adentro. */
    const OOP = path.join(DATOS, 'oop');
    fs.mkdirSync(OOP, { recursive: true });
    fs.mkdirSync(path.join(DATOS, 'vivo'), { recursive: true });
    const hoy = new Date().toISOString().slice(0, 10);
    const cache = JSON.parse(fs.readFileSync(CACHE_CALENDARIO, 'utf8'));
    const activos = cache.torneos.filter(t => t.desde <= hoy && t.hasta >= hoy && t.enlace);
    const api = 'https://www.itftennis.com/tennis/api/TournamentApi/';
    console.log(`Programación de ${activos.length} torneos en juego…`);
    let ok = 0, mal = 0;
    for (const t of activos) {
      try { await cosecharTorneo(page, t, hoy); ok++; }
      catch (e) { console.log(`  ✗ ${t.clave}: ${e.message.split(' para ')[0].split('\n')[0]}`); mal++; }
    }
    console.log(`Listo: ${ok} torneos completos, ${mal} fallidos.`);
  } else if (cmd === 'liquidar') {
    const ITF_PATH = path.join(DIR, 'itf.json');
    const db = JSON.parse(fs.readFileSync(ITF_PATH, 'utf8'));
    const api = 'https://www.itftennis.com/tennis/api/TournamentApi/';
    const obtenerCuadros = async clave => {
      await pausaHumana();
      const ev = normalizarEventos(await fetchDesdePagina(page, `${api}GetEventFilters?tournamentKey=${clave}`), clave);
      const out = {};
      for (const c of ev.cuadros.filter(c => c.tipo === 'S')) {
        await pausaHumana();
        out[c.evento] = normalizarCuadro(await fetchDesdePagina(page,
          `${api}GetDrawsheet?eventClassificationCode=${c.evento}&matchTypeCode=S&tourType=${ev.tourType}&tournamentId=${ev.tournamentId}&weekNumber=0`));
      }
      return out;
    };
    const r = await liquidarConItf(db, { maxTorneos: 30, log: console.log, obtenerCuadros });
    fs.writeFileSync(ITF_PATH, JSON.stringify(db));
    console.log(`✓ ${r.liquidados} liquidados por cuadro, ${r.anotados} anotados`);
    for (const f of resumenEntradas(db)) console.log('  ' + f);
  }
} finally { await browser.close(); }
