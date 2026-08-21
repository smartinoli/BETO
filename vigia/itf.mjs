#!/usr/bin/env node
/* ============================================================
   ITF — scraper de itftennis.com (World Tennis Tour M15/M25/W15…).

   Hallazgos del reconocimiento (2026-08-20):
   - El sitio entero va detrás de Incapsula (Imperva), PERO dos endpoints
     de la API JSON quedan FUERA del WAF y responden a un fetch pelado,
     sin cookies ni navegador, incluso desde IPs de datacenter:
       · GetEventFilters?tournamentKey=…   → tournamentId + cuadros disponibles
       · GetDrawsheet?tournamentId=…       → cuadro completo con resultados
   - GetCalendar (la lista de torneos por fecha, con prize money) SÍ está
     protegido: desde IP residencial suele pasar, desde datacenter devuelve
     el desafío JS/captcha. Por eso `calendario` intenta directo y, si el
     WAF lo corta, cae al caché local `itf-calendario.json` (refrescable
     desde cualquier navegador de escritorio, ver ayuda del CLI).

   Qué expone el cuadro por partido: jugadores (nombre, país, id), seed,
   estado de entrada (DA directo / Q qualifier / LL lucky loser / WC wild
   card / SE special exempt / A alternate), sets y ganador, y si el partido
   está pendiente o jugado. NO trae horarios ni order of play.

   Sin dependencias: Node 20+ (fetch nativo).

   CLI:
     node vigia/itf.mjs calendario [MT|WT] [desde] [hasta]
     node vigia/itf.mjs torneo <clave|url>
     node vigia/itf.mjs cuadro <clave|url> [M|Q] [S|D]
     node vigia/itf.mjs qualis <clave|url>
   ============================================================ */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const CACHE_CALENDARIO = path.join(DIR, 'itf-calendario.json');
const BASE = 'https://www.itftennis.com/tennis/api/TournamentApi/';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const espera = ms => new Promise(r => setTimeout(r, ms));

export class ErrorWaf extends Error {
  constructor(ruta) {
    super(`Incapsula bloqueó ${ruta}: la respuesta fue HTML de desafío, no JSON`);
    this.waf = true;
  }
}

/* Pacing: Incapsula tolera los endpoints abiertos a ritmo humano, pero una
   ráfaga seguida (medido: ~5 requests en 3 s) dispara el desafío. Un request
   cada COOLDOWN ms (± jitter para no parecer reloj), y ante desafío se
   espera largo y se reintenta. Para barridos largos (cosecha) conviene
   subirlo: ITF_COOLDOWN=4000. */
const COOLDOWN = +(process.env.ITF_COOLDOWN || 1500);
let ULTIMO = 0;
async function apiItf(ruta, params = {}) {
  const u = new URL(BASE + ruta);
  Object.entries(params).forEach(([k, v]) => u.searchParams.set(k, v ?? ''));
  for (let intento = 0; ; intento++) {
    const falta = ULTIMO + COOLDOWN * (0.75 + Math.random() * 0.5) - Date.now();
    if (falta > 0) await espera(falta);
    ULTIMO = Date.now();
    let r = null, errRed = null;
    try {
      r = await fetch(u, {
        signal: AbortSignal.timeout(20000),
        headers: { 'User-Agent': UA, 'Accept': 'application/json, text/plain, */*' },
      });
    } catch (e) { errRed = e; }
    if ((errRed || r.status >= 500 || r.status === 429) && intento < 3) { await espera(1000 * 2 ** intento); continue; }
    if (errRed) throw new Error('red: ' + errRed.message);
    const texto = await r.text();
    if (texto.trimStart().startsWith('<')) {
      /* GetCalendar está SIEMPRE tras el WAF desde datacenter: no insistir.
         Los endpoints abiertos pueden caer en desafío transitorio por ritmo:
         esperar largo y reintentar un par de veces. */
      if (ruta === 'GetCalendar' || intento >= 2) throw new ErrorWaf(ruta);
      await espera(8000 * (intento + 1));
      continue;
    }
    if (!r.ok) throw new Error(`HTTP ${r.status} en ${ruta}`);
    return JSON.parse(texto);
  }
}

/* La clave de torneo viaja en la URL pública: .../m15-lambermont/bel/2026/m-itf-bel-2026-004/... */
export function parseClave(s) {
  const m = String(s).match(/[mw]-itf-[a-z]{3}-\d{4}-\d+/i);
  if (!m) throw new Error(`No encuentro una clave de torneo (tipo m-itf-bel-2026-004) en: ${s}`);
  return m[0].toLowerCase();
}

/* ---------- Calendario (protegido por el WAF) ---------- */
export async function calendario({ circuito = 'MT', desde, hasta, take = 100 } = {}) {
  const hoy = new Date().toISOString().slice(0, 10);
  desde = desde || hoy;
  hasta = hasta || new Date(Date.now() + 7 * 864e5).toISOString().slice(0, 10);
  const crudo = await apiItf('GetCalendar', {
    circuitCode: circuito, searchString: '', skip: 0, take,
    nationCodes: '', zoneCodes: '', dateFrom: desde, dateTo: hasta,
    indoorOutdoor: '', categories: '', isOrderAscending: true,
    orderField: 'startDate', surfaceCodes: '', singlesDrawFormat: '',
  });
  return (crudo.items || []).map(t => ({
    clave: (t.tournamentKey || '').toLowerCase(),
    nombre: t.name,
    promocional: t.promotionalName || null,
    categoria: t.category,            /* M15, M25, W15… */
    bolsa: t.prizeMoney,              /* "$15,000" */
    superficie: t.surfaceDesc,
    techo: t.indoorOrOutDoor,
    pais: t.hostNation,
    sede: t.venue,
    desde: (t.startDate || '').slice(0, 10),
    hasta: (t.endDate || '').slice(0, 10),
    enlace: t.tournamentLink ? 'https://www.itftennis.com' + t.tournamentLink : null,
  }));
}

/* Igual que `calendario`, pero si el WAF corta usa el caché local,
   filtrado al rango de fechas pedido (torneos que se solapan con él). */
export async function calendarioConCache(opts = {}) {
  const hoy = new Date().toISOString().slice(0, 10);
  const desde = opts.desde || hoy;
  const hasta = opts.hasta || new Date(Date.now() + 7 * 864e5).toISOString().slice(0, 10);
  try {
    const lista = await calendario({ ...opts, desde, hasta });
    fs.writeFileSync(CACHE_CALENDARIO, JSON.stringify({ actualizado: new Date().toISOString(), torneos: lista }, null, 1));
    return { torneos: lista, origen: 'api' };
  } catch (e) {
    if (!e.waf) throw e;
    let cache = null;
    try { cache = JSON.parse(fs.readFileSync(CACHE_CALENDARIO, 'utf8')) } catch {}
    if (!cache) throw e;
    const torneos = cache.torneos.filter(t => t.desde <= hasta && t.hasta >= desde);
    return { torneos, origen: 'cache (' + cache.actualizado.slice(0, 10) + ')' };
  }
}

/* ---------- Eventos de un torneo (endpoint abierto) ---------- */
export function normalizarEventos(crudo, clave) {
  const cuadros = [];
  for (const f of crudo.filters || []) {
    for (const sf of f.subFilter || []) {
      cuadros.push({ tipo: f.valueCode, tipoDesc: f.valueDesc, evento: sf.valueCode, eventoDesc: sf.valueDesc });
    }
  }
  return { clave, tournamentId: crudo.tournamentId, tourType: crudo.tourType || 'N', circuito: crudo.circuitCode, cuadros };
}

export async function eventos(claveOUrl) {
  const clave = parseClave(claveOUrl);
  return normalizarEventos(await apiItf('GetEventFilters', { tournamentKey: clave }), clave);
}

/* ---------- Cuadro con resultados (endpoint abierto) ---------- */
const ENTRADAS = { DA: 'directo', Q: 'qualifier', LL: 'lucky loser', WC: 'wild card', SE: 'special exempt', A: 'alternate', JE: 'junior exempt', ITF: 'plaza ITF' };

function ladoDe(t) {
  const j = (t.players || []).filter(Boolean).map(p => ({
    id: p.playerId,
    nombre: [p.givenName, p.familyName].filter(Boolean).join(' '),
    pais: p.nationality,
  }));
  return {
    jugadores: j,
    nombre: j.map(x => x.nombre).join(' / ') || null,   /* null = hueco (bye/por definir) */
    seed: t.seeding ?? null,
    entrada: t.entryStatus || null,
    entradaDesc: ENTRADAS[t.entryStatus] || t.entryStatus || null,
    ganador: !!t.isWinner,
    sets: (t.scores || []).filter(Boolean).map(s => s.losingScore != null ? `${s.score}(${s.losingScore})` : String(s.score)),
  };
}

export function normalizarCuadro(crudo) {
  const rondas = [];
  for (const g of crudo.koGroups || []) {
    for (const r of g.rounds || []) {
      rondas.push({
        numero: r.roundNumber,
        nombre: r.roundDesc || `Ronda ${r.roundNumber}`,
        partidos: (r.matches || []).map(m => ({
          matchId: m.matchId,
          /* 'To be played' = programado con rivales; 'Not played' = hueco/bye */
          estado: m.playStatusCode === 'PC' ? 'jugado'
            : m.playStatusDesc === 'To be played' ? 'pendiente'
            : m.playStatusDesc === 'Not played' ? 'hueco'
            : (m.playStatusDesc || 'desconocido'),
          nota: m.resultStatusDesc || null,   /* walkover, retired… */
          lados: (m.teams || []).map(ladoDe),
        })),
      });
    }
  }
  return { eventId: crudo.eventId, estructura: crudo.drawsheetStructure, rondas };
}

export async function cuadro({ tournamentId, tourType = 'N', evento = 'M', tipo = 'S', semana = 0 }) {
  return normalizarCuadro(await apiItf('GetDrawsheet', {
    eventClassificationCode: evento, matchTypeCode: tipo, tourType,
    tournamentId, weekNumber: semana,
  }));
}

/* ---------- Order of Play (endpoint abierto) ----------
   La programación real del día: cancha, orden en cancha y horario local.
   Más valioso que el cuadro para decidir: dice CUÁNDO y DÓNDE se juega,
   y trae matchId, que cruza sin ambigüedad con el cuadro. */
export async function diasOop(claveOUrl) {
  const clave = parseClave(claveOUrl);
  const crudo = await apiItf('GetOrderOfPlayDays', { tournamentKey: clave });
  return (Array.isArray(crudo) ? crudo : []).map(d => ({
    id: d.orderOfPlayDayId,
    fecha: (d.playDate || '').slice(0, 10),
    fechaTxt: d.playDateString || '',
  }));
}

export async function ordenDeJuego(dayId) {
  const crudo = await apiItf('GetOrderOfPlay', { orderOfPlayDayId: dayId });
  const out = [];
  for (const cancha of (Array.isArray(crudo) ? crudo : [])) {
    let orden = 0;
    for (const m of cancha.matches || []) {
      orden++;
      out.push({
        matchId: m.matchId,
        cancha: cancha.courtName || '',
        orden,                                   /* 1º, 2º… turno en esa cancha */
        horario: m.schedule || '',               /* "Starting at 10:00" | "Followed By" | "Not Before 14:00" */
        evento: m.eventClassificationCode || '', /* M main | Q quali */
        eventoDesc: m.eventDesc || '',           /* Men's Singles… */
        tipo: m.matchDescription || '',          /* MS | WS | MD… */
        ronda: m.roundGroupDesc || '',
        estado: m.playStatusCode === 'PC' ? 'jugado'
          : m.playStatusCode === 'TP' ? 'pendiente'
          : (m.playStatusDesc || 'desconocido'),
        nota: m.resultStatusDesc || null,
        lados: (m.teams || []).map(ladoDe),
      });
    }
  }
  return out;
}

/* Atajo: cuadro a partir de la clave/URL pública. */
export async function cuadroDe(claveOUrl, evento = 'M', tipo = 'S') {
  const ev = await eventos(claveOUrl);
  const hay = ev.cuadros.some(c => c.evento === evento && c.tipo === tipo);
  if (!hay) throw new Error(`El torneo ${ev.clave} no tiene cuadro ${evento}/${tipo} (tiene: ${ev.cuadros.map(c => c.evento + '/' + c.tipo).join(', ')})`);
  return { ...await cuadro({ tournamentId: ev.tournamentId, tourType: ev.tourType, evento, tipo }), torneo: ev };
}

/* ============================ CLI ============================ */
function pintarCuadro(c, titulo) {
  console.log(`\n=== ${titulo} (evento ${c.eventId}, ${c.estructura}) ===`);
  for (const r of c.rondas) {
    const jugados = r.partidos.filter(p => p.estado === 'jugado').length;
    const pendientes = r.partidos.filter(p => p.estado === 'pendiente').length;
    console.log(`\n${r.nombre}: ${r.partidos.length} partidos (${jugados} jugados, ${pendientes} pendientes)`);
    for (const p of r.partidos) {
      const lado = l => {
        if (!l || !l.nombre) return '—';
        const extras = [l.seed ? `[${l.seed}]` : '', l.entrada && l.entrada !== 'DA' ? `(${l.entrada})` : ''].filter(Boolean).join('');
        return `${l.nombre} ${l.pais ? '(' + l.jugadores.map(x => x.pais).join('/') + ')' : ''}${extras}`.trim();
      };
      const [a, b] = p.lados;
      if (p.estado === 'hueco') continue;   /* byes y llaves sin definir no aportan */
      const marcador = p.estado === 'jugado'
        ? ' → ' + (a?.ganador ? lado(a) : lado(b)).split(' (')[0] + ' ' + (a?.ganador ? a : b).sets.join(' ') + (p.nota ? ` (${p.nota})` : '')
        : (p.estado === 'pendiente' ? '  [pendiente]' : `  [${p.estado}]`);
      console.log(`  ${lado(a)}  vs  ${lado(b)}${marcador}`);
    }
  }
}

const esCli = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (esCli) {
  const [cmd, ...args] = process.argv.slice(2);
  try {
    if (cmd === 'calendario') {
      const [circuito = 'MT', desde, hasta] = args;
      const { torneos, origen } = await calendarioConCache({ circuito, desde, hasta });
      console.log(`Calendario ${circuito} (origen: ${origen}) — ${torneos.length} torneos`);
      for (const t of torneos) {
        console.log(` ${t.desde} → ${t.hasta}  ${t.categoria}  ${String(t.bolsa || '?').padEnd(8)} ${t.nombre} (${t.pais}, ${t.superficie})  ${t.clave}`);
      }
      if (origen !== 'api') console.log('\n⚠ La API del calendario está tras el WAF desde esta IP. Para refrescar el caché,\n  abre esta URL en un navegador normal y guarda el JSON como vigia/itf-calendario.json\n  (campo "torneos"), o corre este comando desde una IP residencial.');
    } else if (cmd === 'torneo') {
      const ev = await eventos(args[0]);
      console.log(`Torneo ${ev.clave} — tournamentId ${ev.tournamentId} (circuito ${ev.circuito})`);
      console.log('Cuadros:', ev.cuadros.map(c => `${c.eventoDesc} ${c.tipoDesc} (${c.evento}/${c.tipo})`).join(' · '));
      for (const c of ev.cuadros.filter(c => c.tipo === 'S')) {
        const cu = await cuadro({ tournamentId: ev.tournamentId, tourType: ev.tourType, evento: c.evento, tipo: c.tipo });
        const partidos = cu.rondas.flatMap(r => r.partidos);
        const pend = partidos.filter(p => p.estado === 'pendiente' && p.lados.every(l => l.nombre));
        console.log(`\n${c.eventoDesc} singles: ${cu.rondas.length} rondas, ${partidos.length} partidos, ${pend.length} pendientes con ambos jugadores definidos`);
        for (const r of cu.rondas) console.log(`  ${r.nombre}: ${r.partidos.filter(p => p.estado === 'jugado').length}/${r.partidos.length} jugados`);
      }
    } else if (cmd === 'cuadro' || cmd === 'qualis') {
      const evento = cmd === 'qualis' ? 'Q' : (args[1] || 'M').toUpperCase();
      const tipo = cmd === 'qualis' ? 'S' : (args[2] || 'S').toUpperCase();
      const c = await cuadroDe(args[0], evento, tipo);
      pintarCuadro(c, `${c.torneo.clave} ${evento === 'Q' ? 'Qualifying' : 'Main Draw'} ${tipo === 'S' ? 'singles' : 'dobles'}`);
    } else {
      console.log(`Uso:
  node vigia/itf.mjs calendario [MT|WT] [desde] [hasta]   lista de torneos con prize money (WAF: usa caché si lo cortan)
  node vigia/itf.mjs torneo <clave|url>                   resumen de cuadros de un torneo
  node vigia/itf.mjs cuadro <clave|url> [M|Q] [S|D]       cuadro completo con resultados
  node vigia/itf.mjs qualis <clave|url>                   atajo: cuadro Q singles

La clave sale de la URL pública del torneo, p. ej. m-itf-bel-2026-004 en
https://www.itftennis.com/en/tournament/m15-lambermont/bel/2026/m-itf-bel-2026-004/`);
    }
  } catch (e) {
    console.error('✗ ' + e.message);
    process.exit(1);
  }
}
