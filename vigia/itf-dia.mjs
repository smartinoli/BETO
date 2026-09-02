#!/usr/bin/env node
/* ============================================================
   ITF-DIA — la rutina diaria completa, en un comando.

   Lo que Sebastián quiere ver todos los días: quién gana según el
   modelo, con su análisis, y la comparación contra lo que pasó. Esto
   encadena las tres piezas que lo producen:

     1. itf-historico --capturar    el índice del día en OddsPapi (los
                                    fixtures y sus cuotas; OJO: medido el
                                    2026-08-27, OddsPapi NO trae marcadores
                                    de ITF — los veredictos se califican
                                    con el CUADRO oficial, que refresca
                                    itf-navegador oop)
     2. itf-cuotas-bet365           las cuotas vigentes de los partidos
                                    por jugar (1 request por partido)
     3. itf-informe --bet365        la página: tabla de veredictos,
                                    historial de aciertos modelo contra
                                    mercado, y el detalle por partido

   Con ODDSPAPI_KEY hace las tres; sin la key, solo la 3 (rearma la
   página con lo que haya en disco, útil para recalificar).

   Uso:  ODDSPAPI_KEY=... node vigia/itf-dia.mjs [--max 60]
   ============================================================ */
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i > 0 ? process.argv[i + 1] : d };
/* Sin tope por cantidad: manda la ventana de horas (ver itf-cuotas). */
const MAX = arg('max', null);
const HORAS = arg('horas', '14');
const KEY = process.env.ODDSPAPI_KEY;

const paso = (nombre, archivo, args = []) => {
  console.log(`\n━━ ${nombre} ━━`);
  try {
    console.log(execFileSync('node', [path.join(DIR, archivo), ...args],
      { encoding: 'utf8', timeout: 35 * 60e3, env: process.env }).trim());
    /* 35 min, no 15 (2026-09-02): un martes son ~150 partidos a 3 s cada
       uno mas los reintentos del rate limit — el tope de 15 mato el paso
       de cuotas de Betano a los 15:00 exactos y se perdio todo. */
    return true;
  } catch (e) {
    console.log(`✗ ${nombre} falló: ${(e.stdout || '') + (e.stderr || e.message)}`.trim().slice(0, 600));
    return false;
  }
};

if (KEY) {
  paso('1/3 capturar índice y marcadores', 'itf-historico.mjs', ['--capturar']);
  /* --casa se pasa tal cual: con 'betano' la tanda queda solo con sus
     precios, que son los que Sebastián puede jugar de verdad. */
  const CASA = arg('casa', null);
  paso(CASA ? `2/3 cuotas de ${CASA} de los pendientes` : '2/3 cuotas bet365 de los pendientes',
    'itf-cuotas-bet365.mjs', ['--horas', HORAS, ...(MAX ? ['--max', MAX] : []), ...(CASA ? ['--casa', CASA] : [])]);
} else {
  console.log('Sin ODDSPAPI_KEY: solo se rearma la página con lo que hay en disco.');
}
paso(KEY ? '3/4 la página del día' : 'la página del día', 'itf-informe.mjs', ['--bet365']);
paso('4/4 la tabla plana (ordenable y filtrable)', 'itf-tabla.mjs', []);
console.log('\n→ vigia/itf-informe.html (tabla de veredictos + historial) · vigia/itf-veredictos.json');
