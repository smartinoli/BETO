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

/* ---------- cruzar nombres entre fuentes ----------
   Betano y la ITF no escriben igual: "Aren Baybar" contra "Aren Baybars",
   "Luca" contra "Lucca", "Matisse MARTIN" contra "Matisse Martin", y los
   PDF a veces cortan el apellido. Hacia falta un cruce difuso.

   El primero que escribi era demasiado suelto: le bastaba UN token en
   comun cuando los dos nombres tenian dos. Con eso, "Carles Cordoba" de
   Betano caso con "Carles Hernandez" del cuadro de Oviedo — dos jugadores
   distintos, los dos en el mismo torneo — y entro una cuota al registro
   con el nombre equivocado. Encontrado el 2026-08-24.

   Ahora los trozos se comparan tolerando el plural, el acento perdido y
   el corte ("baybar" vale por "baybars"), pero tienen que calzar TODOS
   los del nombre mas corto. Y entre varios candidatos gana el que mas
   comparte, no el primero de la lista. */
export const NORM = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '')
  .toLowerCase().replace(/[^a-z ]/g, ' ').replace(/\s+/g, ' ').trim();
/* se descartan solo las iniciales sueltas: un apellido de dos letras
   ("Wu", "Ho") es un apellido, y tirarlo hacia que "Kai-An Wu" pasara por
   "Kai-I Wang" — les quedaba "kai" como unico trozo en comun */
const PARTES = s => NORM(s).split(' ').filter(x => x.length >= 2);

function distancia(a, b) {
  const m = a.length, n = b.length;
  if (Math.abs(m - n) > 2) return 9;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++)
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[n];
}
/* dos trozos de nombre que son el mismo, escritos distinto */
const mismoTrozo = (a, b) => a === b
  || (Math.min(a.length, b.length) >= 4 && (a.startsWith(b) || b.startsWith(a)))
  /* 4 letras y no 5: hacia falta para "Luca"/"Lucca". Es seguro porque
     un trozo suelto nunca alcanza — siempre se piden dos. */
  || (Math.min(a.length, b.length) >= 4 && distancia(a, b) <= 1);

/* cuantos trozos comparten, sin contar dos veces el mismo */
function comunes(A, B) {
  const libres = [...B]; let c = 0;
  for (const x of A) {
    const i = libres.findIndex(y => mismoTrozo(x, y));
    if (i >= 0) { libres.splice(i, 1); c++; }
  }
  return c;
}
export function mismoJugador(a, b) {
  const A = PARTES(a), B = PARTES(b);
  if (!A.length || !B.length) return false;
  /* TODOS los trozos del nombre mas corto tienen que calzar. Una fuente
     puede traer un nombre de mas ("Mohamed Nazim Makhlouf" contra "Nazim
     Makhlouf") pero no puede contradecir al otro. Sin esto, dos hermanos
     pasan por la misma persona: Enrique y Maxi Carrascosa Diaz en Oviedo,
     Kai-i y Yen-Chun Wang en Taipei. */
  return comunes(A, B) >= Math.min(A.length, B.length);
}
/* De una lista, el nombre que mejor calza — no el primero que pase. */
export function elegirNombre(lista, nombre) {
  const A = PARTES(nombre);
  let mejor = null, ms = -1;
  for (const n of lista) {
    if (!mismoJugador(n, nombre)) continue;
    const B = PARTES(n);
    const s = comunes(A, B) * 10 - Math.abs(A.length - B.length);
    if (s > ms) { ms = s; mejor = n; }
  }
  return mejor;
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
                                        dijo 93.8% → paso 92.6% (n=148)  *//* El modelo vive ahora en itf-modelo.mjs: varias señales, no solo el WTN.
   Aca quedan los envoltorios que usan la mesa, la tabla y el registro. */
export { GRUPO, MODELO, N_GRUPO } from './itf-modelo.mjs';
import { GRUPO as G, MODELO as MOD, N_GRUPO as NG, probabilidad, dParaLlegar } from './itf-modelo.mjs';

/* Debajo de esto no hay lado: es el azar con otro nombre. */
export const P_MIN = 0.58;
export const RONDA_FINAL = r => G[normRonda(r)] === 'finales';
export const esTarde = RONDA_FINAL;

/* Compatibilidad: la probabilidad con SOLO el ΔWTN. Ya no es lo que usa
   el juicio — analizar() llama a probabilidad() con la ficha completa —
   pero la tabla y la mesa siguen pidiendo "la curva del nivel" a secas. */
export function pNivel(d, ronda, choque) {
  const r = normRonda(ronda), g = G[r] || 'medias';
  const eta = MOD.pendiente[g] * d + (choque ? MOD.cedidos * -0.14 : 0);
  return { p: 1 / (1 + Math.exp(-eta)), grupo: g, ronda: r, n: NG[g], conocida: !!G[r] };
}
export function dMinima(ronda) { return dParaLlegar(P_MIN, normRonda(ronda)) }

const sig = x => 1 / (1 + Math.exp(-x));
/* Precio que el mercado DEBERIA poner segun su propio modelo por nivel
   (logit p = -0.081 + 0.183·ΔWTN, R²=0.626 sobre cuotas desvigadas).
   PENDIENTE DE REAJUSTE: se ajusto sobre n=18 de rondas avanzadas. Con las
   cuotas de hoy la curva del mercado sale distinta en cada grupo — en R1
   es 0.087 + 0.180·Δ (R²=0.564, n=21) y en Q2 la pendiente se va a cero.
   Ver itf-mercado.mjs, que ya la ajusta por grupo. Este modelo global solo
   se usa para la bandera de residuo. */
export const pMercadoModelo = d => sig(-0.081 + 0.183 * d);

/* ---------- el juicio ----------
   lado: { nombre, marca, atp, wtn, wtnVisible, gana, llega }
   Devuelve { favorito, confianza, mercado, razon, banderas, val, pe, d, k } */
/* ---------- el juicio ----------
   lado: { nombre, marca, atp, itf, nac, nacido, wtn, wtnVisible, seed,
           jr, jrRank, gana, llega, previo }
   Devuelve { tipo, nivel, precio, favorito, confianza, mercado, razon, banderas }

   LAS TRES PREGUNTAS, EN ESTE ORDEN:
     1. ¿el dato sirve?            → veto
     2. ¿hay lado?                 → probabilidad del modelo completo
     3. ¿el MERCADO nos acompaña?  → esta es la que cambió todo

   POR QUÉ LA TERCERA. Hasta el 2026-08-25 el criterio era el valor
   clásico: p×cuota−1 sobre un mínimo. Medido sobre los 50 partidos que
   tienen cuota Y resultado, esa regla eligió 5 de 15 ganadores y rindió
   −51%. No es que estuviera mal calibrada: está mal PLANTEADA. El valor
   se maximiza donde la cuota es más larga de lo que dice nuestra p, o
   sea justo donde el mercado más nos contradice — y ahí el mercado tiene
   razón. Partiendo el registro por cuánto discrepamos:

     nosotros +15 puntos o más que el mercado   4/13 = 31%   −57%
     +5 a +15                                 17/19 = 89%   +17%
     ±5 (de acuerdo)                            6/7 = 86%   +13%
     −5 a −15                                   4/7 = 57%   −30%
     −15 o menos                                3/4 = 75%    +9%

   La regla nueva es al revés que la vieja: se juega donde el modelo dice
   que el favorito es fuerte Y el mercado piensa parecido. Discrepar mucho
   a nuestro favor deja de ser "anomalía aprovechable" y pasa a ser
   TRAMPA, que es lo que la evidencia dice que es.

     regla                                    n   acierto    rinde
     la de hoy: valor ≥ 9%                   15   33% (5/15)   −51%
     p≥70% y no discrepar más de +12         16  100% (16/16)  +20%

   (con el modelo reajustado sin el torneo de cada partido, para que no se
   esté juzgando a sí mismo)

   AVISO HONESTO SOBRE EL 16/16: son 16 partidos y el umbral de +12 lo
   elegí mirando estos mismos 50. El intervalo de Wilson es 81–100%. Lo
   que la evidencia sostiene es el SIGNO —discrepar a nuestro favor es
   malo, no bueno— y eso además coincide con el residuo de mercado que
   veníamos midiendo aparte. El número exacto hay que volver a medirlo
   cuando haya el doble de registro. */

const DISCREPANCIA_MAX = 0.12;   /* cuántos puntos podemos estar por sobre el mercado */
const P_SEGURA = 0.70;
const pct = v => `${v >= 0 ? '+' : ''}${Math.round(v * 100)}%`;           /* piso de probabilidad para jugarla */
/* Cuánto tiene que sobrar la cuota. Era 0.09 heredado del criterio viejo
   y con el nuevo NO PASA NINGUNA: si el mercado está de acuerdo con
   nosotros, por construcción el precio no va a ser generoso. Ese 9% era
   justamente lo que empujaba al sistema hacia las cuotas largas, o sea
   hacia la casilla trampa. Medido con p≥70% y discrepancia ≤+12 ya
   puestos, pedirle margen a la cuota casi no mejora el acierto y sí
   achica la muestra:

     margen  n   acierto      rinde
     −5%    13   13/13        +22%
      0%     5    5/5         +27%
     +5%     2    2/2         +28%
     +9%     0    —            —

   Se queda en 0: la única condición sensata es que la apuesta no pierda
   plata con nuestra propia probabilidad. */
const MARGEN = 0;

export function analizar(p) {
  const l = p.lados || [];
  const R = normRonda(p.ronda);
  const final = RONDA_FINAL(R);
  const nada = (razon, banderas) => ({ tipo: 'pasar', nivel: null, precio: null,
    favorito: '—', confianza: 'baja', mercado: 'pasar', razon, banderas });

  if (l.length !== 2 || l[0].wtn == null || l[1].wtn == null)
    return nada('Falta el WTN de alguno de los dos: no se puede comparar nivel.', ['sin datos de nivel']);

  const k = l[0].wtn < l[1].wtn ? 0 : 1;
  const yo = { ...l[k], cedidos: gamesCedidos(l[k].llega) };
  const otro = { ...l[1 - k], cedidos: gamesCedidos(l[1 - k].llega) };
  const d = Math.abs(l[0].wtn - l[1].wtn);

  /* --- 1. veto: el número mismo no vale --- */
  const esJunior = otro.jr || /JR/i.test(otro.marca || '');
  const JR_PELIGRO = 60;
  const jrElite = esJunior && otro.jrRank != null && otro.jrRank <= JR_PELIGRO;
  const jrIncognito = esJunior && otro.jrRank == null;
  if (jrElite)
    return nada(`El ΔWTN de ${d.toFixed(2)} apunta a ${yo.nombre}, pero el número no sirve: `
      + `${otro.nombre} es el ${otro.jrRank} del mundo junior, y contra juniores de top ${JR_PELIGRO} `
      + `el mejor WTN acierta 22% (2 de 9, esperaba 6.6) porque el rating de un junior de élite `
      + `va atrasado respecto de lo que juega hoy.`, ['veto: junior de élite']);

  /* --- 2. la probabilidad, con todas las señales --- */
  const est = probabilidad(yo, otro, R);
  const pe = est.p;
  const soloNivel = 1 / (1 + Math.exp(-MOD.pendiente[est.grupo] * est.dW));
  const conocida = !!G[R];
  const nivel = { p: pe, soloNivel, d, grupo: est.grupo, n: est.n, conocida,
    partes: est.partes, favorito: yo.nombre + (yo.marca ? ' ' + yo.marca : ''),
    fuerza: pe >= 0.85 ? 'muy fuerte' : pe >= 0.75 ? 'fuerte' : pe >= P_MIN ? 'claro' : 'sin lado' };

  /* de qué está hecha la estimación, en palabras */
  const mueve = est.partes.filter(x => x.nombre !== 'nivel' && Math.abs(x.aporte) > 0.02);
  const desglose = mueve.length
    ? ` Ajustan: ${mueve.map(x => `${x.texto} (${x.aporte >= 0 ? '+' : ''}${Math.round(100 * (1 / (1 + Math.exp(-(est.eta))) - 1 / (1 + Math.exp(-(est.eta - x.aporte)))))} pts)`).join('; ')}.`
    : '';
  const cabeza = `Δ${d.toFixed(2)} de WTN a favor de ${yo.nombre} (${yo.wtn} contra ${otro.wtn}), en ${R}: `
    + `la curva del grupo "${est.grupo}" (n=${est.n}) da ${Math.round(soloNivel * 100)}%.${desglose}`
    + (mueve.length ? ` Queda en ${Math.round(pe * 100)}%.` : '');

  if (pe < P_MIN)
    return { ...nada(`${cabeza} No llega al piso de ${Math.round(P_MIN * 100)}%: acá no hay lado, es el azar con otro nombre.`,
      [`p${Math.round(pe * 100)}% bajo el piso`]), nivel };

  /* --- reparos que no ocultan el partido --- */
  const avisos = [];
  if (jrIncognito) avisos.push(`${otro.nombre} es junior y no tengo su ranking junior en ninguna entry list: `
    + `no sé si es un top ${JR_PELIGRO} —donde el favorito gana solo 22%— o uno del montón`);
  if (!conocida) avisos.push(`${R} no es una ronda que hayamos visto nunca: se cobra con el grupo "medias"`);
  if (final) avisos.push(`${R}: el cuadro ya filtró y el nivel discrimina menos — la pendiente cae a ${MOD.pendiente.finales} contra ${MOD.pendiente.buenas} en R1`);
  if (huboRetiro(otro.llega)) avisos.push(`${otro.nombre} ganó un partido por retiro: llega más fresco`);

  /* --- 3. el mercado --- */
  const c = yo.gana, cRival = otro.gana;
  if (!c) {
    const razon = `${cabeza} Sin cuota todavía: se informa el nivel y nada más.`
      + (avisos.length ? ` Con reparos: ${avisos.join('; ')}.` : '');
    return { tipo: 'sin-precio', nivel, precio: null, favorito: nivel.favorito,
      confianza: 'media', mercado: 'sin precio', razon, banderas: [`p${Math.round(pe * 100)}%`] };
  }
  const devig = cRival ? (1 / c) / ((1 / c) + (1 / cRival)) : null;
  const discrepancia = devig != null ? pe - devig : null;
  const cMinima = (1 + MARGEN) / pe;
  const val = pe * c - 1;
  const precio = { cuota: c, cuotaRival: cRival ?? null, devig, discrepancia, cMinima, val };
  const ban = [`p${Math.round(pe * 100)}%`];
  if (discrepancia != null) ban.push(`mercado ${discrepancia >= 0 ? '+' : ''}${Math.round(discrepancia * 100)}`);

  const mercadoTxt = devig != null
    ? ` El mercado la paga a ${c} (${Math.round(devig * 100)}% real, sin su margen); nosotros decimos ${Math.round(pe * 100)}%: `
      + (Math.abs(discrepancia) < 0.05 ? 'estamos de acuerdo.'
        : `${Math.abs(Math.round(discrepancia * 100))} puntos ${discrepancia > 0 ? 'por encima' : 'por debajo'}.`)
    : ` A ${c}, sin la cuota del rival no se puede descontar el margen de la casa.`;

  /* TRAMPA: creemos mucho más que el mercado. Medido, es la peor casilla. */
  if (discrepancia != null && discrepancia > DISCREPANCIA_MAX)
    return { tipo: 'trampa', nivel, precio, favorito: '—', confianza: 'baja', mercado: 'pasar',
      razon: `${cabeza}${mercadoTxt} Esa distancia es la señal más mala que tenemos: `
        + `cuando le sacamos más de ${Math.round(DISCREPANCIA_MAX * 100)} puntos al mercado, el favorito ganó 4 de 13 y `
        + `la apuesta rindió −57%. El precio sabe algo que nosotros no.`,
      banderas: [...ban, 'trampa: discrepamos con el mercado'] };

  if (pe < P_SEGURA)
    return { tipo: 'mirar', nivel, precio, favorito: nivel.favorito, confianza: 'media', mercado: 'gana',
      razon: `${cabeza}${mercadoTxt} Hay lado pero no llega a ${Math.round(P_SEGURA * 100)}%, que es el piso desde el que medimos que rinde.`
        + (avisos.length ? ` ${avisos.join('; ')}.` : ''),
      banderas: [...ban, 'mirar'] };

  if (c < cMinima)
    return { tipo: 'mirar', nivel, precio, favorito: nivel.favorito, confianza: 'media', mercado: 'gana',
      razon: `${cabeza}${mercadoTxt} A ${c} sobra ${pct(val)}, o sea que a ese precio la apuesta pierde plata `
        + `con nuestra propia probabilidad (haría falta ${cMinima.toFixed(2)}). El partido es bueno, el precio no.`
        + (avisos.length ? ` ${avisos.join('; ')}.` : ''),
      banderas: [...ban, 'cuota corta'] };

  /* --- lo que sí se juega --- */
  const bloqueo = [];
  if (jrIncognito) bloqueo.push('el rival es un junior que no puedo calificar');
  if (final) bloqueo.push(`es ${R}, donde el nivel deja de mandar`);
  if (!conocida) bloqueo.push(`${R} es una ronda que nunca vimos`);
  if (devig == null) bloqueo.push('falta la cuota del rival para descontar el margen');
  if (!bloqueo.length)
    return { tipo: 'segura', nivel, precio, favorito: nivel.favorito, confianza: 'alta', mercado: 'gana',
      razon: `${cabeza}${mercadoTxt} A ${c} paga sobre la mínima de ${cMinima.toFixed(2)}: ${pct(val)} de valor. `
        + `Modelo fuerte, mercado de acuerdo y precio que no pierde: esa casilla midió 5 de 5 y +27%.`
        + (avisos.length ? ` (${avisos.join('; ')})` : ''),
      banderas: [...ban, 'segura'] };

  return { tipo: 'mirar', nivel, precio, favorito: nivel.favorito, confianza: 'media', mercado: 'gana',
    razon: `${cabeza}${mercadoTxt} A ${c} el precio da (${pct(val)}), pero no es segura: ${bloqueo.join('; ')}.`
      + (avisos.length ? ` ${avisos.join('; ')}.` : ''),
    banderas: [...ban, 'mirar'] };
}
