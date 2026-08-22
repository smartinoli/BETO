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

   VETOS (medidos 2026-08-22, ver "modeloDelMercado" en el saber).
   El modelo del mercado es logit(p) = −0.081 + 0.183·ΔWTN con R²=0.626:
   el ΔWTN explica dos tercios del precio, un tercio se le escapa. Cuando
   la cuota real se aleja mucho de lo que ese modelo predice, NO estamos
   ante una cuota mal puesta: estamos dentro del tercio que no vemos. El
   analizador viejo leía justamente esa distancia como "valor" y por eso
   proponía como mejores apuestas los partidos donde más ciego estaba.
   Tres frenos:
     1. WTN no confiable: rival sin ranking ATP o junior → su WTN atrasa
        (mide partidos viejos). Un Δ grande contra él no prueba nada.
     2. ATP contradice al WTN por más de 400 puestos → nuestras dos señales
        no coinciden y el backtest no distingue cuál manda (71% vs 66%,
        intervalos superpuestos). Sin lado.
     3. Residuo del mercado < −0.15 → el mercado sabe algo que no tenemos.
   Uso: node vigia/itf-analizar.mjs
   ============================================================ */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const DIR = path.dirname(fileURLToPath(import.meta.url));
const leer = f => { try { return JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')) } catch { return null } };

const dossier = leer('itf-mesa-datos.json');
if (!dossier) { console.error('falta itf-mesa-datos.json: corre antes node vigia/itf-mesa.mjs'); process.exit(1); }

/* Cada tramo de la trayectoria ("R1✓ 6-4 6-0 vJR") en sets y games. */
function tramos(t) {
  if (!t) return [];
  const out = [];
  for (const tr of t.split('·')) {
    const pares = [...tr.matchAll(/(\d+)(?:\(\d+\))?-(\d+)(?:\(\d+\))?/g)].map(m => [+m[1], +m[2]]);
    if (pares.length) out.push(pares);
  }
  return out;
}
/* sets cedidos por partido */
function setsCedidos(t) {
  const ts = tramos(t);
  if (!ts.length) return null;
  return ts.reduce((n, p) => n + p.filter(([a, b]) => b > a).length, 0) / ts.length;
}
/* Proporción de games cedidos: la forma que el mercado parece leer.
   Lithen llegó a la semi de Bastad cediendo 12 games en 3 partidos. */
function gamesCedidos(t) {
  const ts = tramos(t);
  let g = 0, c = 0;
  for (const p of ts) for (const [a, b] of p) { g += a; c += b; }
  return (g + c) ? c / (g + c) : null;
}
/* Un set sin terminar ("6-3 2-0") es un retiro del rival: llega más fresco. */
function huboRetiro(t) {
  for (const p of tramos(t)) {
    const [a, b] = p[p.length - 1];
    if (Math.max(a, b) < 6) return true;
  }
  return false;
}

const banda = d => d >= 4 ? 0.88 : d >= 2.5 ? 0.717 : d >= 1.5 ? 0.677 : null;
const sig = x => 1 / (1 + Math.exp(-x));
/* Precio que el mercado DEBERÍA poner según su propio modelo ajustado. */
const pMercadoModelo = d => sig(-0.081 + 0.183 * d);

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

  /* ---- vetos: casos donde nuestras señales no sirven ---- */
  const vetos = [];
  if (k != null) {
    const yo = l[k], otro = l[1 - k];
    if (otro.atp == null || /JR/i.test(otro.marca || ''))
      vetos.push(`el WTN de ${otro.nombre} (${otro.wtn}) no es confiable: ${otro.atp == null ? 'sin ranking ATP' : 'junior'}, su rating mide partidos viejos y llega ${gamesCedidos(otro.llega) != null ? 'cediendo el ' + Math.round(gamesCedidos(otro.llega) * 100) + '% de los games' : 'sin datos de forma'}`);
    if (yo.atp != null && otro.atp != null && otro.atp < yo.atp - 400)
      vetos.push(`el ATP dice lo contrario que el WTN (${yo.atp} contra ${otro.atp}, ${yo.atp - otro.atp} puestos) y nuestro backtest no distingue cuál manda`);
    const cA = yo.gana, cB = otro.gana;
    if (cA && cB) {
      const devig = (1 / cA) / ((1 / cA) + (1 / cB));
      const res = devig - pMercadoModelo(d);
      if (res < -0.15)
        vetos.push(`el mercado lo paga a ${cA} (${Math.round(devig * 100)}% real) cuando su propio modelo por ΔWTN daría ${Math.round(pMercadoModelo(d) * 100)}%: ${Math.round(-res * 100)} puntos de diferencia, información que no tenemos`);
    }
    if (huboRetiro(otro.llega)) vetos.push(`${otro.nombre} llega más fresco: ganó un partido por retiro`);
  }

  const c = k != null ? l[k].gana : null;
  const val = (pe && c && !vetos.length) ? pe * c - 1 : null;
  if (val != null) conValor.push({ id: p.id, val });

  if (pe != null && vetos.length) {
    veredictos[String(p.id)] = {
      favorito: '—', confianza: 'baja', mercado: 'pasar',
      razon: `El ΔWTN de ${d.toFixed(2)} apunta a ${l[k].nombre}, pero hay que descartarlo: ${vetos.join('; ')}. Cuando el mercado se aparta tanto de nuestro modelo, el que está ciego es el modelo, no la cuota.`,
      banderas: ['veto: ' + (vetos.length > 1 ? vetos.length + ' señales en contra' : 'señal en contra')],
    };
    continue;
  }
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
const vetados = Object.values(veredictos).filter(v => v.banderas.some(b => b.startsWith('veto'))).length;
fs.writeFileSync(path.join(DIR, 'itf-analisis.json'), JSON.stringify({
  generado: new Date().toISOString(),
  analista: 'agente (Claude) — order of play + cuadros + entry lists (ATP y WTN) + cuotas Betano + reglas medidas de vigia/itf-saber.json',
  titular: destacados.length
    ? 'Valor esperado partido a partido, ya descontando los partidos donde el mercado se aparta de nuestro modelo.'
    : 'Sin lado hoy: todos los partidos con ΔWTN suficiente caen en un veto. Ninguno pasa el filtro.',
  advertencia: 'El margen de Betano en ITF es 9%: valor por debajo de eso es ruido. Un ΔWTN grande contra un jugador sin ranking ATP no es señal, y una cuota lejos de nuestro modelo es ceguera nuestra, no error del mercado.',
  veredictos, destacados,
}, null, 1));
console.log(`✓ análisis: ${Object.keys(veredictos).length} veredictos, ${destacados.length} destacados, ${vetados} vetados`);
for (const x of conValor.slice(0, 5)) {
  const p = dossier.partidos.find(q => q.id === x.id);
  console.log(`   ${(x.val * 100).toFixed(1).padStart(6)}%  ${veredictos[String(x.id)].favorito}  ${p.torneo}`);
}
