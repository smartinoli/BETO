#!/usr/bin/env node
/* ============================================================
   ITF-DIA — la rutina diaria completa, en un comando.

   Lo que Sebastián quiere ver todos los días: quién gana según el
   modelo, con su análisis, y la comparación contra lo que pasó. Esto
   encadena las tres piezas que lo producen:

     1. itf-betano                  las cuotas de Betano de los partidos
                                    por jugar, directo de Betano (desde el
                                    2026-10-11; antes OddsPapi)
     2. itf-informe --bet365        la página: tabla de veredictos,
                                    historial de aciertos modelo contra
                                    mercado, y el detalle por partido
                                    (los resultados salen del CUADRO
                                    oficial, que refresca itf-navegador oop)
     3. itf-tabla                   la tabla plana

   Uso:  node vigia/itf-dia.mjs [--horas 36]
   ============================================================ */
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i > 0 ? process.argv[i + 1] : d };
const HORAS = arg('horas', '36');   /* 36 h: la semana entera, no solo la mañana siguiente (2026-09-22) */

const paso = (nombre, archivo, args = []) => {
  console.log(`\n━━ ${nombre} ━━`);
  try {
    console.log(execFileSync('node', [path.join(DIR, archivo), ...args],
      { encoding: 'utf8', timeout: 35 * 60e3, env: process.env }).trim());
    return true;
  } catch (e) {
    console.log(`✗ ${nombre} falló: ${(e.stdout || '') + (e.stderr || e.message)}`.trim().slice(0, 600));
    return false;
  }
};

paso('1/3 cuotas de Betano', 'itf-betano.mjs', ['--horas', HORAS]);
paso('2/3 la página del día', 'itf-informe.mjs', ['--bet365']);
paso('3/3 la tabla plana (ordenable y filtrable)', 'itf-tabla.mjs', []);
console.log('\n→ vigia/itf-informe.html (tabla de veredictos + historial) · vigia/itf-veredictos.json');
