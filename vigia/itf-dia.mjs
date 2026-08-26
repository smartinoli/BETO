#!/usr/bin/env node
/* ============================================================
   ITF-DIA — la rutina diaria completa, en un comando.

   Lo que Sebastián quiere ver todos los días: quién gana según el
   modelo, con su análisis, y la comparación contra lo que pasó. Esto
   encadena las tres piezas que lo producen:

     1. itf-historico --capturar    el índice del día en OddsPapi — y de
                                    paso refresca los MARCADORES de ayer,
                                    que es con lo que se califican los
                                    veredictos pendientes
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
const MAX = arg('max', '60');
const KEY = process.env.ODDSPAPI_KEY;

const paso = (nombre, archivo, args = []) => {
  console.log(`\n━━ ${nombre} ━━`);
  try {
    console.log(execFileSync('node', [path.join(DIR, archivo), ...args],
      { encoding: 'utf8', timeout: 15 * 60e3, env: process.env }).trim());
    return true;
  } catch (e) {
    console.log(`✗ ${nombre} falló: ${(e.stdout || '') + (e.stderr || e.message)}`.trim().slice(0, 600));
    return false;
  }
};

if (KEY) {
  paso('1/3 capturar índice y marcadores', 'itf-historico.mjs', ['--capturar']);
  paso('2/3 cuotas bet365 de los pendientes', 'itf-cuotas-bet365.mjs', ['--max', MAX]);
} else {
  console.log('Sin ODDSPAPI_KEY: solo se rearma la página con lo que hay en disco.');
}
paso(KEY ? '3/3 la página del día' : 'la página del día', 'itf-informe.mjs', ['--bet365']);
console.log('\n→ vigia/itf-informe.html (tabla de veredictos + historial) · vigia/itf-veredictos.json');
