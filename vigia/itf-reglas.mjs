#!/usr/bin/env node
/* ============================================================
   ITF-REGLAS — el juicio sobre un partido, en un solo lugar.

   Aplica las reglas MEDIDAS de vigia/itf-saber.json. Lo usan tanto la
   mesa de próximos como el historial, para que nunca se separen el
   veredicto que se muestra y el que se mide después.

   Las tres reglas que mandan, por orden de fuerza:
     1. ETAPA del cuadro (n=744): el mejor WTN acierta 75.2% en
        qualis/R1/R2 y 56.4% de cuartos en adelante. El cuadro filtra:
        la Δ mediana cae de 3.49 en qualis a 1.96 en cuartos.
     2. Δ de WTN por bandas: bajo 1.5 es ruido (52-57%, azar).
     3. Choque nivel-contra-forma: con Δ<2.5 manda la forma (42%),
        con Δ≥2.5 manda el nivel (63%).

   Un VETO (el rating no vale) anula el veredicto. Los REPAROS solo
   bajan la confianza y dejan el partido a la vista: el veto por
   residuo de mercado mató a Borg [1], que ganó 6-3 7-5 el 2026-08-22.
   ============================================================ */

/* ---------- lectura de marcadores ---------- */
/* "R1✓ 6-4 6-0 vJR · R2✓ 6-3 6-2 vQ" → [[[6,4],[6,0]], [[6,3],[6,2]]] */
export function tramos(t) {
  if (!t) return [];
  const out = [];
  for (const tr of String(t).split('·')) {
    const pares = [...tr.matchAll(/(\d+)(?:\(\d+\))?-(\d+)(?:\(\d+\))?/g)].map(m => [+m[1], +m[2]]);
    if (pares.length) out.push(pares);
  }
  return out;
}
export function setsCedidos(t) {
  const ts = tramos(t);
  return ts.length ? ts.reduce((n, p) => n + p.filter(([a, b]) => b > a).length, 0) / ts.length : null;
}
/* Proporción de games cedidos: la dominancia que el mercado parece leer.
   Hallquist Lithen llegó a la semi de Båstad cediendo 12 games en 3 partidos
   y el mercado lo puso sobre Leo Borg [1] pese a peor ATP y peor WTN. */
export function gamesCedidos(t) {
  let g = 0, c = 0;
  for (const p of tramos(t)) for (const [a, b] of p) { g += a; c += b; }
  return (g + c) ? c / (g + c) : null;
}
/* Un set sin terminar ("6-3 2-0") es un retiro del rival: llegó más fresco. */
export function huboRetiro(t) {
  for (const p of tramos(t)) { const [a, b] = p[p.length - 1]; if (Math.max(a, b) < 6) return true; }
  return false;
}

/* ---------- etapa y bandas ---------- */
/* El order of play usa nombres largos ("Semi-final") y códigos cortos
   ("F", "SF"); sin los cortos las FINALES caían en la banda temprana. */
export const esTarde = r => /^(f|sf|qf)$/i.test(String(r || '').trim())
  || (/Quarter|Semi|Final/i.test(r || '') && !/1st|2nd|3rd/i.test(r || ''));

export const BANDAS = {
  temprano: { nota: 'qualis, R1 y R2 · n=689 · 75.2%', p: d => d >= 4 ? 0.886 : d >= 2.5 ? 0.716 : d >= 1.5 ? 0.682 : null },
  /* muestras chicas (n=11 y n=24), encogidas hacia 50%: en rondas finales
     lo medido es 56.4% global y el ATP incluso le gana al WTN */
  tarde: { nota: 'cuartos en adelante · n=55 · 56.4%', p: d => d >= 2.5 ? 0.63 : d >= 1.5 ? 0.60 : null },
};
export const banda = (d, tarde) => (tarde ? BANDAS.tarde : BANDAS.temprano).p(d);
const sig = x => 1 / (1 + Math.exp(-x));
/* Precio que el mercado DEBERÍA poner según su propio modelo ajustado
   (logit p = -0.081 + 0.183·ΔWTN, R²=0.626 sobre cuotas desvigadas). */
export const pMercadoModelo = d => sig(-0.081 + 0.183 * d);

/* ---------- el juicio ----------
   lado: { nombre, marca, atp, wtn, wtnVisible, gana, llega }
   Devuelve { favorito, confianza, mercado, razon, banderas, val, pe, d, k } */
export function analizar(p) {
  const l = p.lados || [];
  const tarde = esTarde(p.ronda);
  const etapa = tarde ? 'ronda final' : 'ronda temprana';
  if (l.length !== 2 || l[0].wtn == null || l[1].wtn == null)
    return { favorito: '—', confianza: 'baja', mercado: 'pasar', val: null, d: null,
      razon: 'Falta el WTN de alguno de los dos: no se puede comparar nivel.', banderas: ['sin datos de nivel'] };

  const d = Math.abs(l[0].wtn - l[1].wtn);
  const k = l[0].wtn < l[1].wtn ? 0 : 1;
  const yo = l[k], otro = l[1 - k];
  const f = l.map(x => setsCedidos(x.llega));
  const choque = (f[0] != null && f[1] != null && f[0] !== f[1]) ? ((f[0] < f[1] ? 0 : 1) !== k) : null;
  let pe = choque ? (d >= 2.5 ? 0.63 : 0.42) : banda(d, tarde);
  if (tarde && choque) pe = 0.5 + (pe - 0.5) * 0.5;   /* en finales el choque tampoco sostiene */

  /* --- veto duro: el número mismo no vale --- */
  const vetos = [];
  if (otro.wtnVisible === false)
    vetos.push(`ITF no publica el WTN de ${otro.nombre} (insignia ProZone): su propio rating está marcado como no mostrable`);
  /* Medido el 2026-08-23 sobre 778 partidos, y me hizo corregir el veto
     anterior: contra JUNIORES el mejor WTN acierta 31.3% (n=16) contra
     79.9% del resto — se da vuelta, porque el rating de un junior que
     mejora rapido va atrasado. Pero "sin ranking ATP" resulto ser lo
     CONTRARIO de lo que asumi por el caso Behrmann: con el rival sin ATP
     el WTN acierta 81.1% (n=334) contra 74.7% con ambos rankeados, y con
     Δ>=4 sube a 89.5%. Tenia las dos condiciones juntas y la que mandaba
     era la de junior. Vetar por falta de ATP mataba justo las qualis, que
     es donde el metodo funciona. */
  if (otro.jr || /JR/i.test(otro.marca || ''))
    vetos.push(`${otro.nombre} es junior: contra juniores el mejor WTN acierta 31% (n=16), se da vuelta${gamesCedidos(otro.llega) != null ? `, y llega cediendo el ${Math.round(gamesCedidos(otro.llega) * 100)}% de los games` : ''}`);
  if (vetos.length)
    return { favorito: '—', confianza: 'baja', mercado: 'pasar', val: null, d, k,
      razon: `El ΔWTN de ${d.toFixed(2)} apunta a ${yo.nombre}, pero el número no sirve: ${vetos.join('; ')}.`,
      banderas: ['veto: dato no confiable'] };

  if (pe == null)
    return { favorito: '—', confianza: 'baja', mercado: 'pasar', val: null, d, k,
      razon: `Δ${d.toFixed(2)} de WTN en ${etapa}: bajo 1.5 es ruido — ahí el mejor WTN acierta 52-57%, azar. Sin lado.`,
      banderas: [`Δ${d.toFixed(2)} ruido`] };

  /* --- reparos: bajan la confianza, NO ocultan el partido --- */
  const avisos = [];
  if (otro.atp == null) avisos.push(`${otro.nombre} no tiene ranking ATP (normal en qualis; medido, el WTN ahi acierta MAS: 81% contra 75%)`);
  if (yo.atp != null && otro.atp != null && otro.atp < yo.atp - 400)
    avisos.push(`el ATP dice lo contrario que el WTN (${yo.atp} contra ${otro.atp}, ${yo.atp - otro.atp} puestos)${tarde ? ' — y en rondas finales el ATP acierta más que el WTN' : ''}`);
  if (yo.gana && otro.gana) {
    const devig = (1 / yo.gana) / ((1 / yo.gana) + (1 / otro.gana));
    const res = devig - pMercadoModelo(d);
    if (res < -0.15) avisos.push(`el mercado lo paga a ${yo.gana} (${Math.round(devig * 100)}% real) cuando su propio modelo por ΔWTN daría ${Math.round(pMercadoModelo(d) * 100)}%: ${Math.round(-res * 100)} puntos que no vemos`);
  }
  if (huboRetiro(otro.llega)) avisos.push(`${otro.nombre} ganó un partido por retiro: llega más fresco`);
  if (tarde) avisos.push('ronda final: el cuadro ya filtró y el WTN cae a 56% (n=55)');

  const c = yo.gana;
  const val = c ? pe * c - 1 : null;
  const ban = [`Δ${d.toFixed(2)} ` + (d >= 4 ? 'muy fuerte' : d >= 2.5 ? 'fuerte' : 'moderada')];
  if (choque) ban.push('choque nivel vs forma');
  let razon = `Δ${d.toFixed(2)} de WTN a favor (${yo.wtn} contra ${otro.wtn}), en ${etapa}. `;
  razon += choque
    ? `Choque nivel-contra-forma con brecha ${d >= 2.5 ? 'grande' : 'chica'}: nuestros datos dan ${Math.round(pe * 100)}% a este lado. `
    : `Nivel y forma coinciden: banda del ${Math.round(pe * 100)}% (${tarde ? BANDAS.tarde.nota : BANDAS.temprano.nota}). `;
  let conf, mkt;
  if (c) {
    const imp = 100 / c;
    if (val > 0.10) { razon += `A ${c} el mercado implica ${imp.toFixed(1)}% → valor +${Math.round(val * 100)}%.`; conf = d >= 2.5 ? 'alta' : 'media'; mkt = 'gana'; ban.push('valor de cuota'); }
    else if (val > 0) { razon += `A ${c} implica ${imp.toFixed(1)}% → apenas +${Math.round(val * 100)}%: margen fino.`; conf = 'media'; mkt = 'gana'; ban.push('margen fino'); }
    else { razon += `A ${c} implica ${imp.toFixed(1)}%, sobre nuestra estimación: sin valor.`; conf = 'baja'; mkt = 'pasar'; ban.push('sin valor'); }
  } else { razon += 'Todavía sin línea en Betano ni bet365.'; conf = d >= 2.5 ? 'media' : 'baja'; mkt = 'gana'; ban.push('sin línea'); }
  /* el aviso de "sin ATP" es informativo y va A FAVOR: no baja confianza */
  const enContra = avisos.filter(a => !/no tiene ranking ATP/.test(a));
  if (avisos.length) {
    razon += ` Con reparos: ${avisos.join('; ')}.`;
    if (enContra.length) conf = enContra.length >= 2 ? 'baja' : conf === 'alta' ? 'media' : 'baja';
    for (const a of enContra) ban.push('ojo: ' + a.split(':')[0].split(' —')[0]);
  }
  return { favorito: mkt === 'pasar' ? '—' : yo.nombre + (yo.marca ? ' ' + yo.marca : ''),
    confianza: conf, mercado: mkt, razon, banderas: ban, val, pe, d, k };
}
