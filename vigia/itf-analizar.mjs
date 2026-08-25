#!/usr/bin/env node
/* ============================================================
   ITF-ANALIZAR — corre el juicio sobre el dossier de la mesa y escribe
   vigia/itf-analisis.json, indexado por id de partido.

   NO tiene reglas propias: todas viven en itf-reglas.mjs y las comparte
   con la mesa (itf-proximos.mjs) y la tabla (itf-tabla.mjs). Hasta el
   2026-08-24 este archivo llevaba su PROPIA copia de las bandas, y se
   habia quedado atras: seguia con el par temprano/tarde y con el veto
   por "rival sin ranking ATP", que despues medimos al reves (con el
   rival sin ATP el WTN acierta MAS, 81% contra 75%). Dos copias del
   criterio es exactamente lo que este modulo existe para evitar.

   Uso: node vigia/itf-analizar.mjs
   ============================================================ */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { analizar } from './itf-reglas.mjs';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const leer = f => { try { return JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')) } catch { return null } };

const dossier = leer('itf-proximos-datos.json') || leer('itf-mesa-datos.json');
if (!dossier) { console.error('falta itf-proximos-datos.json: corre antes node vigia/itf-proximos.mjs'); process.exit(1); }

/* El dossier de proximos viene por torneo → etapa → partidos; el viejo
   de mesa venia plano. Se aceptan los dos. */
function partidos(d) {
  if (Array.isArray(d.partidos)) return d.partidos;
  const out = [];
  for (const t of d.torneos || [])
    for (const e of t.etapas || [])
      for (const p of e.pendientes || [])
        out.push({ ...p, ronda: p.etapa, torneo: t.nombre || t.clave });
  return out;
}

const veredictos = {}, conValor = [];
for (const p of partidos(dossier)) {
  const lados = p.lados || [p.yo, p.otro].filter(Boolean);
  const v = p.v || analizar({ lados, ronda: p.ronda || p.etapa });
  veredictos[String(p.id)] = v;
  if (v.precio && v.precio.val != null && v.precio.val > 0)
    conValor.push({ id: p.id, val: v.precio.val, tipo: v.tipo, torneo: p.torneo });
}
conValor.sort((a, b) => b.val - a.val);
/* destacado = las dos vias que definimos con Sebastian, no "el mayor valor":
   un valor alto con banda floja es justamente lo que nos venia fallando */
/* "anomalia" murio el 2026-08-25: era la casilla de mucho valor y mucha
   discrepancia con el mercado, que medida rindio -57%. Ahora se llama
   TRAMPA y no se destaca, se evita. Lo unico que se destaca es lo que se
   juega. */
const destacados = conValor.filter(x => x.tipo === 'segura').map(x => x.id);
const cuenta = t => Object.values(veredictos).filter(v => v.tipo === t).length;

fs.writeFileSync(path.join(DIR, 'itf-analisis.json'), JSON.stringify({
  generado: new Date().toISOString(),
  analista: 'agente (Claude) — cuotas Betano como universo + cuadros + entry lists + historial por jugador + modelo multi-senal (itf-modelo.mjs) y juicio contra el mercado (itf-reglas.mjs)',
  titular: 'La probabilidad ya no sale solo del WTN: entran edad, siembra, games cedidos en el cuadro y hasta donde llego en el torneo anterior. Validado dejando un torneo afuera sobre 1243 partidos: log-loss 0.4967 y 75.5% de acierto contra 0.5097 y 74.3% del modelo anterior.',
  advertencia: 'Lo que decide ya no es el valor p x cuota - 1 sino cuanto DISCREPAMOS con el mercado. Medido sobre 50 partidos con cuota y resultado: sacarle mas de 15 puntos al mercado dio 4 aciertos de 13 y -57%. Por eso "trampa" no es una oportunidad, es la casilla que hay que evitar.',
  veredictos, destacados,
}, null, 1));

console.log(`✓ análisis: ${Object.keys(veredictos).length} veredictos — ` +
  `${cuenta('segura')} seguras, ${cuenta('trampa')} trampas, ${cuenta('mirar')} a mirar, ` +
  `${cuenta('sin-precio')} sin precio, ${cuenta('pasar')} descartados`);
const aMostrar = conValor.filter(x => x.tipo === 'segura').slice(0, 8);
for (const x of (aMostrar.length ? aMostrar : conValor.slice(0, 6)))
  console.log(`   ${(x.val * 100).toFixed(1).padStart(6)}%  ${String(x.tipo).padEnd(9)} ${veredictos[String(x.id)].favorito}  ${x.torneo || ''}`);
