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
    return { tipo: 'pasar', nivel: null, precio: null, favorito: '—', confianza: 'baja', mercado: 'pasar',
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
    return { tipo: 'pasar', nivel: null, precio: null, favorito: '—', confianza: 'baja', mercado: 'pasar',
      razon: `El ΔWTN de ${d.toFixed(2)} apunta a ${yo.nombre}, pero el número no sirve: ${vetos.join('; ')}.`,
      banderas: ['veto: dato no confiable'] };

  if (pe == null)
    return { tipo: 'pasar', nivel: null, precio: null, favorito: '—', confianza: 'baja', mercado: 'pasar',
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

  /* ---------- LAS DOS VIAS ----------
     Definidas con Sebastian el 2026-08-24, porque "gana/pasar" mezclaba dos
     preguntas que necesitan datos distintos: si tenemos favorito (solo WTN
     y etapa) y si el precio lo paga (necesita cuota). Sin cuota la segunda
     no tiene respuesta, y el sistema igual decia "gana" — 131 de 292
     partidos salian asi, leyendose como recomendacion sin serlo.

     SEGURA   el nivel manda y la cuota compensa. Cada banda tiene su cuota
              minima: con 89% de acierto se empata en 1.13 y con 72% en
              1.40, asi que pedir +9% de margen sobre el vig da 1.23 y 1.52.
              Por eso un 1.05 no pasa nunca, ni con el nivel mas fuerte.
     ANOMALIA el mercado nos contradice y paga de mas: nuestro favorito
              cotizado como no favorito. Es la via de multiplicar, y tambien
              la mas incierta — el registro va 1-1 (Borg gano a 2.22,
              Petkovic perdio a 3.40). Se muestra siempre con el reparo.  */
  const c = yo.gana;
  const val = c ? pe * c - 1 : null;
  /* cuota a la que la apuesta empata, y la que deja +9% sobre el margen */
  const cEmpate = 1 / pe, cMinima = 1.09 / pe;
  const fuerza = d >= 4 ? 'muy fuerte' : d >= 2.5 ? 'fuerte' : 'claro';
  const nivel = { fuerza, p: pe, d, favorito: yo.nombre + (yo.marca ? ' ' + yo.marca : ''), tarde, cEmpate, cMinima };

  const ban = [`Δ${d.toFixed(2)} ${fuerza}`];
  if (choque) ban.push('choque nivel vs forma');
  const enContra = avisos.filter(a => !/no tiene ranking ATP/.test(a));
  for (const a of enContra) ban.push('ojo: ' + a.split(':')[0].split(' —')[0]);

  let razon = `Δ${d.toFixed(2)} de WTN a favor (${yo.wtn} contra ${otro.wtn}), en ${etapa}: banda del ${Math.round(pe * 100)}% (${tarde ? BANDAS.tarde.nota : BANDAS.temprano.nota}). `;
  if (choque) razon = razon.replace('banda del', 'choque nivel-contra-forma, banda del');

  /* --- sin cuota: se informa el nivel y nada mas --- */
  if (!c) {
    razon += `Empataria a ${cEmpate.toFixed(2)} y valdria la pena desde ${cMinima.toFixed(2)}. Falta el precio.`;
    if (avisos.length) razon += ` Con reparos: ${avisos.join('; ')}.`;
    return { tipo: 'sin-precio', nivel, precio: null, favorito: nivel.favorito,
      confianza: 'baja', mercado: 'sin precio', razon, banderas: [...ban, 'sin precio'] };
  }

  /* --- con cuota: se decide --- */
  const devig = otro.gana ? (1 / c) / ((1 / c) + (1 / otro.gana)) : 1 / c;
  const residuo = devig - pMercadoModelo(d);
  const esAnomalia = c >= 2.00 && d >= 2.5;      /* nuestro favorito, pagado como no favorito */
  const precio = { cuota: c, cMinima, val, devig, residuo,
    veredicto: val <= 0 ? 'caro' : c < cMinima ? 'justo' : 'barato' };

  if (esAnomalia) {
    razon += `El mercado lo pone de NO favorito a ${c} (${Math.round(devig * 100)}%) cuando nuestra banda dice ${Math.round(pe * 100)}%: ${Math.round(val * 100)}% de valor si tenemos razon. `;
    razon += 'Es la via de multiplicar y la mas incierta: cuando el mercado se aparta tanto suele ver algo que no vemos, y nuestro registro en estos casos va 1-1.';
    if (avisos.length) razon += ` Reparos: ${avisos.join('; ')}.`;
    return { tipo: 'anomalia', nivel, precio, favorito: nivel.favorito,
      confianza: enContra.length ? 'baja' : 'media', mercado: 'gana', razon,
      banderas: [...ban, 'anomalía'] };
  }
  if (val <= 0) {
    razon += `A ${c} el mercado implica ${(100 / c).toFixed(0)}%, por encima de nuestra banda: cuota corta, no compensa.`;
    return { tipo: 'pasar', nivel, precio, favorito: '—', confianza: 'baja', mercado: 'pasar', razon, banderas: [...ban, 'cuota corta'] };
  }
  if (c < cMinima) {
    razon += `A ${c} hay apenas +${Math.round(val * 100)}%: por debajo del margen de la casa (haria falta ${cMinima.toFixed(2)}). Dentro del error de estimacion.`;
    return { tipo: 'pasar', nivel, precio, favorito: '—', confianza: 'baja', mercado: 'pasar', razon, banderas: [...ban, 'margen fino'] };
  }
  /* barato de verdad: candidata a SEGURA si el nivel manda y nada estorba */
  razon += `A ${c} paga sobre la minima de ${cMinima.toFixed(2)}: +${Math.round(val * 100)}% de valor. `;
  const bloqueo = [];
  if (d < 2.5) bloqueo.push('el nivel es solo "claro", no fuerte');
  if (tarde) bloqueo.push('es ronda final, donde el nivel cae a 56%');
  if (enContra.length) bloqueo.push(enContra.length + ' reparo' + (enContra.length > 1 ? 's' : ''));
  if (residuo < -0.15) bloqueo.push('el mercado se aparta ' + Math.round(-residuo * 100) + ' puntos de su propio modelo');
  if (!bloqueo.length) {
    razon += 'Nivel fuerte, ronda temprana y sin reparos.';
    if (avisos.length) razon += ` (${avisos.join('; ')})`;
    return { tipo: 'segura', nivel, precio, favorito: nivel.favorito, confianza: 'alta', mercado: 'gana', razon, banderas: [...ban, 'segura'] };
  }
  razon += `Pero: ${bloqueo.join('; ')}.`;
  if (avisos.length) razon += ` ${avisos.join('; ')}.`;
  return { tipo: 'mirar', nivel, precio, favorito: nivel.favorito, confianza: 'media', mercado: 'gana', razon, banderas: [...ban, 'mirar'] };
}
