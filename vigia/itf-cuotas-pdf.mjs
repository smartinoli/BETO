#!/usr/bin/env node
/* ============================================================
   ITF-CUOTAS-PDF — lee los PDF que Sebastian imprime de Betano y carga
   las cuotas solo, sin tipearlas.

   Por que existe: betano bloquea nuestra salida a internet. La IP de esta
   maquina esta en Columbus, Ohio (datacenter de Google) y todos los
   dominios de Betano responden 403 de Cloudflare — probado con fetch
   plano y con Chromium de verdad, mismo resultado ("Betano Splash Screen",
   cf-ray ...-IAD). Es un bloqueo geografico, no un desafio antibot. Asi
   que la parte de abrir la pagina la hace el, y esta la hace el programa.

   El flujo: en betano, cada pestana de pais es un torneo. Imprimir a PDF,
   subir, y correr esto con las rutas.

   Lee: la linea de fecha "25/08 06:00" y la de cuotas
   "Jugador A 3.05 Jugador B 1.32". El torneo sale del nombre del archivo
   ("Apuestas_de_Alemania_...") cruzado con las fechas del mapa: si un pais
   tiene dos torneos abiertos, gana el que contiene la fecha del partido.

   Cada cuota se verifica contra los cuadros en disco ANTES de guardarla:
   si los dos jugadores no aparecen en ese torneo, se reporta y no se
   escribe. Asi un PDF mal mapeado no contamina el registro.

   Uso:  node vigia/itf-cuotas-pdf.mjs archivo1.pdf archivo2.pdf ...
         node vigia/itf-cuotas-pdf.mjs --ensayo *.pdf     (no escribe)
   ============================================================ */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const DATOS = path.join(DIR, 'datos', 'itf');
const norm = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z ]/g, ' ').replace(/\s+/g, ' ').trim();
const tok = s => new Set(norm(s).split(' ').filter(x => x.length >= 3));
const calza = (a, b) => { const A = tok(a), B = tok(b); let c = 0; for (const x of A) if (B.has(x)) c++;
  return c >= 1 && c >= Math.min(A.size, B.size) - 1; };
const leer = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')) } catch { return null } };

const args = process.argv.slice(2);
const ensayo = args.includes('--ensayo');
const pdfs = args.filter(a => !a.startsWith('--'));
if (!pdfs.length) { console.error('uso: node vigia/itf-cuotas-pdf.mjs archivo.pdf [...]'); process.exit(1); }

/* ---------- pais → torneo, desambiguando por fecha ---------- */
const PAIS = {
  alemania: 'ger', austria: 'aut', 'china taipei': 'tpe', taipei: 'tpe', eslovenia: 'slo',
  espana: 'esp', francia: 'fra', rumania: 'rou', suiza: 'sui', italia: 'ita', portugal: 'por',
  polonia: 'pol', belgica: 'bel', china: 'chn', hungria: 'hun', serbia: 'srb', suecia: 'swe',
  paraguay: 'par', argentina: 'arg', egipto: 'egy', tunez: 'tun', holanda: 'ned',
  'paises bajos': 'ned', 'estados unidos': 'usa', turquia: 'tur', grecia: 'gre', croacia: 'cro',
};
const mapa = leer(path.join(DATOS, 'torneos.json')) || {};
const torneos = [];
for (const ts of Object.values(mapa.semanas || {})) for (const [k, t] of Object.entries(ts)) torneos.push({ k, ...t });
for (const [k, t] of Object.entries(mapa.torneos || {})) if (!torneos.find(x => x.k === k)) torneos.push({ k, ...t });

/* ---------- indice de jugadores por torneo, para verificar ---------- */
const jugadores = new Map();          /* clave → Set de nombres */
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
const RE_FECHA = /^\s*(\d{2})\/(\d{2})(?:\s+(\d{1,2}:\d{2}))?\s*$/;
/* "Nombre Apellido 3.05 Otro Nombre 1.32" — dos nombres con su decimal */
const RE_CUOTA = /^\s*([A-Za-zÀ-ÿ'’.\- ]{3,45}?)\s+(\d{1,2}[.,]\d{1,2})\s+([A-Za-zÀ-ÿ'’.\- ]{3,45}?)\s+(\d{1,2}[.,]\d{1,2})\s*$/;

function leerPdf(ruta) {
  let txt;
  try { txt = execFileSync('pdftotext', ['-layout', ruta, '-'], { encoding: 'utf8', maxBuffer: 40e6 }); }
  catch (e) { return { error: 'no pude leer el PDF (¿falta pdftotext?): ' + e.message.split('\n')[0] }; }
  const lineas = txt.split('\n');
  const out = [];
  let fecha = null, hora = null;
  for (const ln of lineas) {
    const f = ln.match(RE_FECHA);
    if (f) { fecha = { dia: f[1], mes: f[2] }; hora = f[3] || null; continue; }
    const c = ln.match(RE_CUOTA);
    if (!c) continue;
    const p1 = c[1].trim(), p2 = c[3].trim();
    const g1 = +c[2].replace(',', '.'), g2 = +c[4].replace(',', '.');
    if (!(g1 > 1 && g1 < 60 && g2 > 1 && g2 < 60)) continue;
    if (p1.length < 4 || p2.length < 4) continue;
    if (norm(p1) === norm(p2)) continue;
    out.push({ p1, p2, g1, g2, fecha, hora });
  }
  /* el mismo partido aparece repetido cuando la página se corta entre hojas */
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
let nuevas = 0, repes = 0;
const problemas = [];

for (const ruta of pdfs) {
  const base = path.basename(ruta);
  const info = paisDeNombre(ruta);
  if (!info) { problemas.push(`${base}: no pude sacar el país del nombre del archivo`); continue; }
  const r = leerPdf(ruta);
  if (r.error) { problemas.push(`${base}: ${r.error}`); continue; }
  if (!r.partidos.length) { problemas.push(`${base}: no encontré ninguna línea de cuotas`); continue; }
  const f0 = r.partidos.find(x => x.fecha)?.fecha;
  if (!f0) { problemas.push(`${base}: no encontré ninguna fecha`); continue; }
  const anio = new Date().getFullYear();
  const fechaISO = `${anio}-${f0.mes}-${f0.dia}`;
  const { t, error } = torneoDe(info.pais, fechaISO, info.quali);
  if (error) { problemas.push(`${base}: ${error}`); continue; }

  const conocidos = jugadores.get(t.k) || new Set();
  const ok = [], fuera = [];
  for (const x of r.partidos) {
    const e1 = [...conocidos].some(n => calza(n, x.p1));
    const e2 = [...conocidos].some(n => calza(n, x.p2));
    (e1 && e2 ? ok : fuera).push({ ...x, e1, e2 });
  }
  console.log(`\n${base}`);
  console.log(`  país "${info.pais}"${info.quali ? ' (clasificación)' : ''} · ${fechaISO} → ${t.nombre} [${t.k}]`);
  console.log(`  ${r.partidos.length} partidos leídos · ${ok.length} verificados en el cuadro · ${fuera.length} sin verificar`);
  for (const x of ok) {
    const k = norm(t.nombre) + '|' + norm(x.p1) + '|' + norm(x.p2);
    if (yaHay.has(k)) { repes++; continue; }
    yaHay.add(k); nuevas++;
    doc.cuotas.push({ torneo: t.nombre, p1: x.p1, p2: x.p2, g1: x.g1, g2: x.g2, visto });
    console.log(`    + ${x.p1} ${x.g1} / ${x.p2} ${x.g2}`);
  }
  for (const x of fuera)
    console.log(`    ? ${x.p1} ${x.g1} / ${x.p2} ${x.g2}   — ${!x.e1 && !x.e2 ? 'ninguno de los dos está' : 'no está ' + (x.e1 ? x.p2 : x.p1)} en el cuadro de ${t.nombre}`);
}

if (problemas.length) { console.log('\nPROBLEMAS'); for (const p of problemas) console.log('  ' + p); }
console.log(`\n${nuevas} cuotas nuevas · ${repes} ya estaban${ensayo ? ' · ENSAYO: no se escribió nada' : ''}`);
if (!ensayo && nuevas) {
  fs.writeFileSync(path.join(DIR, 'itf-cuotas-manuales.json'), JSON.stringify(doc, null, 1));
  console.log('→ vigia/itf-cuotas-manuales.json');
  console.log('  ahora: node vigia/itf-proximos.mjs && node vigia/itf-mercado.mjs');
}
