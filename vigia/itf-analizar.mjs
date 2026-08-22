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

   LA RONDA MANDA (medido 2026-08-22 sobre 744 partidos con WTN y resultado).
   El cuadro filtra: la Δ mediana cae de 3.49 en qualis a 1.96 en cuartos, o
   sea que para las rondas finales casi todos los partidos ya cayeron en la
   banda de ruido. El acierto del mejor WTN sigue esa curva:
     QUALI 74.6% (n=393) · R1 77.4% (n=199) · R2 73.2% (n=97) · QF 57.4% (n=47)
   Agrupado: temprano (Q+R1+R2) 75.2% n=689 contra tarde (QF+SF+F) 56.4% n=55,
   intervalos que no se tocan. En rondas finales el ATP incluso le gana al WTN
   (63.5% contra 55.8%, n=52). Ahí no hay lado: hay que esperar R1 y qualis.

   FRENOS. Uno solo es veto duro, y es por calidad de dato:
     1. VETO — rival sin ranking ATP o junior: su WTN mide partidos viejos y
        atrasa cuando el jugador sube rapido (Behrmann, JR sin ATP, WTN 13.28,
        le gano 6-1 6-0 al [5] en Mistelbach). Un Δ grande contra el no prueba
        nada porque el numero mismo no vale.
     2. BANDERA — ATP contra WTN por mas de 400 puestos: nuestras dos senales
        discrepan y el backtest no distingue cual manda. Baja la confianza.
     3. BANDERA — residuo del mercado bajo -0.15 sobre su modelo
        logit(p) = -0.081 + 0.183·ΔWTN (R²=0.626): el mercado ve algo que no
        tenemos. Pero NO es veto: Borg [1] tenia residuo -0.205 y gano 6-3 7-5
        el 2026-08-22. Se muestra y baja la confianza; decide quien mira.

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

/* Probabilidad por banda de Δ, separada por etapa del cuadro. */
const BANDAS = {
  temprano: { nota: 'Q+R1+R2, n=689', p: d => d >= 4 ? 0.886 : d >= 2.5 ? 0.716 : d >= 1.5 ? 0.682 : null },
  /* Muestras chicas (n=11 y n=24): se usan encogidas hacia 50% y nunca dan
     confianza alta. En rondas finales lo medido es 56.4% global. */
  tarde: { nota: 'QF+SF+F, n=55', p: d => d >= 2.5 ? 0.63 : d >= 1.5 ? 0.60 : null },
};
const esTarde = r => /Quarter|Semi|Final/i.test(r || '') && !/1st|2nd|3rd/i.test(r || '');
const banda = (d, tarde) => (tarde ? BANDAS.tarde : BANDAS.temprano).p(d);
const sig = x => 1 / (1 + Math.exp(-x));
/* Precio que el mercado DEBERÍA poner según su propio modelo ajustado. */
const pMercadoModelo = d => sig(-0.081 + 0.183 * d);

const veredictos = {}, conValor = [];
for (const p of dossier.partidos) {
  const l = p.lados;
  const tarde = esTarde(p.ronda);
  let k = null, d = null, choque = null, pe = null;
  if (l[0].wtn && l[1].wtn) {
    d = Math.abs(l[0].wtn - l[1].wtn);
    k = l[0].wtn < l[1].wtn ? 0 : 1;
    const f = l.map(x => setsCedidos(x.llega));
    if (f[0] != null && f[1] != null && f[0] !== f[1]) choque = ((f[0] < f[1] ? 0 : 1) !== k);
    pe = choque ? (d >= 2.5 ? 0.63 : 0.42) : banda(d, tarde);
    /* En rondas finales el choque tampoco sostiene: se encoge hacia el azar. */
    if (tarde && choque) pe = 0.5 + (pe - 0.5) * 0.5;
  }

  /* ---- un veto duro (dato roto) + banderas que solo bajan la confianza ---- */
  const vetos = [], avisos = [];
  if (k != null) {
    const yo = l[k], otro = l[1 - k];
    if (otro.atp == null || /JR/i.test(otro.marca || ''))
      vetos.push(`el WTN de ${otro.nombre} (${otro.wtn}) no es confiable: ${otro.atp == null ? 'sin ranking ATP' : 'junior'}, su rating mide partidos viejos y llega ${gamesCedidos(otro.llega) != null ? 'cediendo el ' + Math.round(gamesCedidos(otro.llega) * 100) + '% de los games' : 'sin datos de forma'}`);
    if (yo.atp != null && otro.atp != null && otro.atp < yo.atp - 400)
      avisos.push(`el ATP dice lo contrario que el WTN (${yo.atp} contra ${otro.atp}, ${yo.atp - otro.atp} puestos)${tarde ? ' — y en rondas finales el ATP acierta mas que el WTN' : ''}`);
    const cA = yo.gana, cB = otro.gana;
    if (cA && cB) {
      const devig = (1 / cA) / ((1 / cA) + (1 / cB));
      const res = devig - pMercadoModelo(d);
      if (res < -0.15)
        avisos.push(`el mercado lo paga a ${cA} (${Math.round(devig * 100)}% real) cuando su propio modelo por ΔWTN daria ${Math.round(pMercadoModelo(d) * 100)}%: ${Math.round(-res * 100)} puntos que no vemos`);
    }
    if (huboRetiro(otro.llega)) avisos.push(`${otro.nombre} gano un partido por retiro: llega mas fresco`);
    if (tarde) avisos.push('ronda final: el cuadro ya filtro y el WTN cae a 56% (n=55)');
  }

  const c = k != null ? l[k].gana : null;
  const val = (pe && c && !vetos.length) ? pe * c - 1 : null;
  if (val != null) conValor.push({ id: p.id, val });

  if (pe != null && vetos.length) {
    veredictos[String(p.id)] = {
      favorito: '—', confianza: 'baja', mercado: 'pasar',
      razon: `El ΔWTN de ${d.toFixed(2)} apunta a ${l[k].nombre}, pero el numero no sirve: ${vetos.join('; ')}.`,
      banderas: ['veto: dato no confiable'],
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
  for (const a of avisos) ban.push('ojo: ' + a.split(':')[0].split(' —')[0]);
  let razon = `Δ${d.toFixed(2)} de WTN a favor (${l[k].wtn} contra ${l[1 - k].wtn}), ${tarde ? 'en ronda final' : 'en ronda temprana'}. `;
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
  if (avisos.length) {
    razon += ` Con reparos: ${avisos.join('; ')}.`;
    conf = avisos.length >= 2 ? 'baja' : conf === 'alta' ? 'media' : 'baja';
  }
  veredictos[String(p.id)] = { favorito: mkt === 'pasar' ? '—' : nom, confianza: conf, mercado: mkt, razon, banderas: ban };
}
conValor.sort((a, b) => b.val - a.val);
const destacados = conValor.filter(x => x.val > 0.08).slice(0, 6).map(x => x.id);
const vetados = Object.values(veredictos).filter(v => v.banderas.some(b => b.startsWith('veto'))).length;
const conReparos = Object.values(veredictos).filter(v => v.banderas.some(b => b.startsWith('ojo'))).length;
fs.writeFileSync(path.join(DIR, 'itf-analisis.json'), JSON.stringify({
  generado: new Date().toISOString(),
  analista: 'agente (Claude) — order of play + cuadros + entry lists (ATP y WTN) + cuotas Betano + reglas medidas de vigia/itf-saber.json',
  titular: 'Valor esperado partido a partido, con la probabilidad ajustada por etapa del cuadro: el WTN acierta 75% en qualis/R1/R2 y solo 56% de cuartos en adelante.',
  advertencia: 'El margen de Betano en ITF es 9%: valor por debajo de eso es ruido. Las rondas finales son el peor terreno para estas señales — el cuadro ya filtro y las Δ se achican. Los "ojo:" son reparos, no vetos: bajan la confianza pero el partido sigue en la lista (Borg tenia el reparo del mercado y gano).',
  veredictos, destacados,
}, null, 1));
console.log(`✓ análisis: ${Object.keys(veredictos).length} veredictos, ${destacados.length} destacados, ${vetados} vetados, ${conReparos} con reparos`);
for (const x of conValor.slice(0, 5)) {
  const p = dossier.partidos.find(q => q.id === x.id);
  console.log(`   ${(x.val * 100).toFixed(1).padStart(6)}%  ${veredictos[String(x.id)].favorito}  ${p.torneo}`);
}
