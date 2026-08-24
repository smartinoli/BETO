#!/usr/bin/env node
/* ============================================================
   ITF-REGLAS — el juicio sobre un partido, en un solo lugar.

   Aplica las reglas MEDIDAS sobre nuestro propio historial. Lo usan la
   mesa de proximos, la tabla esquematica y el analizador, para que nunca
   se separen el veredicto que se muestra y el que se mide despues.

   Las reglas que mandan, por orden de fuerza:
     1. CURVA DE NIVEL (n=902): la Δ de WTN entra CONTINUA en una
        logistica, y la ronda mueve el nivel a traves de cuatro grupos.
        Reemplaza al par "temprano 75.2% / tarde 56.4%". Sebastian pidio
        separar por ronda y lo primero que hice fue una tabla ronda ×
        banda; validada dejando un torneo afuera predecia PEOR que lo que
        venia a reemplazar. Ver el bloque de la curva, mas abajo.
     2. PISO: si la probabilidad no llega al 58%, no hay lado. Deja de ser
        una regla de Δ (el viejo "bajo 1.5 es ruido", que valia igual para
        una Q1 que para una semi) y pasa a ser una regla de probabilidad,
        que es lo que decide si la cuota puede pagarla.
     3. CHOQUE nivel-contra-forma: si el favorito por WTN llega cediendo
        MAS games que el rival, -0.2976 en logit. Un solo termino, no una
        tabla: las versiones repartidas no sobrevivieron la validacion.

   Un VETO (el rating no vale) anula el veredicto. Los REPAROS solo bajan
   la confianza y dejan el partido a la vista: el veto por residuo de
   mercado mato a Borg [1], que gano 6-3 7-5 el 2026-08-22.
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

/* ---------- ronda, bandas y choque ---------- */
/* El nombre de la ronda llega de tres vocabularios distintos: el cuadro
   ("Quarter-finals"), el order of play ("Quarter-final", en singular) y
   nuestro codigo corto ("QF"). Los tres tienen que caer en la misma clave
   o el partido se cobra con la banda equivocada — asi se colaron 7 de 16
   finales en la banda temprana cuando solo se miraban los nombres largos. */
const CORTA = {
  '1st round': 'R1', '2nd round': 'R2', '3rd round': 'R3', '4th round': 'R4',
  'quarter-final': 'QF', 'quarter-finals': 'QF', 'quarterfinal': 'QF',
  'semi-final': 'SF', 'semi-finals': 'SF', 'semifinal': 'SF', 'final': 'F',
};
export function normRonda(r) {
  let t = String(r || '').trim();
  const quali = /^q[·:.\s-]/i.test(t);                 /* "Q·1st Round" */
  if (quali) t = t.replace(/^q[·:.\s-]\s*/i, '');
  const c = CORTA[t.toLowerCase()] || t.toUpperCase();
  if (!quali) return c;
  return c === 'R1' ? 'Q1' : c === 'R2' ? 'Q2' : c === 'R3' ? 'Q3' : 'Q' + c;
}

/* ============================================================
   LA CURVA DE NIVEL — probabilidad del mejor WTN, por Δ y por ronda.

   Sebastian pidio separar las rondas (Q1, Q2, Q3, R1, R2, QF, SF, F)
   porque "seguimos fallando mucho". Lo primero que hice fue eso literal:
   una tabla de ronda × banda de Δ. Validada dejando un torneo afuera,
   esa tabla resulto PEOR que el par temprano/tarde que reemplazaba
   (log-loss 0.5456 contra 0.5360). Partir 902 partidos en 28 celdas deja
   celdas de 5 y 9 partidos: la ronda si importa, pero las cajas se comen
   la ganancia en varianza. Lo que sirve es tratar la Δ como lo que es,
   una variable continua, y dejar que la ronda mueva el nivel.

   Comparado, todo dejando un torneo afuera sobre los mismos 902:

     regla                              log-loss   Brier  acierto
     vieja, dos grupos (temprano/tarde)   0.5360  0.1794   73.3%
     tabla ronda × banda                  0.5456  0.1834   72.5%
     solo bandas de Δ                     0.5438  0.1819   73.3%
     logistica en Δ                       0.5326  0.1794   73.3%
     logistica en Δ + ronda en 7          0.5317  0.1797   72.7%
     logistica en Δ + ronda en 4  ← esta  0.5294  0.1785   73.1%

   Las rondas se agrupan de a cuatro porque asi se comportan, y agrupadas
   se estiman con 83-345 partidos cada una en vez de 31-312:

     Q1       el campo entero, muchos sin haber jugado nunca      n=312
     buenas   Q2 y R1: ya se filtro una vuelta y el rating vio    n=345
              a los dos. Es el mejor terreno que tenemos.
     medias   Q3 y R2                                             n=162
     finales  QF y SF (la final va aca: n=6 propio)                n=83

   Calibracion fuera de muestra, que es lo que importa para cobrar:
     dijo 51.8% → paso 54.2% (n=168)    dijo 74.8% → paso 73.7% (n=190)
     dijo 64.9% → paso 66.5% (n=215)    dijo 85.0% → paso 82.9% (n=181)
                                        dijo 93.8% → paso 92.6% (n=148)  */
export const GRUPO = {
  Q1: 'Q1', Q2: 'buenas', R1: 'buenas', Q3: 'medias', R2: 'medias',
  /* R3/R4 solo existen en cuadros de 64, que todavia no hemos visto:
     caen en "medias", que es la ronda intermedia mas parecida */
  R3: 'medias', R4: 'medias', QF: 'finales', SF: 'finales', F: 'finales',
};
export const MODELO = {
  base: -0.0286, dWtn: 0.2731,
  grupo: { Q1: 0, buenas: 0.4110, medias: -0.1074, finales: -0.4422 },
  /* Choque nivel-contra-forma: el favorito por WTN llega cediendo MAS
     games que el rival, en el mismo cuadro. Costo medido -0.2976 en logit
     sobre los 324 partidos donde los dos lados tienen trayectoria (134 con
     choque). Antes esto era un reemplazo plano (0.42 si Δ<2.5, 0.63 si no)
     que borraba la ronda entera: un Q1 con Δ4+ y un choque caia de 89% a
     63%. Probe tambien separarlo por fuerza de la banda y por Δ; dejando
     un torneo afuera gana por 0.0027 en log-loss sobre n=324, o sea nada,
     y los coeficientes se daban vuelta segun contra que linea base los
     midiera. Con esa inestabilidad, el termino simple. */
  choque: -0.2976,
};
export const N_GRUPO = { Q1: 312, buenas: 345, medias: 162, finales: 83 };

/* Debajo de esto no hay lado: es el azar con otro nombre. Ya no es una
   regla de Δ ("bajo 1.5 es ruido", que valia igual para Q1 que para una
   semi) sino de probabilidad, que es lo que decide si la cuota la paga.
   En Δ, el piso se traduce distinto en cada grupo — y eso es el punto:
     buenas   desde Δ 0.00 (Q2 y R1 ya pasan el piso con la Δ mas chica)
     Q1       desde Δ 1.29
     medias   desde Δ 1.68
     finales  desde Δ 2.91   (con choque, Δ 4.00) */
export const P_MIN = 0.58;

export const RONDA_FINAL = r => GRUPO[normRonda(r)] === 'finales';
/* se mantiene el nombre viejo: lo usan la mesa y la tabla */
export const esTarde = RONDA_FINAL;

/* Probabilidad de que gane el mejor WTN. choque = true cuando el rival
   llega con mejor forma (menos games cedidos) que nuestro favorito. */
export function pNivel(d, ronda, choque) {
  const r = normRonda(ronda), g = GRUPO[r] || 'medias';
  const eta = MODELO.base + MODELO.dWtn * d + MODELO.grupo[g] + (choque ? MODELO.choque : 0);
  return { p: 1 / (1 + Math.exp(-eta)), grupo: g, ronda: r, n: N_GRUPO[g],
           conocida: !!GRUPO[r] };
}
/* Δ a partir de la cual este grupo pasa el piso, para poder explicarlo. */
export function dMinima(ronda, choque) {
  const g = GRUPO[normRonda(ronda)] || 'medias';
  const objetivo = Math.log(P_MIN / (1 - P_MIN));
  const d = (objetivo - MODELO.base - MODELO.grupo[g] - (choque ? MODELO.choque : 0)) / MODELO.dWtn;
  return Math.max(0, d);
}

const sig = x => 1 / (1 + Math.exp(-x));
/* Precio que el mercado DEBERIA poner segun su propio modelo ajustado
   (logit p = -0.081 + 0.183·ΔWTN, R²=0.626 sobre cuotas desvigadas). */
export const pMercadoModelo = d => sig(-0.081 + 0.183 * d);

/* ---------- el juicio ----------
   lado: { nombre, marca, atp, wtn, wtnVisible, gana, llega }
   Devuelve { favorito, confianza, mercado, razon, banderas, val, pe, d, k } */
export function analizar(p) {
  const l = p.lados || [];
  const R = normRonda(p.ronda);
  const final = RONDA_FINAL(R);
  const etapa = final ? 'ronda final (' + R + ')' : 'ronda ' + R;
  if (l.length !== 2 || l[0].wtn == null || l[1].wtn == null)
    return { tipo: 'pasar', nivel: null, precio: null, favorito: '—', confianza: 'baja', mercado: 'pasar',
      razon: 'Falta el WTN de alguno de los dos: no se puede comparar nivel.', banderas: ['sin datos de nivel'] };

  const d = Math.abs(l[0].wtn - l[1].wtn);
  const k = l[0].wtn < l[1].wtn ? 0 : 1;
  const yo = l[k], otro = l[1 - k];
  /* la forma se mide en GAMES cedidos, no en sets: los sets solo existen
     para 432 de 1045 partidos y el subconjunto sale sesgado */
  const f = l.map(x => gamesCedidos(x.llega));
  const choque = (f[0] != null && f[1] != null && f[0] !== f[1]) ? ((f[0] < f[1] ? 0 : 1) !== k) : null;
  const cel = pNivel(d, R, choque);
  const pe = cel.p;
  const pSinChoque = choque ? pNivel(d, R, false).p : pe;

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

  /* Sin lado: la celda que le toca a ESTA ronda no llega al piso. Ya no es
     "Δ<1.5 es ruido" para todos: en R1 un Δ1.8 vale 76% y hay lado, y en
     QF un Δ1.0 vale 43% — el favorito por WTN pierde más de lo que gana. */
  if (pe < P_MIN) {
    const porChoque = pSinChoque >= P_MIN;
    const dm = dMinima(R, choque);
    const razon = porChoque
      ? `Δ${d.toFixed(2)} de WTN en ${etapa} da ${Math.round(pSinChoque * 100)}%, pero ${otro.nombre} llega cediendo menos games y el choque lo baja a ${Math.round(pe * 100)}%: bajo el piso de ${Math.round(P_MIN * 100)}%. Sin lado.`
      : `Δ${d.toFixed(2)} de WTN en ${etapa}: ahí el mejor WTN sale ${Math.round(pe * 100)}%, bajo el piso de ${Math.round(P_MIN * 100)}%. En ${cel.grupo} (n=${cel.n}) haría falta Δ${dm.toFixed(2)}${choque ? ' con el choque en contra' : ''}. Sin lado.`;
    return { tipo: 'pasar', nivel: null, precio: null, favorito: '—', confianza: 'baja', mercado: 'pasar',
      razon, banderas: [porChoque ? 'choque hunde el nivel' : `Δ${d.toFixed(2)} corta en ${R}`] };
  }

  /* --- reparos: bajan la confianza, NO ocultan el partido --- */
  const avisos = [];
  if (otro.atp == null) avisos.push(`${otro.nombre} no tiene ranking ATP (normal en qualis; medido, el WTN ahi acierta MAS: 81% contra 75%)`);
  if (yo.atp != null && otro.atp != null && otro.atp < yo.atp - 400)
    avisos.push(`el ATP dice lo contrario que el WTN (${yo.atp} contra ${otro.atp}, ${yo.atp - otro.atp} puestos)${final ? ' — y de cuartos en adelante el ATP acierta más que el WTN (64% contra 50% en semis)' : ''}`);
  if (yo.gana && otro.gana) {
    const devig = (1 / yo.gana) / ((1 / yo.gana) + (1 / otro.gana));
    const res = devig - pMercadoModelo(d);
    if (res < -0.15) avisos.push(`el mercado lo paga a ${yo.gana} (${Math.round(devig * 100)}% real) cuando su propio modelo por ΔWTN daría ${Math.round(pMercadoModelo(d) * 100)}%: ${Math.round(-res * 100)} puntos que no vemos`);
  }
  if (huboRetiro(otro.llega)) avisos.push(`${otro.nombre} ganó un partido por retiro: llega más fresco`);
  if (final) avisos.push(`${R}: el cuadro ya filtró y el WTN cae — en cuartos acierta 59.6% (n=53) y en semis 50.0% (n=26), donde manda la siembra (81.3% en cuartos) y el ATP le gana al WTN (64% contra 50%)`);
  if (!cel.conocida) avisos.push(`${R} no es una ronda que hayamos visto nunca (solo aparece en cuadros de 64): se cobra con el grupo "medias", que es lo más parecido`);
  if (choque) avisos.push(`${otro.nombre} llega cediendo menos games: el choque baja la estimación de ${Math.round(pSinChoque * 100)}% a ${Math.round(pe * 100)}%`);

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
  const nivel = { fuerza, p: pe, d, favorito: yo.nombre + (yo.marca ? ' ' + yo.marca : ''),
    ronda: R, grupo: cel.grupo, tarde: final, choque: !!choque, n: cel.n, cEmpate, cMinima };

  const ban = [`Δ${d.toFixed(2)} ${fuerza}`];
  if (choque) ban.push('choque nivel vs forma');
  const enContra = avisos.filter(a => !/no tiene ranking ATP/.test(a));
  for (const a of enContra) ban.push('ojo: ' + a.split(':')[0].split(' —')[0]);

  let razon = `Δ${d.toFixed(2)} de WTN a favor (${yo.wtn} contra ${otro.wtn}), en ${etapa}: la curva del grupo "${cel.grupo}" (n=${cel.n}) da ${Math.round(pSinChoque * 100)}%. `;
  if (choque) razon += `${otro.nombre} llega cediendo menos games y el choque la baja a ${Math.round(pe * 100)}%. `;

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
    razon += `El mercado lo pone de NO favorito a ${c} (${Math.round(devig * 100)}%) cuando nuestra curva dice ${Math.round(pe * 100)}%: ${Math.round(val * 100)}% de valor si tenemos razon. `;
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
  if (choque) bloqueo.push('la forma contradice al nivel');
  if (final) bloqueo.push(`es ${R}, donde el nivel deja de mandar`);
  if (!yo.llega && !otro.llega) bloqueo.push('ninguno de los dos tiene trayectoria en el cuadro: no se pudo mirar la forma');
  if (!cel.conocida) bloqueo.push(`${R} es una ronda que nunca vimos`);
  if (enContra.length) bloqueo.push(enContra.length + ' reparo' + (enContra.length > 1 ? 's' : ''));
  if (residuo < -0.15) bloqueo.push('el mercado se aparta ' + Math.round(-residuo * 100) + ' puntos de su propio modelo');
  if (!bloqueo.length) {
    razon += `Nivel fuerte, ${R} está en "${cel.grupo}" (n=${cel.n}), y sin reparos.`;
    if (avisos.length) razon += ` (${avisos.join('; ')})`;
    return { tipo: 'segura', nivel, precio, favorito: nivel.favorito, confianza: 'alta', mercado: 'gana', razon, banderas: [...ban, 'segura'] };
  }
  razon += `Pero: ${bloqueo.join('; ')}.`;
  if (avisos.length) razon += ` ${avisos.join('; ')}.`;
  return { tipo: 'mirar', nivel, precio, favorito: nivel.favorito, confianza: 'media', mercado: 'gana', razon, banderas: [...ban, 'mirar'] };
}
