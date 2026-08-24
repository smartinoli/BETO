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
const destacados = conValor.filter(x => x.tipo === 'segura' || x.tipo === 'anomalia').map(x => x.id);
const cuenta = t => Object.values(veredictos).filter(v => v.tipo === t).length;

fs.writeFileSync(path.join(DIR, 'itf-analisis.json'), JSON.stringify({
  generado: new Date().toISOString(),
  analista: 'agente (Claude) — order of play + cuadros + entry lists (ATP y WTN) + cuotas Betano/bet365 + reglas medidas (itf-reglas.mjs)',
  titular: 'Valor esperado partido a partido, con la probabilidad de la RONDA EXACTA: el WTN no acierta lo mismo en Q1 (75%) que en Q2 o R1 (79% y 77%) que en cuartos (60%) o semis (50%).',
  advertencia: 'El margen de Betano en ITF es 9%: por eso la cuota minima de cada banda es 1.09/p y no 1/p. Los "ojo:" son reparos, no vetos: bajan la confianza pero el partido sigue en la lista (Borg tenia el reparo del mercado y gano 6-3 6-5).',
  veredictos, destacados,
}, null, 1));

console.log(`✓ análisis: ${Object.keys(veredictos).length} veredictos — ` +
  `${cuenta('segura')} seguras, ${cuenta('anomalia')} anomalías, ${cuenta('mirar')} a mirar, ` +
  `${cuenta('sin-precio')} sin precio, ${cuenta('pasar')} descartados`);
for (const x of conValor.slice(0, 6))
  console.log(`   ${(x.val * 100).toFixed(1).padStart(6)}%  ${String(x.tipo).padEnd(9)} ${veredictos[String(x.id)].favorito}  ${x.torneo || ''}`);
