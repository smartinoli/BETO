#!/usr/bin/env node
/* ============================================================
   ITF-ANALIZAR — aplica las reglas medidas (vigia/itf-saber.json)
   al dossier de la mesa y escribe vigia/itf-analisis.json.

   Reglas que usa, todas medidas sobre nuestros propios datos:
     · ΔWTN < 1.5 → ruido (52-57%, azar): sin lado
     · 1.5-2.5 → 67.7% · 2.5-4 → 71.7% · 4+ → 88.2%
     · si nivel y forma CHOCAN: con Δ<2.5 manda la forma (42%),
       con Δ>=2.5 manda el nivel (63%)
     · valor = p_estimada × cuota − 1, contra el vig de 9% de Betano

   Uso: node vigia/itf-analizar.mjs
   ============================================================ */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const DIR = path.dirname(fileURLToPath(import.meta.url));
const leer = f => { try { return JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')) } catch { return null } };

const dossier = leer('itf-mesa-datos.json');
if (!dossier) { console.error('falta itf-mesa-datos.json: corre antes node vigia/itf-mesa.mjs'); process.exit(1); }

/* sets cedidos por partido, leídos de la trayectoria */
function setsCedidos(t) {
  if (!t) return null;
  let n = 0, p = 0;
  for (const tramo of t.split('·')) {
    const pares = [...tramo.matchAll(/(\d+)(?:\(\d+\))?-(\d+)(?:\(\d+\))?/g)];
    if (!pares.length) continue;
    n++; p += pares.filter(m => +m[2] > +m[1]).length;
  }
  return n ? p / n : null;
}
const banda = d => d >= 4 ? 0.88 : d >= 2.5 ? 0.717 : d >= 1.5 ? 0.677 : null;

const veredictos = {}, conValor = [];
for (const p of dossier.partidos) {
  const l = p.lados;
  let k = null, d = null, choque = null, pe = null;
  if (l[0].wtn && l[1].wtn) {
    d = Math.abs(l[0].wtn - l[1].wtn);
    k = l[0].wtn < l[1].wtn ? 0 : 1;
    const f = l.map(x => setsCedidos(x.llega));
    if (f[0] != null && f[1] != null && f[0] !== f[1]) choque = ((f[0] < f[1] ? 0 : 1) !== k);
    pe = choque ? (d >= 2.5 ? 0.63 : 0.42) : banda(d);
  }
  const c = k != null ? l[k].gana : null;
  const val = (pe && c) ? pe * c - 1 : null;
  if (val != null) conValor.push({ id: p.id, val });

  if (pe == null) {
    veredictos[String(p.id)] = {
      favorito: '—', confianza: 'baja', mercado: 'pasar',
      razon: d != null
        ? `Δ${d.toFixed(2)} de WTN: bajo 1.5 es ruido — ahí el mejor WTN acierta 52-57%, azar. Sin lado.`
        : 'Falta el WTN de alguno de los dos: no se puede comparar nivel.',
      banderas: d != null ? [`Δ${d.toFixed(2)} ruido`] : ['sin datos de nivel'],
    };
    continue;
  }
  const nom = l[k].nombre + (l[k].marca ? ' ' + l[k].marca : '');
  const ban = [`Δ${d.toFixed(2)} ` + (d >= 4 ? 'muy fuerte' : d >= 2.5 ? 'fuerte' : 'moderada')];
  if (choque) ban.push('choque nivel vs forma');
  let razon = `Δ${d.toFixed(2)} de WTN a favor (${l[k].wtn} contra ${l[1 - k].wtn}). `;
  razon += choque
    ? `Choque nivel-contra-forma con brecha ${d >= 2.5 ? 'grande' : 'chica'}: nuestros datos dan ${Math.round(pe * 100)}% a este lado. `
    : `Nivel y forma coinciden: banda del ${Math.round(pe * 100)}%. `;
  let conf, mkt;
  if (c) {
    const imp = 100 / c;
    if (val > 0.10) { razon += `A ${c} el mercado implica ${imp.toFixed(1)}% → valor +${Math.round(val * 100)}%.`; conf = d >= 2.5 ? 'alta' : 'media'; mkt = 'gana'; ban.push('valor de cuota'); }
    else if (val > 0) { razon += `A ${c} implica ${imp.toFixed(1)}% → apenas +${Math.round(val * 100)}%: margen fino.`; conf = 'media'; mkt = 'gana'; ban.push('margen fino'); }
    else { razon += `A ${c} implica ${imp.toFixed(1)}%, sobre nuestra estimación: sin valor.`; conf = 'baja'; mkt = 'pasar'; ban.push('sin valor'); }
  } else {
    razon += 'Betano todavía no abre la línea.'; conf = d >= 2.5 ? 'media' : 'baja'; mkt = 'gana'; ban.push('línea sin abrir');
  }
  veredictos[String(p.id)] = { favorito: mkt === 'pasar' ? '—' : nom, confianza: conf, mercado: mkt, razon, banderas: ban };
}
conValor.sort((a, b) => b.val - a.val);
const destacados = conValor.filter(x => x.val > 0.08).slice(0, 6).map(x => x.id);
fs.writeFileSync(path.join(DIR, 'itf-analisis.json'), JSON.stringify({
  generado: new Date().toISOString(),
  analista: 'agente (Claude) — order of play + cuadros + entry lists (ATP y WTN) + cuotas Betano + reglas medidas de vigia/itf-saber.json',
  titular: 'Valor esperado partido a partido: probabilidad estimada (ΔWTN y choque nivel-forma) contra la que implica cada cuota.',
  advertencia: 'El margen de Betano en ITF es 9%: valor por debajo de eso es ruido. Las reglas del choque salen de muestras chicas (n=27).',
  veredictos, destacados,
}, null, 1));
console.log(`✓ análisis: ${Object.keys(veredictos).length} veredictos, ${destacados.length} destacados`);
for (const x of conValor.slice(0, 5)) {
  const p = dossier.partidos.find(q => q.id === x.id);
  const v = veredictos[String(x.id)];
  console.log(`   ${(x.val * 100).toFixed(1).padStart(6)}%  ${v.favorito}  ${p.torneo}`);
}
