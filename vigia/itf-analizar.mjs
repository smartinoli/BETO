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
/* Las categorias murieron el 2026-08-26: un umbral elegido sobre 52
   partidos no es una conclusion. Se destaca lo que mas rinde SI nuestro
   modelo tiene razon, que es lo unico que depende de nosotros. */
const destacados = conValor.slice(0, 6).map(x => x.id);
const cuenta = t => Object.values(veredictos).filter(v => v.tipo === t).length;

fs.writeFileSync(path.join(DIR, 'itf-analisis.json'), JSON.stringify({
  generado: new Date().toISOString(),
  analista: 'agente (Claude) — cuotas Betano como universo + cuadros + entry lists + historial por jugador + modelo multi-senal (itf-modelo.mjs) y juicio contra el mercado (itf-reglas.mjs)',
  titular: 'La probabilidad ya no sale solo del WTN: entran edad, siembra, games cedidos en el cuadro y hasta donde llego en el torneo anterior. Validado dejando un torneo afuera sobre 1243 partidos: log-loss 0.4967 y 75.5% de acierto contra 0.5097 y 74.3% del modelo anterior.',
  advertencia: 'NO hay ventaja demostrada sobre el mercado. Medido el 2026-08-26 sobre los 52 partidos con precio y resultado, el mercado le gana al modelo (log-loss 0.5220 contra 0.5485), y el hallazgo del escalon sub-19 resulta que el precio ya lo tenia (decia 64%, paso 67%, nuestra curva vieja decia 83%). Lo unico medido son tres alertas: favorito por WTN sobre cuota 1.50 (-17% y -69%), partido parejo con dWTN bajo 2 (el precio decia 58%, paso 43%), y junior top 60. El resto es ruido con 52 partidos.',
  veredictos, destacados,
}, null, 1));

console.log(`✓ análisis: ${Object.keys(veredictos).length} veredictos — ` +
  `${cuenta('mira')} con lado, ${cuenta('flojo')} flojos, ` +
  `${cuenta('sin-precio')} sin precio, ${cuenta('fuera')} sin datos o vetados`);
for (const x of conValor.slice(0, 6))
  console.log(`   ${(x.val * 100).toFixed(1).padStart(6)}%  ${String(x.tipo).padEnd(9)} ${veredictos[String(x.id)].favorito}  ${x.torneo || ''}`);
