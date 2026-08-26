#!/usr/bin/env node
/* ============================================================
   ITF-CUOTAS-ARCHIVOS — carga cuotas de Betano desde archivos, sin
   tipearlas: los JSON que produce vigia/local/betano-consola.js y los
   PDF impresos de la pagina.

   Por que existe: betano bloquea nuestra salida a internet. La IP de esta
   maquina esta en Columbus, Ohio (datacenter de Google) y todos sus
   dominios responden 403 de Cloudflare — probado con fetch plano y con
   Chromium real, mismo resultado ("Betano Splash Screen", cf-ray ...-IAD).
   Es un bloqueo geografico, no un desafio antibot: no hay nada que
   resolver desde aca. La lectura la hace el navegador de Sebastian, en
   Chile, y a este lado solo llega el archivo.

   Dos formas de traer las cuotas, de mejor a peor:
     1. JSON — pegar vigia/local/betano-consola.js en la consola del
        navegador con la pagina del torneo abierta. Trae nombres, cuotas,
        fecha y hora exactos, y el pais de la pestana.
     2. PDF — imprimir la pagina a PDF y subirla. Funciona igual pero el
        pais sale del nombre del archivo y la hora a veces se pierde.

   De donde sale el torneo: del pais (campo del JSON, o nombre del archivo
   en el PDF) cruzado con las fechas del mapa. Si un pais tiene dos
   torneos abiertos, gana el que contiene la fecha del partido, y la
   pestana "- Clasificacion" apunta al que sigue en qualis.

   Cada partido se verifica contra los cuadros en disco ANTES de
   guardarlo: si los dos jugadores no aparecen en ese torneo, se reporta
   y no se escribe. Asi un archivo mal mapeado no contamina el registro.

   Uso:  node vigia/itf-cuotas-archivos.mjs betano-Francia-2026-08-25.json
         node vigia/itf-cuotas-archivos.mjs *.json *.pdf
         node vigia/itf-cuotas-archivos.mjs --ensayo *.json   (no escribe)
   ============================================================ */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mismoJugador, elegirNombre } from './itf-reglas.mjs';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const DATOS = path.join(DIR, 'datos', 'itf');
const norm = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z ]/g, ' ').replace(/\s+/g, ' ').trim();
/* el cruce difuso de nombres vive en itf-reglas.mjs: una sola version,
   probada, en vez de tres copias sueltas que ya nos costaron una cuota
   guardada con el jugador equivocado */
const calza = mismoJugador;
const leer = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')) } catch { return null } };

const args = process.argv.slice(2);
const ensayo = args.includes('--ensayo');
const pdfs = args.filter(a => !a.startsWith('--'));
if (!pdfs.length) { console.error('uso: node vigia/itf-cuotas-archivos.mjs archivo.json|archivo.pdf [...]'); process.exit(1); }

/* ---------- pais → torneo, desambiguando por fecha ---------- */
const PAIS = {
  alemania: 'ger', austria: 'aut', 'china taipei': 'tpe', taipei: 'tpe', eslovenia: 'slo',
  espana: 'esp', francia: 'fra', rumania: 'rou', suiza: 'sui', italia: 'ita', portugal: 'por',
  polonia: 'pol', belgica: 'bel', china: 'chn', hungria: 'hun', serbia: 'srb', suecia: 'swe',
  paraguay: 'par', argentina: 'arg', egipto: 'egy', tunez: 'tun', holanda: 'ned',
  'paises bajos': 'ned', 'estados unidos': 'usa', turquia: 'tur', grecia: 'gre', croacia: 'cro',
  /* Betano titula la pestana "EE.UU.", que al perder los puntos queda
     "ee uu" y no se parece a "estados unidos" ni de lejos */
  'ee uu': 'usa', eeuu: 'usa', usa: 'usa', 'gran bretana': 'gbr', japon: 'jpn',
  brasil: 'bra', mexico: 'mex', canada: 'can', australia: 'aus', india: 'ind',
  colombia: 'col', peru: 'per', chile: 'chi', uruguay: 'uru', bolivia: 'bol',
  ecuador: 'ecu', republica: 'dom', finlandia: 'fin', noruega: 'nor',
  dinamarca: 'den', letonia: 'lat', lituania: 'ltu', estonia: 'est',
  bulgaria: 'bul', eslovaquia: 'svk', 'republica checa': 'cze', ucrania: 'ukr',
  israel: 'isr', marruecos: 'mar', 'corea del sur': 'kor', tailandia: 'tha',
  indonesia: 'ina', vietnam: 'vie', kazajistan: 'kaz', uzbekistan: 'uzb',
};
const mapa = leer(path.join(DATOS, 'torneos.json')) || {};
const torneos = [];
for (const ts of Object.values(mapa.semanas || {})) for (const [k, t] of Object.entries(ts)) torneos.push({ k, ...t });
for (const [k, t] of Object.entries(mapa.torneos || {})) if (!torneos.find(x => x.k === k)) torneos.push({ k, ...t });

/* ---------- indice de jugadores por torneo, para verificar ---------- */
const jugadores = new Map();          /* clave → Set de nombres del CUADRO */
for (const dir of [DATOS, path.join(DATOS, 'vivo')]) {
  for (const f of fs.readdirSync(dir)) {
    if (!f.startsWith('m-itf') || !f.endsWith('.json') || f.includes('aceptacion')) continue;
    const clave = f.replace('.json', '');
    const j = leer(path.join(dir, f)); if (!j?.cuadros) continue;
    const s = jugadores.get(clave) || new Set();
    for (const c of Object.values(j.cuadros)) for (const r of c.rondas || []) for (const m of r.partidos)
      for (const l of m.lados || []) if (l.nombre) s.add(l.nombre);
    jugadores.set(clave, s);
  }
}
/* Segunda red: la ENTRY LIST del torneo.
   El cuadro es la verificación buena porque prueba que el partido existe
   tal como Betano lo cotiza. Pero cuando la ITF no ha publicado el cuadro
   actualizado —Maanshan el 25-08: el cuadro en disco era del 23-08 y los
   clasificados todavía no estaban— el cruce contra el cuadro rechaza
   partidos que SI se juegan, y perdemos el torneo entero.
   La entry list es la lista oficial de inscritos de ese mismo torneo, así
   que sirve para confirmar que el jugador es quien Betano dice y que está
   en ESE torneo. Lo que NO prueba es el emparejamiento: ahí confiamos en
   el PDF. Por eso la fila queda marcada con via:"lista" y se puede
   auditar después. */
const inscritos = new Map();
for (const f of fs.readdirSync(DATOS)) {
  if (!f.endsWith('.aceptacion.json')) continue;
  const clave = f.replace('.aceptacion.json', '');
  const j = leer(path.join(DATOS, f)); if (!j?.secciones) continue;
  const s = new Set();
  for (const arr of Object.values(j.secciones)) for (const q of arr) if (q.nombre) s.add(q.nombre);
  inscritos.set(clave, s);
}

/* Al subir, el nombre del archivo pierde los acentos y la ñ: "España"
   llega como "Espa_a" → "Espa a". Se compara sin espacios y tolerando
   hasta dos letras de diferencia. */
function distancia(a, b) {
  const m = a.length, n = b.length;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++)
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[n];
}
function paisA(pais) {
  const k = norm(pais);
  if (PAIS[k]) return PAIS[k];
  const plano = k.replace(/ /g, '');
  let mejor = null, md = 99;
  for (const nom of Object.keys(PAIS)) {
    const d = distancia(plano, nom.replace(/ /g, ''));
    if (d < md) { md = d; mejor = nom; }
  }
  return md <= 2 ? PAIS[mejor] : null;
}

function torneoDe(pais, fechaISO, quali) {
  const cc = paisA(pais);
  if (!cc) return { error: `no sé qué país es "${pais}"` };
  const cand = torneos.filter(t => t.k.includes('-' + cc + '-') && t.fechas && !t.archivado &&
    fechaISO >= t.fechas.quali && fechaISO <= t.fechas.final);
  if (!cand.length) return { error: `${pais}: ningún torneo abierto contiene ${fechaISO}` };
  if (cand.length > 1) {
    /* la pestaña "- Clasificación" apunta al que todavía está en quali */
    const f = cand.filter(t => quali ? fechaISO < t.fechas.main : fechaISO >= t.fechas.main);
    if (f.length === 1) return { t: f[0] };
    return { error: `${pais}: ${cand.length} torneos posibles (${cand.map(t => t.nombre).join(', ')})` };
  }
  return { t: cand[0] };
}

/* ---------- leer un PDF ---------- */
/* Betano imprime en dos formatos distintos, y cambian sin aviso:
     A) "25/08 06:00" en una linea, y debajo los nombres y las cuotas
     B) la fecha pegada al primer jugador, la hora DEBAJO de la cuota:
          25/08   Nicolas Ulrich
                  Nicolas Ulrich  2.07   Laurin Aerne  1.65
          05:00   Laurin Aerne
   Por eso no se asume orden: se marca cada linea por lo que es y despues
   se le pega a cada cuota la fecha y la hora mas cercanas. */
const RE_FECHA = /^\s*(\d{1,2})[\/.](\d{1,2})(?!\d)/;
const RE_HORA  = /^\s*(\d{1,2}:\d{2})(?!\d)/;
const RE_CUOTA = /^\s*([A-Za-zÀ-ÿ'’.\- ]{3,45}?)\s\s*(\d{1,3}[.,]\d{1,2})\s\s+([A-Za-zÀ-ÿ'’.\- ]{3,45}?)\s\s*(\d{1,3}[.,]\d{1,2})\s*$/;
const CERCA = 8;                       /* cuantas lineas se mira alrededor */

function leerPdf(ruta) {
  let txt;
  try { txt = execFileSync('pdftotext', ['-layout', ruta, '-'], { encoding: 'utf8', maxBuffer: 40e6 }); }
  catch (e) { return { error: 'no pude leer el PDF (¿falta pdftotext?): ' + e.message.split('\n')[0] }; }
  const lineas = txt.split('\n');

  /* pasada 1: marcar que es cada linea */
  const fechas = [], horas = [], cuotas = [];
  lineas.forEach((ln, i) => {
    const c = ln.match(RE_CUOTA);
    if (c) {
      const g1 = +c[2].replace(',', '.'), g2 = +c[4].replace(',', '.');
      const p1 = c[1].trim(), p2 = c[3].trim();
      if (g1 > 1 && g1 < 100 && g2 > 1 && g2 < 100 && p1.length >= 4 && p2.length >= 4 && norm(p1) !== norm(p2))
        cuotas.push({ i, p1, p2, g1, g2 });
      return;                          /* una linea de cuotas no es fecha ni hora */
    }
    const f = ln.match(RE_FECHA);
    if (f && +f[1] >= 1 && +f[1] <= 31 && +f[2] >= 1 && +f[2] <= 12)
      fechas.push({ i, dia: f[1].padStart(2, '0'), mes: f[2].padStart(2, '0') });
    const h = ln.match(RE_HORA);
    if (h) horas.push({ i, hora: h[1] });
  });

  /* pasada 2: a cada cuota, la fecha de arriba y la hora mas cercana */
  const cercano = (arr, i) => {
    let mejor = null, md = Infinity;
    for (const x of arr) { const d = Math.abs(x.i - i); if (d < md) { md = d; mejor = x; } }
    return md <= CERCA ? mejor : null;
  };
  const out = [];
  for (const c of cuotas) {
    const arriba = fechas.filter(f => f.i <= c.i);
    const f = arriba.length ? arriba[arriba.length - 1] : cercano(fechas, c.i);
    const h = cercano(horas, c.i);
    out.push({ p1: c.p1, p2: c.p2, g1: c.g1, g2: c.g2,
      fecha: f ? { dia: f.dia, mes: f.mes } : null, hora: h ? h.hora : null });
  }
  /* el mismo partido sale repetido cuando la pagina se corta entre hojas */
  const visto = new Set(), unicos = [];
  for (const x of out) { const k = norm(x.p1) + '|' + norm(x.p2);
    if (visto.has(k)) continue; visto.add(k); unicos.push(x); }
  return { partidos: unicos };
}

const paisDeNombre = f => {
  const m = path.basename(f).match(/Apuestas_de_(.+?)_Pron/i);
  if (!m) return null;
  const crudo = decodeURIComponent(m[1]).replace(/_/g, ' ');
  return { pais: crudo.replace(/\s*-?\s*Clasificaci.*$/i, '').replace(/_/g, ' ').trim(),
           quali: /Clasificaci/i.test(crudo) };
};

/* ---------- procesar ---------- */
const doc = leer(path.join(DIR, 'itf-cuotas-manuales.json')) || { cuotas: [] };
const yaHay = new Set(doc.cuotas.map(c => norm(c.torneo) + '|' + norm(c.p1) + '|' + norm(c.p2)));
const visto = new Date().toISOString().slice(0, 16) + 'Z';
/* LA TANDA: las claves de TODOS los partidos que venian en los archivos de
   esta corrida, esten o no ya en el registro. Sebastian manda una foto
   completa del dia (9 PDF, uno por torneo) y quiere ver SOLO eso: sin esta
   lista, el informe mostraria tambien las cuotas viejas que siguen en el
   registro y que ya no son las de hoy. Los repetidos tienen que entrar
   igual — que un partido ya estuviera cargado no lo saca de la foto. */
const tanda = { generado: new Date().toISOString(), archivos: [], partidos: [] };
let nuevas = 0, repes = 0;
const problemas = [];

for (const ruta of pdfs) {
  const base = path.basename(ruta);
  const esJson = /\.json$/i.test(ruta);
  const r = esJson ? leerJson(ruta) : leerPdf(ruta);
  if (r.error) { problemas.push(`${base}: ${r.error}`); continue; }
  /* el JSON trae el país adentro; el PDF sólo en el nombre del archivo */
  const info = (esJson && r.pais) ? { pais: r.pais, quali: /Clasificaci/i.test(r.pais) } : paisDeNombre(ruta);
  if (!info) { problemas.push(`${base}: no pude determinar el país`); continue; }
  if (!r.partidos.length) { problemas.push(`${base}: no encontré ninguna línea de cuotas`); continue; }
  const f0 = r.partidos.find(x => x.fecha)?.fecha;
  if (!f0) { problemas.push(`${base}: no encontré ninguna fecha`); continue; }
  const anio = new Date().getFullYear();
  const fechaISO = `${anio}-${f0.mes}-${f0.dia}`;
  const { t, error } = torneoDe(info.pais, fechaISO, info.quali);
  if (error) { problemas.push(`${base}: ${error}`); continue; }

  /* Se guarda el nombre como lo escribe la ITF, no como lo escribe Betano
     ("Aren Baybar" contra "Aren Baybars", "Luca" contra "Lucca"). El cruce
     de aca en adelante es difuso igual, pero un registro con la ortografia
     oficial se puede leer y comparar a mano sin dudar de nada. */
  const conocidos = [...(jugadores.get(t.k) || new Set())];
  const enLista = [...(inscritos.get(t.k) || new Set())];
  const ok = [], fuera = [];
  let porLista = 0;
  for (const x of r.partidos) {
    let n1 = elegirNombre(conocidos, x.p1), n2 = elegirNombre(conocidos, x.p2), via = 'cuadro';
    if (!n1 || !n2) {
      const l1 = n1 || elegirNombre(enLista, x.p1), l2 = n2 || elegirNombre(enLista, x.p2);
      if (l1 && l2) { n1 = l1; n2 = l2; via = 'lista'; porLista++; }
    }
    (n1 && n2 ? ok : fuera).push({ ...x, e1: !!n1, e2: !!n2, via,
      itf1: n1 || x.p1, itf2: n2 || x.p2 });
  }
  console.log(`\n${base}`);
  console.log(`  ${esJson ? 'JSON' : 'PDF'} · país "${info.pais}"${info.quali ? ' (clasificación)' : ''} · ${fechaISO} → ${t.nombre} [${t.k}]`);
  console.log(`  ${r.partidos.length} partidos leídos · ${ok.length - porLista} verificados en el cuadro`
    + (porLista ? ` · ${porLista} solo en la entry list (cuadro desactualizado)` : '')
    + ` · ${fuera.length} sin verificar`);
  tanda.archivos.push(base);
  for (const x of ok) {
    const k = norm(t.nombre) + '|' + norm(x.itf1) + '|' + norm(x.itf2);
    tanda.partidos.push({ torneo: t.nombre, p1: x.itf1, p2: x.itf2, clave: t.k, archivo: base });
    if (yaHay.has(k)) { repes++; continue; }
    yaHay.add(k); nuevas++;
    doc.cuotas.push({ torneo: t.nombre, p1: x.itf1, p2: x.itf2, g1: x.g1, g2: x.g2, visto,
      ...(x.via === 'lista' ? { via: 'lista' } : {}),
      ...(norm(x.itf1) !== norm(x.p1) || norm(x.itf2) !== norm(x.p2)
        ? { betano: `${x.p1} / ${x.p2}` } : {}) });
    const ren = norm(x.itf1) !== norm(x.p1) || norm(x.itf2) !== norm(x.p2);
    console.log(`    ${x.via === 'lista' ? '~' : '+'} ${x.itf1} ${x.g1} / ${x.itf2} ${x.g2}`
      + (ren ? `   (Betano los escribe "${x.p1}" / "${x.p2}")` : '')
      + (x.via === 'lista' ? '   [entry list: el emparejamiento sale del PDF]' : ''));
  }
  for (const x of fuera)
    console.log(`    ? ${x.p1} ${x.g1} / ${x.p2} ${x.g2}   — ${!x.e1 && !x.e2 ? 'ninguno de los dos está' : 'no está ' + (x.e1 ? x.p2 : x.p1)} ni en el cuadro ni en la entry list de ${t.nombre}`);
}

if (problemas.length) { console.log('\nPROBLEMAS'); for (const p of problemas) console.log('  ' + p); }
console.log(`\n${nuevas} cuotas nuevas · ${repes} ya estaban${ensayo ? ' · ENSAYO: no se escribió nada' : ''}`);
if (!ensayo) {
  fs.writeFileSync(path.join(DIR, 'itf-cuotas-tanda.json'), JSON.stringify(tanda, null, 1));
  console.log(`  tanda: ${tanda.partidos.length} partidos de ${tanda.archivos.length} archivos → vigia/itf-cuotas-tanda.json`);
}
if (!ensayo && nuevas) {
  fs.writeFileSync(path.join(DIR, 'itf-cuotas-manuales.json'), JSON.stringify(doc, null, 1));
  console.log('→ vigia/itf-cuotas-manuales.json');
  console.log('  ahora: node vigia/itf-proximos.mjs && node vigia/itf-mercado.mjs');
}
