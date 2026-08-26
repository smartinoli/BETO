#!/usr/bin/env node
/* ============================================================
   ITF-HISTORICO — traer cuotas VIEJAS de OddsPapi.

   Este es el cuello de botella de todo el sistema y por eso existe este
   archivo. Tenemos 1252 partidos con resultado y 52 con precio. Toda
   pregunta que importa —¿le ganamos al mercado?, ¿la contra sirve?— es
   "precio contra realidad", y la estamos contestando con el 4% de los
   datos. La regla de LA CONTRA se apoya en 19 partidos y su intervalo va
   de 41% a 81%: con 400 se cierra, con 19 no.

   OddsPapi sí tiene histórico. Dos llamadas encadenadas:

     GET /v4/fixtures?sportId=12&startTimeFrom=…&startTimeTo=…
         → los partidos de esas fechas, con statusId (2 = terminado),
           marcador y tournamentName. De acá salen los fixtureId.

     GET /v4/fixtures/odds/historical?fixtureId=…&bookmaker=bet365
         → la línea de tiempo COMPLETA de precios de esa casa para ese
           partido. No sólo la cuota final: cada cambio con su hora, o
           sea también la de APERTURA.

   Que sirvan las dos con fechas pasadas no está garantizado en la
   documentación —no dice hasta dónde llega el archivo ni si el plan lo
   incluye— y sin la key no se puede saber. Por eso el modo --probar:
   gasta 3 o 4 requests y responde exactamente eso antes de que gastemos
   el plan entero.

   LA APERTURA VALE MÁS QUE EL CIERRE para lo que buscamos. La regla de
   la contra dice "cuando el precio le lleva la contra al rating, el
   precio sabe algo". Con la línea de tiempo se puede separar qué sabía
   el mercado al abrir de qué aprendió después, que es justo la
   diferencia entre una ventaja aprovechable y una que llega tarde.

   COSTO: una llamada por partido. Se cachea CADA respuesta en disco, así
   que volver a correrlo no gasta nada. Con --max se pone techo.

   Uso:
     ODDSPAPI_KEY=... node vigia/itf-historico.mjs --probar
     ODDSPAPI_KEY=... node vigia/itf-historico.mjs --dias 30 --max 200
     ODDSPAPI_KEY=... node vigia/itf-historico.mjs --dias 30 --max 200 --casa bet365
     node vigia/itf-historico.mjs --resumen        (sin key: lee lo cacheado)
   ============================================================ */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const DATOS = path.join(DIR, 'datos', 'itf');
const CACHE = path.join(DATOS, 'historico');
const SALIDA = path.join(DIR, 'itf-cuotas-historicas.json');
const KEY = process.env.ODDSPAPI_KEY;

const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i > 0 ? process.argv[i + 1] : d };
const flag = n => process.argv.includes('--' + n);
const DIAS = +arg('dias', 30);
const MAX = +arg('max', 150);
const CASA = arg('casa', 'bet365');
const SPORT_TENIS = 12;

/* ITF se reconoce por el nombre del torneo: el circuito no tiene un
   sportId propio y en OddsPapi convive con ATP y Challengers. */
const ES_ITF = t => /\bitf\b|\bm15\b|\bm25\b|\bw15\b|\bw25\b|\bw35\b|\bw50\b|\bw75\b|\bw100\b/i.test(t || '');
/* dobles fuera: el modelo es de singles y los nombres traen "/" */
const ES_DOBLES = (a, b) => /\//.test(a || '') || /\//.test(b || '');

/* ---------- API, con el mismo pacing que vigia.mjs ---------- */
let REQ = 0, ULTIMO = 0;
const espera = ms => new Promise(r => setTimeout(r, ms));
async function api(ruta, params = {}, cooldown = 1100) {
  if (!KEY) throw new Error('falta ODDSPAPI_KEY');
  const u = new URL('https://api.oddspapi.io/v4/' + ruta);
  Object.entries({ ...params, apiKey: KEY }).forEach(([k, v]) => u.searchParams.set(k, v));
  for (let intento = 0; ; intento++) {
    const falta = ULTIMO + cooldown - Date.now();
    if (falta > 0) await espera(falta);
    ULTIMO = Date.now();
    let r = null, errRed = null;
    try {
      r = await fetch(u, { signal: AbortSignal.timeout(25000),
        headers: { 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) vigia/2.0' } });
    } catch (e) { errRed = e }
    if ((errRed || r.status === 429 || r.status >= 500) && intento < 3) { await espera(1000 * 2 ** intento); continue }
    if (errRed) throw new Error('red: ' + errRed.message);
    const cuerpo = await r.json().catch(() => null);
    if (cuerpo && cuerpo.error) { const e = new Error(cuerpo.error.code || cuerpo.error.message); e.api = cuerpo.error; throw e }
    if (!r.ok) throw new Error('HTTP ' + r.status);
    REQ++;
    return cuerpo;
  }
}
const lista = d => Array.isArray(d) ? d : (d?.data ?? (Array.isArray(d?.fixtures) ? d.fixtures : []));
const epoch = fecha => Math.floor(new Date(fecha + 'T00:00:00Z').getTime() / 1000);
const dia = n => new Date(Date.now() - n * 864e5).toISOString().slice(0, 10);

/* ---------- partidos de un rango de fechas ---------- */
async function fixturesDe(desde, hasta) {
  /* La documentación pide startTimeFrom/startTimeTo en epoch. El código
     viejo manda from/to en ISO y funciona, así que se mandan los cuatro:
     el que sobra lo ignora la API y así no dependemos de cuál versión
     está sirviendo hoy. */
  const d = await api('fixtures', {
    sportId: SPORT_TENIS,
    startTimeFrom: epoch(desde), startTimeTo: epoch(hasta) + 86400,
    from: desde, to: hasta,
  }, 1400);
  return lista(d);
}

/* ---------- de la línea de tiempo a dos números ---------- */
/* Cada casa trae outcomes anidados por resultado y por marca de tiempo.
   Nos quedamos con el mercado de ganador del partido (dos salidas) y
   sacamos el primer y el último precio de cada lado. */
function apertureYCierre(hist) {
  const casas = hist?.odds || hist?.data?.odds || {};
  const casa = casas[CASA] || Object.values(casas)[0];
  if (!casa) return null;
  const salidas = [];
  const recorrer = (o, prof = 0) => {
    if (!o || typeof o !== 'object' || prof > 5) return;
    /* una salida es un objeto cuyas claves son marcas de tiempo y cuyos
       valores traen un precio */
    const claves = Object.keys(o);
    const pinta = claves.length && claves.every(k => /^\d{9,}$/.test(k));
    if (pinta) {
      const t = claves.map(Number).sort((a, b) => a - b);
      const precio = k => { const v = o[String(k)]; return v?.price ?? v?.odds ?? v?.value ?? null };
      const ap = precio(t[0]), ci = precio(t[t.length - 1]);
      if (ap != null && ci != null) salidas.push({ apertura: +ap, cierre: +ci, cambios: t.length });
      return;
    }
    for (const v of Object.values(o)) recorrer(v, prof + 1);
  };
  recorrer(casa);
  if (salidas.length !== 2) return null;   /* sólo el mercado de dos salidas */
  return salidas;
}

/* ---------- MODO PROBAR: gastar poco y contestar mucho ---------- */
async function probar() {
  console.log('PRUEBA DE HISTÓRICO — gasta 3 o 4 requests\n');
  console.log(`casa: ${CASA} · deporte: tenis (${SPORT_TENIS})\n`);
  for (const atras of [7, 30, 90]) {
    const f = dia(atras);
    console.log(`── hace ${atras} días (${f}) ──`);
    let fx;
    try { fx = await fixturesDe(f, f) }
    catch (e) { console.log(`  ✗ /fixtures falló: ${e.message}`); if (/RESTRICTED|PLAN/i.test(e.message)) console.log('     → el plan no incluye fechas pasadas.'); continue }
    const itf = fx.filter(x => ES_ITF((x.tournamentName || '') + ' ' + (x.categoryName || ''))
      && !ES_DOBLES(x.participant1Name, x.participant2Name));
    console.log(`  ✓ /fixtures devolvió ${fx.length} partidos de tenis · ${itf.length} de ITF singles`);
    if (!itf.length) { console.log('     (sin ITF ese día: el archivo puede no llegar tan atrás)'); continue }
    const uno = itf.find(x => x.statusId === 2) || itf[0];
    console.log(`  probando con: ${uno.participant1Name} vs ${uno.participant2Name} (${uno.tournamentName})`);
    console.log(`     fixtureId ${uno.fixtureId} · estado ${uno.statusId} · ${uno.startTime}`);
    try {
      const h = await api('fixtures/odds/historical', { fixtureId: uno.fixtureId, bookmaker: CASA }, 1400);
      const ac = apertureYCierre(h);
      if (ac) {
        console.log(`  ✓ HISTÓRICO OK — apertura ${ac[0].apertura} / ${ac[1].apertura}`
          + `   cierre ${ac[0].cierre} / ${ac[1].cierre}   (${ac[0].cambios} cambios de precio)`);
        console.log('\n  → SIRVE. Con esto se puede reconstruir el registro hacia atrás.');
      } else {
        console.log('  ⚠ respondió pero no pude leer dos salidas. Claves de nivel alto:');
        console.log('     ' + JSON.stringify(Object.keys(h?.odds || h?.data?.odds || h || {})).slice(0, 300));
        fs.mkdirSync(CACHE, { recursive: true });
        fs.writeFileSync(path.join(CACHE, 'muestra.json'), JSON.stringify(h, null, 1));
        console.log('     guardé la respuesta cruda en datos/itf/historico/muestra.json para ajustar el lector');
      }
    } catch (e) {
      console.log(`  ✗ histórico falló: ${e.message}`);
      if (/RESTRICTED|PLAN|FORBIDDEN/i.test(e.message))
        console.log('     → el endpoint histórico NO está en el plan. Hay que contratarlo o seguir juntando a mano.');
    }
    console.log('');
  }
  console.log(`requests gastados: ${REQ}`);
}

/* ---------- MODO COSECHA ---------- */
async function cosechar() {
  fs.mkdirSync(CACHE, { recursive: true });
  const yaTengo = new Set(fs.readdirSync(CACHE).filter(f => f.endsWith('.json')).map(f => f.replace('.json', '')));
  console.log(`Cosecha de ${DIAS} días hacia atrás · casa ${CASA} · techo ${MAX} requests`);
  console.log(`${yaTengo.size} partidos ya cacheados (no vuelven a gastar)\n`);

  /* 1. el índice de partidos, de a semanas para no pedir 30 veces */
  const candidatos = [];
  for (let d = 0; d < DIAS; d += 7) {
    const hasta = dia(d), desde = dia(Math.min(d + 6, DIAS - 1));
    let fx;
    try { fx = await fixturesDe(desde, hasta) }
    catch (e) { console.log(`  ✗ ${desde}→${hasta}: ${e.message}`); continue }
    const itf = fx.filter(x => ES_ITF((x.tournamentName || '') + ' ' + (x.categoryName || ''))
      && !ES_DOBLES(x.participant1Name, x.participant2Name) && x.statusId === 2);
    console.log(`  ${desde} → ${hasta}: ${fx.length} de tenis, ${itf.length} ITF singles terminados`);
    candidatos.push(...itf);
  }
  const nuevos = candidatos.filter(f => !yaTengo.has(String(f.fixtureId)));
  console.log(`\n${candidatos.length} candidatos · ${nuevos.length} sin cachear · voy a pedir ${Math.min(nuevos.length, MAX)}\n`);

  /* 2. la línea de tiempo de cada uno */
  let ok = 0, fallo = 0;
  for (const f of nuevos.slice(0, MAX)) {
    try {
      const h = await api('fixtures/odds/historical', { fixtureId: f.fixtureId, bookmaker: CASA }, 1200);
      fs.writeFileSync(path.join(CACHE, f.fixtureId + '.json'), JSON.stringify({ fixture: f, hist: h }));
      ok++;
      if (ok % 10 === 0) console.log(`  ${ok} bajados · ${REQ} requests`);
    } catch (e) { fallo++; if (fallo <= 3) console.log(`  ✗ ${f.fixtureId}: ${e.message}`) }
  }
  console.log(`\n${ok} bajados · ${fallo} fallaron · ${REQ} requests gastados`);
  resumir();
}

/* ---------- MODO RESUMEN: leer lo cacheado, sin gastar nada ---------- */
function resumir() {
  if (!fs.existsSync(CACHE)) return console.log('todavía no hay nada cacheado');
  const filas = [];
  for (const f of fs.readdirSync(CACHE)) {
    if (!f.endsWith('.json') || f === 'muestra.json') continue;
    let j; try { j = JSON.parse(fs.readFileSync(path.join(CACHE, f), 'utf8')) } catch { continue }
    const ac = apertureYCierre(j.hist);
    if (!ac) continue;
    const x = j.fixture;
    const g = x.participant1Score != null && x.participant2Score != null
      ? (x.participant1Score > x.participant2Score ? 1 : 2) : null;
    filas.push({
      fixtureId: x.fixtureId, fecha: (x.startTime || '').slice(0, 10), torneo: x.tournamentName,
      p1: x.participant1Name, p2: x.participant2Name,
      apertura1: ac[0].apertura, apertura2: ac[1].apertura,
      cierre1: ac[0].cierre, cierre2: ac[1].cierre, cambios: ac[0].cambios,
      gano: g,
    });
  }
  fs.writeFileSync(SALIDA, JSON.stringify({ generado: new Date().toISOString(), casa: CASA, cuotas: filas }, null, 1));
  console.log(`\n${filas.length} partidos con apertura, cierre y resultado → vigia/itf-cuotas-historicas.json`);
  const conRes = filas.filter(f => f.gano);
  console.log(`  ${conRes.length} con ganador identificado`);
  if (conRes.length >= 20) {
    /* la pregunta de siempre, ahora con datos de verdad */
    const fav = f => f.cierre1 < f.cierre2 ? 1 : 2;
    const cf = f => fav(f) === 1 ? f.cierre1 : f.cierre2;
    const k = conRes.filter(f => fav(f) === f.gano).length;
    console.log(`\n  el favorito POR PRECIO ganó ${k} de ${conRes.length} (${(100 * k / conRes.length).toFixed(0)}%)`);
    const movio = conRes.filter(f => Math.abs((fav(f) === 1 ? f.apertura1 : f.apertura2) - cf(f)) / cf(f) > 0.05);
    console.log(`  ${movio.length} partidos donde el precio se movió más de 5% entre apertura y cierre`);
  }
}

/* ---------- ---------- */
if (flag('resumen')) resumir();
else if (!KEY) {
  console.log('Falta ODDSPAPI_KEY.\n');
  console.log('  Para probar si el plan trae histórico (gasta 3-4 requests):');
  console.log('    ODDSPAPI_KEY=... node vigia/itf-historico.mjs --probar\n');
  console.log('  Para leer lo que ya esté cacheado, sin key ni requests:');
  console.log('    node vigia/itf-historico.mjs --resumen');
  process.exit(1);
}
else if (flag('probar')) await probar();
else await cosechar();
