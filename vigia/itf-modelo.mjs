/* ============================================================
   ITF-MODELO — la probabilidad, con las señales que MIDIERON servir.

   Validado siempre dejando un torneo afuera (LOTO) sobre los 1243
   partidos que el veto de junior no saca:

     solo ΔWTN por grupo de rondas         log-loss 0.5097   acierto 74.3%
     + sub-18                              log-loss 0.4801   acierto 76.2%
     + games cedidos + torneo anterior     log-loss 0.4732   acierto 76.5%

   LA EDAD NO ES UNA PENDIENTE, ES UN ESCALÓN EN LOS 18 AÑOS.
   Primero se probó como diferencia lineal de años (0.5072). Mirando la
   edad ABSOLUTA de cada lado aparece que el efecto no es gradual: se
   apaga de golpe a los 19. Contra el rival, año por año, cuánto se
   equivoca la curva de ΔWTN:

     rival de 16   n= 12   ganó el favorito 66.7%   esperaba 86.3%   −19.7
     rival de 17   n= 42                  69.0%              83.2%   −14.2
     rival de 18   n=209                  67.5%              82.2%   −14.8
     rival de 19   n=180                  76.7%              76.5%    +0.2
     rival de 20   n=131                  75.6%              73.3%    +2.2
     rival de 22   n=101                  85.1%              71.5%   +13.6

   Probadas todas las formas, gana el escalón limpio:

     escalón 18 o menos   0.4815   76.1%   ← esta
     rampa bajo 20        0.4822   75.3%
     rampa bajo 19        0.4872   75.2%
     escalón 19 o menos   0.4956   74.7%
     diferencia lineal    0.5072   74.8%

   Y no es el efecto junior disfrazado: sacando TODO partido con un JR en
   cancha el escalón sigue valiendo 0.4798 con coeficiente +1.578.
   Agregarle una pendiente lineal encima no aporta nada (−0.027, mismo
   log-loss), o sea que a partir de 19 la edad deja de decir algo.

   QUÉ SE MIDIÓ Y NO ENTRÓ (cada uno contra la curva de ΔWTN, LOTO):

     ATP              n= 423  aporta 0.003 solo, y nada sobre el núcleo.
                              Correlaciona 0.58 con el ΔWTN: dice casi lo
                              mismo con un tercio de los datos.
     ranking ITF      n= 570  coeficiente NEGATIVO (−0.074): ruido.
     ranking nacional n= 501  coeficiente NEGATIVO (−0.092): ruido.
     sembrado         n=1252  con el sub-18 adentro no aporta (0.4801 sin
                              él, 0.4806 con él).
     tipo de entrada  n= 253  el rival invitado (WC) rinde 5.2 puntos
                              sobre lo esperado (n=117), pero metido al
                              modelo no mueve el log-loss (0.4803).
     insignia ProZone n=  21  nada, ya estaba descartado.
     categoría M15/M25       M15 −0.4 pts, M25 +1.4 pts. Nada.
     superficie              Clay +0.5, Hard −0.7. Nada.
     mismo país              −1.0 contra +0.7. Nada.

   TODO ES SIMÉTRICO Y SIN CONSTANTE: cada señal entra como diferencia
   (favorito − rival) y la curva pasa por 50% cuando todas son cero. Sin
   eso el modelo fabrica ventaja en los partidos más parejos, que es lo
   que ya nos pasó una vez con un intercepto libre.
   ============================================================ */

export const GRUPO = {
  Q1: 'Q1', Q2: 'buenas', R1: 'buenas', Q3: 'medias', R2: 'medias',
  R3: 'medias', R4: 'medias', QF: 'finales', SF: 'finales', F: 'finales',
};

/* La edad a la que se apaga el efecto. 18 o menos = el rating va atrasado
   respecto de lo que juega hoy; 19 en adelante, la curva ya no se equivoca. */
export const EDAD_CRIA = 18;

export const MODELO = {
  /* Refit 2026-08-28 al sumar la señal LOCAL (jugar en tu país vale ~0.5
     puntos de WTN; LOTO mejora de 0.4801 a 0.4787). El resto casi no se
     movió, señal de que "local" es información nueva y no un reacomodo. */
  pendiente: { Q1: 0.4157, buenas: 0.4782, medias: 0.3166, finales: 0.1746 },
  sub18: +1.6256,       /* uno de los dos tiene 18 o menos y el otro no */
  cedidos: +2.9242,     /* fracción de games cedidos en el cuadro: rival menos favorito */
  previo: +0.2774,      /* ronda alcanzada en el torneo anterior, favorito menos rival */
  local: +0.2460,       /* jugar en tu propio país (40% de los partidos son local-visita) */
};

export const N_GRUPO = { Q1: 422, buenas: 528, medias: 214, finales: 79 };
export const N_COND = { cedidos: 454, previo: 164 };

const sig = x => 1 / (1 + Math.exp(-x));
const edadDe = p => p?.nacido != null ? 2026 - p.nacido : null;

/* Ronda alcanzada en el torneo anterior, como número comparable.
   0 = solo ganó en quali · 1..6 = R1…final del cuadro principal. */
export const ORDEN_PREVIO = { Q1: 0, Q2: 0, Q3: 0, R1: 1, R2: 2, R3: 3, QF: 4, SF: 5, F: 6, campeón: 6 };
export function numPrevio(previo) {
  if (previo == null) return null;
  if (typeof previo === 'number') return previo;
  const r = previo.ronda ?? previo;
  return ORDEN_PREVIO[String(r)] ?? null;
}

/* fav y riv son fichas ya orientadas: fav es el de MEJOR WTN.
   Devuelve la probabilidad de que gane fav y el desglose de cuánto aportó
   cada señal, que es lo que después se muestra y se audita. */
export function probabilidad(fav, riv, ronda, paisTorneo) {
  const grupo = GRUPO[ronda] || 'medias';
  const dW = riv.wtn - fav.wtn;
  const partes = [];
  let eta = MODELO.pendiente[grupo] * dW;
  partes.push({ nombre: 'nivel', valor: dW, aporte: eta,
    texto: `Δ${dW.toFixed(2)} de WTN en ${ronda} (grupo "${grupo}", n=${N_GRUPO[grupo]})` });
  const suma = (nombre, valor, coef, texto) => {
    if (valor == null || !Number.isFinite(valor) || !valor) return;
    const aporte = coef * valor;
    partes.push({ nombre, valor, aporte, texto });
    eta += aporte;
  };

  const eF = edadDe(fav), eR = edadDe(riv);
  if (eF != null && eR != null) {
    const d = (eF <= EDAD_CRIA ? 1 : 0) - (eR <= EDAD_CRIA ? 1 : 0);
    suma('sub18', d, MODELO.sub18, d > 0
      ? `${fav.nombre} tiene ${eF} años: bajo los ${EDAD_CRIA + 1} el WTN va atrasado y el jugador rinde más`
      : `${riv.nombre} tiene ${eR} años, y contra un sub-${EDAD_CRIA + 1} la curva se equivoca ~14 puntos de más`);
  }

  if (fav.cedidos != null && riv.cedidos != null)
    suma('forma', riv.cedidos - fav.cedidos, MODELO.cedidos,
      riv.cedidos > fav.cedidos
        ? `${fav.nombre} viene cediendo menos games (${Math.round(fav.cedidos * 100)}% contra ${Math.round(riv.cedidos * 100)}%)`
        : `${riv.nombre} viene cediendo menos games (${Math.round(riv.cedidos * 100)}% contra ${Math.round(fav.cedidos * 100)}%): la forma contradice al nivel`);

  const pF = numPrevio(fav.previo), pR = numPrevio(riv.previo);
  if (pF != null && pR != null)
    suma('previo', pF - pR, MODELO.previo,
      pF > pR ? `${fav.nombre} llegó más lejos en su torneo anterior` : `${riv.nombre} llegó más lejos en su torneo anterior`);

  /* Jugar en casa, medido el 2026-08-28: vale ~0.5 puntos de WTN (un
     local apenas mejor en rating gana 74% donde un favorito parejo
     cualquiera gana 59%). El "viajero de otro continente" no suma nada
     encima: ya está contado dentro de esta señal. */
  if (paisTorneo && fav.pais && riv.pais) {
    const d = (fav.pais === paisTorneo ? 1 : 0) - (riv.pais === paisTorneo ? 1 : 0);
    suma('local', d, MODELO.local, d > 0
      ? `${fav.nombre} juega en su país (${fav.pais}): la localía vale ~0.5 pts de WTN`
      : `${riv.nombre} juega en su país (${riv.pais}): la localía le suma ~0.5 pts de WTN`);
  }

  return { p: sig(eta), eta, grupo, dW, partes, n: N_GRUPO[grupo] };
}

/* ΔWTN mínimo para llegar a una probabilidad con el resto de las señales
   en cero. Sirve para explicar "por qué no alcanza" en una ronda dada. */
export function dParaLlegar(pObjetivo, ronda) {
  const g = GRUPO[ronda] || 'medias';
  return Math.max(0, Math.log(pObjetivo / (1 - pObjetivo)) / MODELO.pendiente[g]);
}
