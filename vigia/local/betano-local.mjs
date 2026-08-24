#!/usr/bin/env node
/* ============================================================
   BETANO-LOCAL — abre la pagina de Betano en TU maquina y guarda las
   cuotas en JSON, una por torneo.

   Corre en Chile, donde la pagina abre. Desde el contenedor de Claude no
   sirve: betano responde 403 porque la salida a internet esta en Ohio y
   bloquean por region (probado con fetch y con Chromium real).

   INSTALAR (una sola vez)
     1. Tener Node 18 o mas nuevo:  node --version
     2. En una carpeta cualquiera:
          npm init -y
          npm install playwright
          npx playwright install chromium
     3. Copiar ahi este archivo y betano-consola.js, juntos.

   USAR
     node betano-local.mjs
        Abre el navegador A LA VISTA. Vas clickeando las pestanas de pais
        y el script guarda un JSON cada vez que detecta partidos nuevos.
        Cuando termines, Ctrl+C.

     node betano-local.mjs --url "https://lat.betano.com/sport/tenis/..."
        Otra pagina de partida.

     node betano-local.mjs --oculto
        Sin ventana: lee solo la pestana que venga por defecto.

     node betano-local.mjs --chrome "/ruta/al/chrome"
        Usa otro navegador (por ejemplo el Chrome que ya tienes) si el de
        Playwright no arranca. Tambien sirve la variable BETANO_CHROME.

   Deja los JSON en ./cuotas/. Esos son los que subes.

   Por que a la vista y no automatico: los nombres de clases de Betano
   cambian sin aviso, asi que adivinar como clickear las pestanas es
   fragil. Clickeas tu, que sabes lo que ves, y el programa hace la parte
   aburrida — leer, nombrar y guardar sin equivocarse.
   ============================================================ */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const opt = n => { const i = args.indexOf(n); return i >= 0 ? (args[i + 1] || true) : null; };
const URL_INICIO = opt('--url') || 'https://lat.betano.com/sport/tenis/campeonatos/itf-hombres/10009/';
const OCULTO = args.includes('--oculto');
const SALIDA = path.join(process.cwd(), 'cuotas');

let chromium;
try { ({ chromium } = await import('playwright')); }
catch {
  console.error('Falta playwright. En esta carpeta corre:\n  npm init -y && npm install playwright && npx playwright install chromium');
  process.exit(1);
}
const LECTOR = path.join(DIR, 'betano-consola.js');
if (!fs.existsSync(LECTOR)) {
  console.error(`Falta betano-consola.js al lado de este archivo (${LECTOR}).`);
  process.exit(1);
}
const lector = fs.readFileSync(LECTOR, 'utf8');
fs.mkdirSync(SALIDA, { recursive: true });

/* --chrome deja usar otro binario: el Chrome que ya tengas instalado, o
   uno concreto si el de Playwright da problemas. */
const binario = opt('--chrome') || process.env.BETANO_CHROME || null;
const navegador = await chromium.launch({
  headless: OCULTO,
  ...(binario && binario !== true ? { executablePath: binario } : {}),
});
const ctx = await navegador.newContext({ locale: 'es-CL', viewport: { width: 1440, height: 950 } });
const pag = await ctx.newPage();
await pag.addInitScript(() => { window.__VIGIA_SILENCIO__ = true; });

console.log(`Abriendo ${URL_INICIO}`);
try { await pag.goto(URL_INICIO, { waitUntil: 'domcontentloaded', timeout: 60000 }); }
catch (e) { console.error('No pude abrir la página:', e.message.split('\n')[0]); await navegador.close(); process.exit(1); }
await pag.waitForTimeout(5000);

if (!OCULTO) {
  console.log('\nVe clickeando las pestañas de país. Guardo sola cada una.');
  console.log('Cuando termines, Ctrl+C aquí.\n');
}

const guardados = new Map();          /* huella → archivo, para no repetir */
const limpio = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9]/g, '') || 'torneo';
let n = 0;

async function mirar() {
  let r;
  try { r = await pag.evaluate(lector); } catch { return; }
  if (!r || !r.partidos?.length) return;
  /* huella del contenido: si no cambio, no vuelve a escribir */
  const huella = r.partidos.map(x => `${x.p1}|${x.g1}|${x.p2}|${x.g2}`).sort().join('~');
  if (guardados.has(huella)) return;
  const nombre = `betano-${limpio(r.pais)}-${new Date().toISOString().slice(0, 10)}.json`;
  const ruta = path.join(SALIDA, nombre);
  fs.writeFileSync(ruta, JSON.stringify(r, null, 1));
  guardados.set(huella, ruta);
  n += r.partidos.length;
  console.log(`  ✓ ${String(r.pais || '(sin país)').padEnd(18)} ${String(r.partidos.length).padStart(2)} partidos  →  cuotas/${nombre}`);
  if (r.dudosos?.length) console.log(`    ${r.dudosos.length} tarjeta(s) no se pudieron leer`);
}

const cerrar = async () => {
  console.log(`\n${guardados.size} archivo(s), ${n} partidos en total, en ${SALIDA}`);
  if (!guardados.size) {
    const html = path.join(SALIDA, 'pagina-cruda.html');
    try { fs.writeFileSync(html, await pag.content()); console.log(`No leí ningún partido. Guardé ${html} — mándamelo y ajusto el lector.`); } catch {}
  } else {
    console.log('Sube esos JSON y del otro lado:  node vigia/itf-cuotas-archivos.mjs *.json');
  }
  await navegador.close();
  process.exit(0);
};
process.on('SIGINT', cerrar);

await mirar();
if (OCULTO) await cerrar();
else setInterval(mirar, 2500);
