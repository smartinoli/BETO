#!/usr/bin/env node
/* ============================================================
   ITF-CICLO — el ciclo completo, en un comando.

   Es lo que se corre cada vez que Sebastian manda los PDF de Betano:
   carga las cuotas, rearma la mesa, la tabla y el semaforo de mercado,
   y cruza contra los resultados que ya estan. Existe para que la rutina
   no dependa de acordarse del orden ni de correr cinco cosas a mano.

     1. itf-cuotas-archivos  carga los PDF/JSON nuevos y verifica cada
                             partido contra el cuadro oficial
     2. itf-informe          EL ANALISIS: una ficha por partido cotizado
     3. itf-proximos         la mesa por torneo
     4. itf-tabla            la tabla esquematica
     5. itf-mercado          ¿el mercado cotiza esta ronda por nivel?
     6. itf-resultados       lo que dijimos contra lo que paso

   NO baja nada de la ITF: para eso esta itf-scrap.mjs, que es lento y
   depende del WAF. Este trabaja con lo que ya hay en disco.

   Uso:  node vigia/itf-ciclo.mjs archivo1.pdf archivo2.pdf ...
         node vigia/itf-ciclo.mjs                 (sin cargar nada nuevo)
   ============================================================ */
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const archivos = process.argv.slice(2).filter(a => !a.startsWith('--'));
const correr = (script, args = []) => {
  try {
    return execFileSync('node', [path.join(DIR, script), ...args], { encoding: 'utf8', maxBuffer: 60e6 });
  } catch (e) {
    console.error(`\n✗ falló ${script}:\n${(e.stdout || '') + (e.stderr || '')}`.slice(0, 1200));
    process.exit(1);
  }
};
const titulo = t => console.log('\n' + t + '\n' + '─'.repeat(t.length));

if (archivos.length) {
  titulo(`1 · CARGAR ${archivos.length} ARCHIVO(S) DE CUOTAS`);
  const s = correr('itf-cuotas-archivos.mjs', archivos);
  /* del cargador interesa el resumen y lo que no se pudo verificar */
  for (const ln of s.split('\n'))
    if (/^\s*[+?]|cuotas nuevas|sin verificar|PROBLEMA|^  [a-z]/.test(ln) && !/^\s*$/.test(ln)) console.log(ln);
} else console.log('(sin archivos nuevos: sólo se recalcula)');

titulo('2 · MESA Y TABLA');
console.log(correr('itf-informe.mjs').trim());
console.log(correr('itf-proximos.mjs').trim());
console.log(correr('itf-tabla.mjs').trim());

titulo('3 · ¿EL MERCADO COTIZA POR NIVEL?');
const mer = correr('itf-mercado.mjs');
console.log(mer.split('R1 PARTIDO A PARTIDO')[0].trim());

titulo('4 · LO QUE DIJIMOS CONTRA LO QUE PASÓ');
const res = correr('itf-resultados.mjs');
console.log(res.split('TODO EL REGISTRO')[0].trim());

titulo('5 · LO QUE EL SISTEMA MARCA AHORA');
console.log(correr('itf-analizar.mjs').trim());

console.log('\n→ vigia/itf-informe.html · vigia/itf-tabla.html · vigia/itf-proximos.html');
