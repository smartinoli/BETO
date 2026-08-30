#!/usr/bin/env node
/* ============================================================
   ITF-HISTORICO — la línea de tiempo de precios de cada partido.

   POR QUÉ. Es el cuello de botella de todo el sistema ITF: hay 1252
   partidos con resultado y 52 con precio. Toda pregunta que importa
   —¿le ganamos al mercado?, ¿la contra sirve?— es "precio contra
   realidad", y se está contestando con el 4% de los datos. La regla de
   LA CONTRA se apoya en 19 partidos y su intervalo va de 41% a 81%.

   QUÉ SE APRENDIÓ PROBANDO CONTRA LA API (2026-08-26). La documentación
   pública miente en dos cosas y las dos costaron requests:

     · la ruta NO es /fixtures/odds/historical (404) sino
       /v4/historical-odds?fixtureId=…&bookmaker=…
     · /fixtures NO toma startTimeFrom/startTimeTo en epoch (400 MISSING
       PARAMETERS) sino from/to en ISO, como ya hacía vigia.mjs

   Y LA MALA: NO SE PUEDE RECONSTRUIR EL PASADO. El índice /fixtures
   purga los partidos viejos QUE TENÍAN CUOTAS. A 2 y 10 días atrás
   quedan 5 o 6 partidos de tenis y todos con hasOdds=false (UTR, algún
   ATP suelto); ITF, cero. A 45 días, FIXTURE_NOT_FOUND. Sin fixtureId no
   hay a qué apuntarle el histórico, así que el archivo hacia atrás no
   existe para nosotros.

   LO QUE SÍ SE PUEDE, Y ES MUCHO. Hoy hay 329 partidos de ITF singles
   con cuotas en la ventana viva. Capturando los fixtureId cada día y
   pidiendo su historia, en un mes tenemos ~9.000 partidos con precio de
   APERTURA, cada movimiento intermedio y el de cierre. Eso es más de lo
   que necesitamos para cerrar todos los intervalos abiertos, y trae algo
   que hoy no tenemos: el MOVIMIENTO DE LA LÍNEA. Un partido que abre 2.62
   y cierra 3.00 dice que el mercado aprendió algo en el medio; llegar
   antes que eso es la forma clásica de ganarle.

   PRESUPUESTO. El plan dev trae 100.000 requests al mes y van 36.128
   usados. Una llamada por partido: 330 al día son ~10.000 al mes, o sea
   cabe con holgura. El pacing va en 3 s porque a 1,2 s la API devuelve
   RATE_LIMITED.

   Uso:
     ODDSPAPI_KEY=... node vigia/itf-historico.mjs --capturar
         guarda el índice de ITF de la ventana viva (1-2 requests)
     ODDSPAPI_KEY=... node vigia/itf-historico.mjs --historia --max 200
         baja la línea de tiempo de los capturados que falten
     node vigia/itf-historico.mjs --resumen
         sin key ni requests: arma itf-cuotas-historicas.json
   ============================================================ */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const DATOS = path.join(DIR, 'datos', 'itf');
const CACHE = path.join(DATOS, 'historico');
const INDICE = path.join(DATOS, 'historico-indice.json');
const SALIDA = path.join(DIR, 'itf-cuotas-historicas.json');
const KEY = process.env.ODDSPAPI_KEY;

const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i > 0 ? process.argv[i + 1] : d };
const flag = n => process.argv.includes('--' + n);
const MAX = +arg('max', 200);
/* DOS CASAS, y cada una por una razon distinta.

   bet365 es la VARA. Es el libro mas afilado y liquido del circuito, asi
   que su precio es la mejor estimacion disponible de la probabilidad
   real. Para preguntar "¿le ganamos al mercado?" hay que preguntarselo al
   mejor mercado, no al que usamos para apostar.

   betano es DONDE SE APUESTA. Sebastian juega ahi, asi que el precio que
   importa para la cuenta final es el suyo.

   Y de tener las dos sale lo que puede valer mas que todo el modelo: la
   BRECHA. Si bet365 pone 1.55 a un jugador y Betano paga 1.75, eso es
   ventaja sin depender de que nuestra estimacion tenga razon — es el
   libro afilado diciendo que el blando se equivoco. Es la forma mas
   confiable de ganar que existe, y no la podiamos ni mirar hasta ahora.

   Sebastian ya habia notado que por la API a Betano le faltaban lineas
   que el si veia en la web. Bajando las dos, eso deja de ser una duda y
   pasa a ser un numero medido: cuantas trae cada una. */
const CASAS = arg('casas', 'bet365,betano').split(',').map(x => x.trim()).filter(Boolean);
const CASA = CASAS[0];
const SPORT_TENIS = 12;
const PAUSA = +arg('pausa', 3000);   /* a 1,2 s la API tira RATE_LIMITED */

const ES_ITF = t => /\bitf\b|\bm15\b|\bm25\b|\bw15\b|\bw25\b|\bw35\b|\bw50\b|\bw75\b|\bw100\b/i.test(t || '');
const ES_DOBLES = (a, b) => /\//.test(a || '') || /\//.test(b || '');

let REQ = 0, ULTIMO = 0;
const espera = ms => new Promise(r => setTimeout(r, ms));
async function api(ruta, params = {}, pausa = PAUSA) {
  if (!KEY) throw new Error('falta ODDSPAPI_KEY');
  const u = new URL('https://api.oddspapi.io/v4/' + ruta);
  Object.entries({ ...params, apiKey: KEY }).forEach(([k, v]) => u.searchParams.set(k, v));
  for (let intento = 0; ; intento++) {
    const falta = ULTIMO + pausa - Date.now();
    if (falta > 0) await espera(falta);
    ULTIMO = Date.now();
    let r = null, errRed = null;
    try { r = await fetch(u, { signal: AbortSignal.timeout(30000), headers: { 'User-Agent': 'vigia/2.0' } }) }
    catch (e) { errRed = e }
    if ((errRed || r.status === 429 || r.status >= 500) && intento < 4) { await espera(2500 * 2 ** intento); continue }
    if (errRed) throw new Error('red: ' + errRed.message);
    const cuerpo = await r.json().catch(() => null);
    if (cuerpo?.error) { const e = new Error(`${cuerpo.error.code || ''} ${cuerpo.error.message || ''}`.trim()); e.api = cuerpo.error; throw e }
    if (!r.ok) throw new Error('HTTP ' + r.status);
    REQ++;
    return cuerpo;
  }
}
const lista = j => Array.isArray(j) ? j : (j?.data ?? []);
const dia = d => new Date(Date.now() - d * 864e5).toISOString().slice(0, 10);
const leer = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')) } catch { return null } };

/* ---------- 1. CAPTURAR: el índice de ITF de la ventana viva ----------
   Barato y hay que correrlo TODOS los días: lo que no se capture hoy se
   pierde, porque el índice purga los partidos con cuotas al poco tiempo.

   LA VENTANA VA A 7 DÍAS, no a 3 (medido el 2026-08-30). El feed publica
   y DESPUBLICA: el partido de mañana en Buzau estaba a las 19:10, no
   estaba a las 22:22 —la corrida del botón lo perdió— y volvió a las
   22:35. Como el índice solo suma (nunca borra), mirar más lejos hace
   que un fixture se guarde la primera vez que asoma, aunque después
   desaparezca del feed un rato. Cuesta el mismo request: 1. */
async function capturar() {
  fs.mkdirSync(DATOS, { recursive: true });
  const previo = leer(INDICE) || { partidos: {} };
  const antes = Object.keys(previo.partidos).length;
  const fx = lista(await api('fixtures', { sportId: SPORT_TENIS, from: dia(1), to: dia(-7) }, 1500));
  const itf = fx.filter(x => ES_ITF((x.tournamentName || '') + ' ' + (x.categoryName || ''))
    && !ES_DOBLES(x.participant1Name, x.participant2Name));
  for (const x of itf) {
    previo.partidos[x.fixtureId] = {
      fixtureId: x.fixtureId, startTime: x.startTime, statusId: x.statusId,
      torneo: x.tournamentName, categoria: x.categoryName ?? null,
      p1: x.participant1Name, p2: x.participant2Name,
      s1: x.participant1Score ?? null, s2: x.participant2Score ?? null,
      hasOdds: x.hasOdds, visto: new Date().toISOString(),
    };
  }
  previo.actualizado = new Date().toISOString();
  fs.writeFileSync(INDICE, JSON.stringify(previo, null, 1));
  const ahora = Object.keys(previo.partidos).length;
  console.log(`${fx.length} partidos de tenis en la ventana · ${itf.length} ITF singles`);
  console.log(`índice: ${antes} → ${ahora} (${ahora - antes} nuevos) · ${REQ} requests`);
  const sinHist = Object.keys(previo.partidos).filter(id => !fs.existsSync(path.join(CACHE, id + '.json')));
  console.log(`${sinHist.length} sin línea de tiempo todavía — corre --historia para bajarlas`);
}

/* ---------- 2. HISTORIA: la línea de tiempo de cada uno ---------- */
async function historia() {
  fs.mkdirSync(CACHE, { recursive: true });
  const idx = leer(INDICE);
  if (!idx) return console.log('no hay índice: corre --capturar primero');
  const todos = Object.values(idx.partidos);
  /* primero los que ya terminaron: su línea está completa y no va a cambiar */
  const pend = todos
    .filter(p => !fs.existsSync(path.join(CACHE, p.fixtureId + '.json')))
    .sort((a, b) => (b.statusId === 2 ? 1 : 0) - (a.statusId === 2 ? 1 : 0)
      || String(a.startTime).localeCompare(String(b.startTime)));
  console.log(`${todos.length} en el índice · ${pend.length} sin bajar · pido ${Math.min(pend.length, MAX)}`);
  console.log(`casas ${CASAS.join(' + ')} · pausa ${PAUSA} ms · ${CASAS.length} llamadas por partido\n`);
  let ok = 0, fallo = 0;
  const porCasa = Object.fromEntries(CASAS.map(c => [c, 0]));
  for (const p of pend.slice(0, MAX)) {
    const hist = {};
    for (const casa of CASAS) {
      try { hist[casa] = await api('historical-odds', { fixtureId: p.fixtureId, bookmaker: casa }); porCasa[casa]++ }
      catch (e) {
        /* NOT_FOUND aca no es un error: es que esa casa no cotizo ese
           partido, y saber cuantas veces pasa es justamente el dato. */
        if (!/NOT_FOUND/.test(e.message) && fallo++ < 5)
          console.log(`  x ${p.fixtureId} ${casa}: ${e.message}`);
      }
    }
    if (Object.keys(hist).length) {
      fs.writeFileSync(path.join(CACHE, p.fixtureId + '.json'),
        JSON.stringify({ fixture: p, casas: hist, hist: hist[CASA] ?? Object.values(hist)[0] }));
      ok++;
      if (ok % 25 === 0) console.log(`  ${ok} con al menos una casa · ${REQ} requests`);
    }
  }
  console.log(`\n${ok} partidos guardados · ${REQ} requests`);
  for (const c of CASAS) console.log(`  ${c}: cotizo ${porCasa[c]} de ${Math.min(pend.length, MAX)}`);
  resumir();
}

/* ---------- leer una línea de tiempo ----------
   La estructura es bookmakers → casa → markets → id → outcomes → id →
   players → "0" → [{createdAt, price, active}]. El mercado de ganador es
   el único con exactamente DOS outcomes y sin handicap. */
function timeline(hist, startTime) {
  const casa = Object.values(hist?.bookmakers || {})[0];
  const mk = casa?.markets || {};
  /* El CIERRE es la última cotización ACTIVA de ANTES de que empiece el
     partido, no la última de la serie. Después del saque bet365 deja
     precios de en-vivo y al final marca 1.00 y 1.01 para liquidar: si uno
     toma el último punto a secas, un partido que cerró 4.33 aparece
     cerrando en 1.00 y todo el análisis se ensucia. */
  const t0 = startTime ? Date.parse(startTime) : Infinity;
  for (const m of Object.values(mk)) {
    const outs = Object.values(m.outcomes || {});
    if (outs.length !== 2) continue;
    const lados = outs.map(o => {
      const serie = (o.players || {})['0'];
      if (!Array.isArray(serie) || !serie.length) return null;
      const previas = serie.filter(x => x.price != null && x.active !== false
        && (!Number.isFinite(t0) || Date.parse(x.createdAt) < t0));
      if (previas.length < 1) return null;
      const precios = previas.map(x => +x.price);
      return {
        apertura: +previas[0].price, aperturaEn: previas[0].createdAt,
        cierre: +previas[previas.length - 1].price, cierreEn: previas[previas.length - 1].createdAt,
        cambios: previas.length, enVivo: serie.length - previas.length,
        min: Math.min(...precios), max: Math.max(...precios),
      };
    });
    if (lados[0] && lados[1]) return lados;
  }
  return null;
}

/* ---------- 3. RESUMEN: sin key, sin requests ---------- */
function resumir() {
  if (!fs.existsSync(CACHE)) return console.log('todavía no hay nada cacheado');
  const idx = leer(INDICE) || { partidos: {} };
  const filas = [];
  let sinLinea = 0;
  for (const f of fs.readdirSync(CACHE)) {
    if (!f.endsWith('.json')) continue;
    const j = leer(path.join(CACHE, f)); if (!j) continue;
    const t = timeline(j.hist, j.fixture?.startTime);
    if (!t) { sinLinea++; continue }
    const porCasa = {};
    for (const [casa, h] of Object.entries(j.casas || {})) {
      const tc = timeline(h, j.fixture?.startTime);
      if (tc) porCasa[casa] = { ci1: tc[0].cierre, ci2: tc[1].cierre, ap1: tc[0].apertura, ap2: tc[1].apertura };
    }
    /* el índice puede tener el resultado más fresco que la foto guardada */
    const p = idx.partidos[j.fixture.fixtureId] || j.fixture;
    const gano = (p.s1 != null && p.s2 != null && p.s1 !== p.s2) ? (p.s1 > p.s2 ? 1 : 2) : null;
    filas.push({
      fixtureId: p.fixtureId, fecha: (p.startTime || '').slice(0, 10), torneo: p.torneo,
      p1: p.p1, p2: p.p2, estado: p.statusId, gano,
      ap1: t[0].apertura, ap2: t[1].apertura,
      ci1: t[0].cierre, ci2: t[1].cierre,
      cambios: t[0].cambios,
      /* cuánto se movió el precio del lado 1, en porcentaje */
      movio: +(((t[0].cierre - t[0].apertura) / t[0].apertura) * 100).toFixed(1),
      casas: porCasa,
    });
  }
  filas.sort((a, b) => String(a.fecha).localeCompare(String(b.fecha)));
  fs.writeFileSync(SALIDA, JSON.stringify({ generado: new Date().toISOString(), casa: CASA, cuotas: filas }, null, 1));
  console.log(`\n${filas.length} partidos con línea de tiempo → vigia/itf-cuotas-historicas.json`
    + (sinLinea ? ` (${sinLinea} sin mercado de ganador legible)` : ''));
  const conRes = filas.filter(f => f.gano);
  console.log(`  ${conRes.length} ya tienen ganador`);
  if (conRes.length >= 20) {
    const favCi = f => f.ci1 < f.ci2 ? 1 : 2;
    const favAp = f => f.ap1 < f.ap2 ? 1 : 2;
    const k = conRes.filter(f => favCi(f) === f.gano).length;
    const ka = conRes.filter(f => favAp(f) === f.gano).length;
    console.log(`\n  el favorito AL CIERRE ganó ${k} de ${conRes.length} (${(100 * k / conRes.length).toFixed(0)}%)`);
    console.log(`  el favorito A LA APERTURA ganó ${ka} de ${conRes.length} (${(100 * ka / conRes.length).toFixed(0)}%)`);
    /* LA BRECHA: dónde Betano paga más que bet365 por el mismo jugador */
    const dos = filas.filter(f => f.casas?.bet365 && f.casas?.betano);
    if (dos.length >= 10) {
      const mejor = dos.map(f => Math.max(
        f.casas.betano.ci1 / f.casas.bet365.ci1, f.casas.betano.ci2 / f.casas.bet365.ci2));
      const cuantos = k => mejor.filter(x => x >= k).length;
      console.log(`\n  BRECHA ENTRE CASAS — ${dos.length} partidos con las dos`);
      console.log(`    Betano paga 3% o más que bet365 en ${cuantos(1.03)} · 5% o más en ${cuantos(1.05)}`
        + ` · 10% o más en ${cuantos(1.10)}`);
      console.log(`    (ahí la ventaja no depende de nuestro modelo: es el libro afilado`);
      console.log(`     diciendo que el blando se equivocó)`);
    } else if (dos.length) {
      console.log(`\n  sólo ${dos.length} partidos con las dos casas: hace falta más para medir la brecha`);
    }
    const dioVuelta = conRes.filter(f => favAp(f) !== favCi(f));
    console.log(`  ${dioVuelta.length} partidos donde el favorito CAMBIÓ entre apertura y cierre`);
    if (dioVuelta.length >= 8) {
      const g = dioVuelta.filter(f => favCi(f) === f.gano).length;
      console.log(`     en esos, ganó el favorito al cierre ${g} de ${dioVuelta.length}`
        + ` — o sea que el movimiento ${g / dioVuelta.length > 0.5 ? 'ACERTÓ' : 'no acertó'}`);
    }
  }
}

if (flag('resumen')) resumir();
else if (!KEY) {
  console.log('Falta ODDSPAPI_KEY.\n');
  console.log('  Capturar el índice de hoy (1 request, hay que correrlo a diario):');
  console.log('    ODDSPAPI_KEY=... node vigia/itf-historico.mjs --capturar\n');
  console.log('  Bajar las líneas de tiempo que falten (1 request por partido):');
  console.log('    ODDSPAPI_KEY=... node vigia/itf-historico.mjs --historia --max 200\n');
  console.log('  Leer lo cacheado sin gastar nada:');
  console.log('    node vigia/itf-historico.mjs --resumen');
  process.exit(1);
}
else if (flag('capturar')) await capturar();
else if (flag('historia')) await historia();
else { await capturar(); await historia() }
