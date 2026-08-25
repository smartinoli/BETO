/* ============================================================
   ITF-MODELO — la probabilidad, con TODAS las señales, no solo el WTN.

   Hasta el 2026-08-25 la estimación era una logística sobre ΔWTN con una
   pendiente por grupo de rondas y nada más. Este módulo la reemplaza por
   un modelo de varias señales, ajustado y validado dejando un torneo
   afuera (LOTO) sobre 1243 partidos:

     solo WTN por grupo                    log-loss 0.5097   acierto 74.3%
     + edad + siembra + forma + previo     log-loss 0.4967   acierto 75.5%

   TODO ES SIMÉTRICO Y SIN CONSTANTE: cada señal entra como diferencia
   (favorito − rival) y la curva pasa por 50% cuando todas son cero. Sin
   eso, el modelo fabrica ventaja en los partidos más parejos, que es
   exactamente lo que ya nos pasó una vez con un intercepto libre.

   QUÉ ENTRÓ Y QUÉ NO — medido cada señal por separado, sobre los partidos
   donde ese dato existe, con LOTO:

     edad             ✓  n=1252  0.5142 → 0.5072   la más fuerte
     games cedidos    ✓  n= 454  aporta sobre el núcleo
     torneo anterior  ✓  n= 164  aporta poco pero aporta
     sembrado         ✓  n=1252  aporta poco
     ATP              ✗  n= 423  aporta SOLO si no está la edad; con edad
                                 adentro empeora (0.5784 → 0.5814). El ATP
                                 estaba diciendo "joven que sube", que es
                                 lo que la edad ya dice mejor y con el
                                 triple de datos.
     ranking ITF      ✗  n= 570  coeficiente NEGATIVO: ruido.
     ranking nacional ✗  n= 562  coeficiente NEGATIVO: ruido.

   LA EDAD ES LO QUE MÁS APORTA, y va al revés de lo que uno diría. El
   jugador JOVEN rinde POR ENCIMA de su WTN y el viejo por debajo, porque
   el rating va atrasado respecto de quien está mejorando:

     favorito 6+ años más joven   real 75.0% (n= 84)   la curva WTN daba 69.0%
     3 a 5 más joven              real 76.2% (n=126)   daba 67.9%
     ±2 años                      real 74.9% (n=506)   daba 71.9%
     3 a 5 más viejo              real 75.5% (n=306)   daba 77.3%
     6+ años más viejo            real 68.3% (n=230)   daba 78.0%

   Y no es cosa de juniores: sacando todo partido con un JR en cancha el
   coeficiente casi no se mueve (−0.0629 contra −0.0646).
   ============================================================ */

export const GRUPO = {
  Q1: 'Q1', Q2: 'buenas', R1: 'buenas', Q3: 'medias', R2: 'medias',
  R3: 'medias', R4: 'medias', QF: 'finales', SF: 'finales', F: 'finales',
};

export const MODELO = {
  /* pendiente sobre ΔWTN, una por grupo de rondas */
  pendiente: { Q1: 0.3157, buenas: 0.4005, medias: 0.2564, finales: 0.1572 },
  /* señales que existen SIEMPRE */
  edad: -0.0646,        /* años del favorito menos años del rival */
  sembrado: +0.1442,    /* 1 si el favorito es cabeza de serie y el rival no */
  /* señales CONDICIONALES: suman solo donde el dato existe */
  cedidos: +2.7488,     /* fracción de games cedidos: rival menos favorito */
  previo: +0.2666,      /* ronda alcanzada en el torneo anterior, favorito menos rival */
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

/* fav y riv son fichas de jugador ya orientadas: fav es el de MEJOR WTN.
   Devuelve la probabilidad de que gane fav, más el desglose de cuánto
   aportó cada señal — que es lo que después se muestra y se audita. */
export function probabilidad(fav, riv, ronda) {
  const grupo = GRUPO[ronda] || 'medias';
  const dW = riv.wtn - fav.wtn;
  const partes = [];
  const suma = (nombre, valor, coef, texto) => {
    if (valor == null || !Number.isFinite(valor) || !valor) return 0;
    const aporte = coef * valor;
    partes.push({ nombre, valor, aporte, texto });
    return aporte;
  };
  let eta = MODELO.pendiente[grupo] * dW;
  partes.push({ nombre: 'nivel', valor: dW, aporte: eta,
    texto: `Δ${dW.toFixed(2)} de WTN en ${ronda} (grupo "${grupo}", n=${N_GRUPO[grupo]})` });

  const eF = edadDe(fav), eR = edadDe(riv);
  if (eF != null && eR != null && eF !== eR)
    eta += suma('edad', eF - eR, MODELO.edad,
      eF < eR ? `${fav.nombre} es ${eR - eF} año${eR - eF > 1 ? 's' : ''} más joven, y el joven rinde sobre su WTN`
              : `${fav.nombre} es ${eF - eR} año${eF - eR > 1 ? 's' : ''} más viejo, y el viejo rinde bajo su WTN`);

  const dS = (fav.seed ? 1 : 0) - (riv.seed ? 1 : 0);
  if (dS) eta += suma('sembrado', dS, MODELO.sembrado,
    dS > 0 ? `${fav.nombre} es cabeza de serie y el rival no` : `el sembrado es ${riv.nombre}, no ${fav.nombre}`);

  if (fav.cedidos != null && riv.cedidos != null && fav.cedidos !== riv.cedidos)
    eta += suma('forma', riv.cedidos - fav.cedidos, MODELO.cedidos,
      riv.cedidos > fav.cedidos
        ? `${fav.nombre} viene cediendo menos games (${Math.round(fav.cedidos * 100)}% contra ${Math.round(riv.cedidos * 100)}%)`
        : `${riv.nombre} viene cediendo menos games (${Math.round(riv.cedidos * 100)}% contra ${Math.round(fav.cedidos * 100)}%): la forma contradice al nivel`);

  const pF = numPrevio(fav.previo), pR = numPrevio(riv.previo);
  if (pF != null && pR != null && pF !== pR)
    eta += suma('previo', pF - pR, MODELO.previo,
      pF > pR ? `${fav.nombre} llegó más lejos en su torneo anterior` : `${riv.nombre} llegó más lejos en su torneo anterior`);

  return { p: sig(eta), eta, grupo, dW, partes, n: N_GRUPO[grupo] };
}

/* ΔWTN mínimo para llegar a una probabilidad, con el resto de las señales
   en cero. Sirve para explicar "por qué no alcanza" en una ronda dada. */
export function dParaLlegar(pObjetivo, ronda) {
  const g = GRUPO[ronda] || 'medias';
  return Math.max(0, Math.log(pObjetivo / (1 - pObjetivo)) / MODELO.pendiente[g]);
}
