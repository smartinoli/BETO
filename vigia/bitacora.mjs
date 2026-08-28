#!/usr/bin/env node
/* ============================================================
   BITÁCORA — inyecta la foto del bot (live.json) en el template
   de la página viva (bitacora.tpl.html) y escribe el HTML listo
   para publicar como artefacto.

   El template lleva TODO el comportamiento (render, filtros, botones
   de barrer/actualizar vía el conector de GitHub); acá solo se
   embebe el seed para que la página pinte algo aun sin conector.

   Uso: node vigia/bitacora.mjs [live.json] [salida.html]
        (por defecto: vigia/live.json → vigia/bitacora.html)
   ============================================================ */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const livePath = process.argv[2] || path.join(DIR, 'live.json');
const salida = process.argv[3] || path.join(DIR, 'bitacora.html');

const live = JSON.parse(fs.readFileSync(livePath, 'utf8'));
const tpl = fs.readFileSync(path.join(DIR, 'bitacora.tpl.html'), 'utf8');

const marca = '/*__SEED__*/null';
if (!tpl.includes(marca)) { console.error('el template no tiene la marca __SEED__'); process.exit(1); }
/* < evita que un "</script>" dentro de los datos rompa la página */
const seed = JSON.stringify(live).replace(/</g, '\\u003c');
fs.writeFileSync(salida, tpl.replace(marca, seed));
console.log('bitácora generada:', salida, '·', live.historico.length, 'históricas ·',
  (live.corrida?.senales || []).length, 'de la corrida ·', Math.round(fs.statSync(salida).size / 1024) + 'KB');
