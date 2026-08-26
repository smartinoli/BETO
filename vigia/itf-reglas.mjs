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
  const eta = MOD.pendiente[g] * d + (choque ? MOD.cedidos * -0.14 : 0);   /* -0.14 = diferencia tipica de games cedidos cuando hay choque */
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
   lado: { nombre, marca, atp, itf, nac, nacido, wtn, seed, jr, jrRank,
           gana, llega, previo }

   NO HAY CATEGORÍAS. Las había —segura, trampa, mirar, anomalía— y se
   quitaron el 2026-08-26 a pedido de Sebastián, con razón: una etiqueta
   que sale de un umbral elegido sobre 52 partidos no es una conclusión,
   es una opinión disfrazada de conclusión. Lo que se entrega ahora son
   los números y las alertas que SÍ están medidas, y la decisión es suya.

   POR QUÉ NO HAY UNA "SEGURA". Medido el 2026-08-26 sobre los 52 partidos
   que tienen precio Y resultado, el mercado le gana a nuestro modelo
   (log-loss 0.5220 contra 0.5485). Y el hallazgo grande de la auditoría
   —que contra un rival sub-19 el WTN se equivoca 14 puntos— resulta que
   el mercado YA LO SABE:

     rival de 18 o menos   el precio decía 64%   pasó 67%   el WTN decía 83%
     rival de 19 a 22      el precio decía 66%   pasó 72%   el WTN decía 69%
     rival de 23 o más     el precio decía 67%   pasó 59%   el WTN decía 66%

   O sea: el escalón sub-19 corrige NUESTRO modelo hasta donde el precio
   ya estaba. Mejora la estimación, no da ventaja. Apostar al sub-19 a la
   cuota que pagan rindió −16% en 12 partidos.

   LO QUE SÍ ESTÁ MEDIDO, y por eso son alertas y no categorías:

     1. FAVORITO CARO. El favorito por WTN cuando el precio lo pone sobre
        2.00 gana 14% de las veces (n=7) y la apuesta rinde −69%. Entre
        1.50 y 2.00, −17% (n=12). Bajo 1.50 la cosa se aplana (−4% y +4%).
        Es el sesgo clásico: si nuestro favorito paga largo, el precio
        sabe algo que el WTN no.

     2. JUNIOR DE ÉLITE. Contra un top 60 del mundo junior el mejor WTN
        acierta 22% (2 de 9, esperaba 6.6). Es el único veto que queda.

     3. PARTIDO PAREJO. Con ΔWTN bajo 2 el precio decía 58% y pasó 43%
        (n=23, la casilla más grande del barrido). En un partido parejo
        nadie sabe nada, ni el precio ni nosotros.

   Y LO QUE NO ESTÁ MEDIDO, dicho para que no se confunda con lo anterior:
   con 52 partidos con precio, una casilla de 10 tiene un margen de error
   de ±30 puntos. Todo lo que no está en esa lista de tres es ruido. */

const P_SEGURA = 0.70;
const CUOTA_CARA = 1.50;   /* sobre esto, el favorito por WTN es una trampa medida */

/* ============================================================
   LAS DOS REGLAS DE PERDEDOR
   Medidas el 2026-08-26 sobre los 1252 partidos con WTN en los dos lados,
   buscando no "quién gana" sino "quién se cae". La diferencia importa
   porque la plata está en el lado largo: un error de 5 puntos a cuota
   2.40 vale seis veces lo que el mismo error a 1.10.

   La señal es la FORMA dentro del cuadro: qué fracción de games cedió
   cada uno en los partidos que ya jugó ahí. Tiene dosis y respuesta, con
   un umbral limpio en 5 puntos:

     el favorito cedió 10 pts MENOS   el peor WTN gana 20%   la curva decía 31%
     cedió 5 a 10 menos                                31%              31%
     parejos, ±5                                       30%              32%
     el favorito cedió 5 a 10 MÁS                      46%              35%
     cedió 10 a 20 más                                 48%              33%
     cedió 20 o más                                    44%              32%

   Y no es un efecto de ronda: controlando por grupo, la brecha es +8 en
   Q2/R1, +32 en Q3/R2/R3 y +17 de cuartos en adelante. En PRIMERA RONDA
   casi no sirve (el peor WTN gana 32%, apenas +5) porque ahí la
   "trayectoria" es sólo la clasificación, que es otra cosa. Por eso la
   regla excluye la primera ronda del cuadro.

   CAÍDA — el favorito por WTN llega cediendo 5+ puntos más, fuera de
   primera ronda:
     el peor WTN gana 56% (n=82), IC 95% 45–66%, la curva le daba 38%.
     Cuota mínima 1.78; con el borde pesimista del intervalo, 2.21.

   FIRME — el favorito llega cediendo 10+ puntos menos, el rival tiene 19
   o más y el ΔWTN es 3 o más:
     el favorito gana 91% (n=55), IC 80–96%, la curva le daba 78%.
     Cuota mínima 1.10; con el borde pesimista, 1.24.

   LO QUE NO SABEMOS: si el mercado ya cotiza esto. Con 52 partidos con
   precio sólo hay 6 que caen en CAÍDA, y ahí el precio le daba al peor
   WTN un 41% contra el 46-56% histórico. La brecha existe pero no se
   puede medir con 6. Esto se verifica jugando hacia adelante, no
   mirando para atrás. */
const CED_CAIDA = -0.05;
const CED_FIRME = 0.10;
const CUOTA_CAIDA = 2.21;   /* borde pesimista: desde acá gana aunque la muestra mienta */
const CUOTA_FIRME = 1.24;
const primeraRonda = R => R === 'R1' || R === 'Q1';

export function analizar(p) {
  const l = p.lados || [];
  const R = normRonda(p.ronda);
  const final = RONDA_FINAL(R);
  const nada = (razon, banderas) => ({ tipo: 'fuera', nivel: null, precio: null,
    favorito: '—', confianza: 'baja', mercado: 'pasar', alertas: [], razon, banderas });

  if (l.length !== 2 || l[0].wtn == null || l[1].wtn == null)
    return nada('Falta el WTN de alguno de los dos: no se puede comparar nivel.', ['sin datos de nivel']);

  const k = l[0].wtn < l[1].wtn ? 0 : 1;
  const yo = { ...l[k], cedidos: gamesCedidos(l[k].llega) };
  const otro = { ...l[1 - k], cedidos: gamesCedidos(l[1 - k].llega) };
  const d = Math.abs(l[0].wtn - l[1].wtn);

  /* --- el único veto que sobrevivió a la medición --- */
  const esJunior = otro.jr || /JR/i.test(otro.marca || '');
  const JR_PELIGRO = 60;
  if (esJunior && otro.jrRank != null && otro.jrRank <= JR_PELIGRO)
    return nada(`El ΔWTN de ${d.toFixed(2)} apunta a ${yo.nombre}, pero el número no sirve: `
      + `${otro.nombre} es el ${otro.jrRank} del mundo junior, y contra juniores de top ${JR_PELIGRO} `
      + `el mejor WTN acierta 22% (2 de 9, esperaba 6.6).`, ['veto: junior de élite']);

  /* --- la probabilidad, con todas las señales --- */
  const est = probabilidad(yo, otro, R);
  const pe = est.p;
  const soloNivel = 1 / (1 + Math.exp(-MOD.pendiente[est.grupo] * est.dW));
  const conocida = !!G[R];
  const nivel = { p: pe, soloNivel, d, grupo: est.grupo, n: est.n, conocida, partes: est.partes,
    favorito: yo.nombre + (yo.marca ? ' ' + yo.marca : '') };

  const mueve = est.partes.filter(x => x.nombre !== 'nivel' && Math.abs(x.aporte) > 0.02);
  const pAntes = a => 1 / (1 + Math.exp(-(est.eta - a)));
  const desglose = mueve.length
    ? ` Ajustan: ${mueve.map(x => `${x.texto} (${x.aporte >= 0 ? '+' : '−'}${Math.abs(Math.round(100 * (est.p - pAntes(x.aporte))))} pts)`).join('; ')}.`
    : '';
  const razonNivel = `Δ${d.toFixed(2)} de WTN a favor de ${yo.nombre} (${yo.wtn} contra ${otro.wtn}), en ${R}: `
    + `la curva del grupo "${est.grupo}" (n=${est.n}) da ${Math.round(soloNivel * 100)}%.${desglose}`
    + (mueve.length ? ` Queda en ${Math.round(pe * 100)}%.` : '');

  /* --- alertas: sólo las tres que están medidas --- */
  const alertas = [];
  let contra = null;
  /* las dos reglas de perdedor, que son lo único que apunta a una apuesta
     concreta y no sólo a "no juegues esto" */
  const dCed = (yo.cedidos != null && otro.cedidos != null) ? otro.cedidos - yo.cedidos : null;
  let regla = null;
  if (dCed != null && dCed <= CED_CAIDA && !primeraRonda(R))
    regla = { clave: 'caida', lado: otro.nombre, cuotaMin: CUOTA_CAIDA,
      texto: `${yo.nombre} tiene mejor WTN pero llega cediendo ${Math.round(-dCed * 100)} puntos más de games `
        + `(${Math.round(yo.cedidos * 100)}% contra ${Math.round(otro.cedidos * 100)}%). Medido, en esa situación y `
        + `fuera de primera ronda el PEOR WTN gana 56% (n=82, IC 45–66) cuando la curva le daba 38%. `
        + `Apostar a ${otro.nombre} paga desde ${CUOTA_CAIDA.toFixed(2)} aun tomando el borde malo del intervalo.` };
  else if (dCed != null && dCed >= CED_FIRME && (otro.nacido == null || 2026 - otro.nacido >= 19) && d >= 3)
    regla = { clave: 'firme', lado: yo.nombre, cuotaMin: CUOTA_FIRME,
      texto: `${yo.nombre} llega cediendo ${Math.round(dCed * 100)} puntos menos de games, el rival no es sub-19 y `
        + `el ΔWTN es ${d.toFixed(2)}. Medido, esa combinación gana 91% (n=55, IC 80–96) cuando la curva daba 78%. `
        + `Paga desde ${CUOTA_FIRME.toFixed(2)} tomando el borde malo.` };
  if (regla) alertas.push(regla);
  if (d < 2) alertas.push({ clave: 'parejo', texto:
    `ΔWTN de ${d.toFixed(2)}: partido parejo. En esa casilla el precio decía 58% y pasó 43% (n=23): acá no sabe nadie.` });
  if (esJunior && otro.jrRank == null) alertas.push({ clave: 'jr-incognito', texto:
    `${otro.nombre} es junior y no tengo su ranking junior: no sé si es un top ${JR_PELIGRO}, que es el tramo donde el WTN se da vuelta.` });
  if (final) alertas.push({ clave: 'ronda-final', texto:
    `${R}: el cuadro ya filtró y el nivel discrimina menos — la pendiente cae a ${MOD.pendiente.finales} contra ${MOD.pendiente.buenas} en R1.` });
  if (!conocida) alertas.push({ clave: 'ronda-rara', texto: `${R} no es una ronda que hayamos visto nunca: se cobra con el grupo "medias".` });
  if (huboRetiro(otro.llega)) alertas.push({ clave: 'retiro', texto: `${otro.nombre} ganó un partido por retiro: llega más fresco.` });

  const c = yo.gana, cRival = otro.gana;
  if (!c)
    return { tipo: 'sin-precio', nivel, precio: null, favorito: nivel.favorito, alertas,
      confianza: 'media', mercado: 'sin precio',
      razon: `${razonNivel} Sin cuota todavía.`, banderas: [`p${Math.round(pe * 100)}%`] };

  /* LA CONTRA. Durante toda la sesión el sistema calculó el valor de UN
     lado: el favorito por WTN. El otro nunca se miró, y ahí estaba lo
     único que se parece a una apuesta de verdad.

     Medido el 2026-08-26 sobre los 52 partidos con precio y resultado,
     partiendo por lo que Betano le cobra a NUESTRO favorito por WTN:

       el favorito paga   n   pierde   la contra paga   rinde la contra
       bajo 1.20         14      7%        5.23             −66%
       1.20 a 1.50       19     26%        3.24             −15%
       1.50 a 2.00       12     50%        2.08              +4%
       sobre 2.00         7     86%        1.47             +24%
       SOBRE 1.50        19     63%        1.86             +11%

     Es monótona de punta a punta y tiene un mecanismo entendible: cuando
     el WTN dice que A es mejor pero el precio lo pone parejo o abajo, el
     mercado sabe algo que el rating no — lesión, superficie, estilo,
     cancha local. Apostarle al otro es ponerse del lado informado.

     Coincide además con lo que ya habíamos medido por otro camino: con
     ΔWTN bajo 2 el precio decía 58% y pasó 43% (n=23). Son la misma
     casilla vista de dos formas: casi todos estos partidos son parejos.

     EL LÍMITE, Y ES SERIO: son 19 partidos. El intervalo del 63% va de
     41% a 81%. Al 63% la contra rinde +11%; al borde malo del intervalo
     necesitaría cuota 2.44 y paga 1.86, o sea −24%. El punto entusiasma
     y el intervalo no concluye. Se marca para jugarla hacia adelante y
     medirla, no porque esté probada. */
  if (c > CUOTA_CARA) {
    const cContra = cRival ?? null;
    alertas.push({ clave: 'favorito-caro', texto:
      `${yo.nombre} es el MEJOR POR RATING pero Betano lo paga ${c}: el favorito del mercado es el otro. `
      + `Rating y precio se contradicen; en el registro (19 casos) mandaba el precio, pero el 26-08 los tres `
      + `casos reales salieron para el lado del rating. En observación.` });
    /* el tramo importa: no es lo mismo que pague 1.6 a que pague 2.4 */
    const tramo = c >= 2.00
      ? { nom: 'sobre 2.00', pierde: 0.86, ic: [0.49, 0.97], n: 7 }
      : { nom: 'entre 1.50 y 2.00', pierde: 0.50, ic: [0.25, 0.75], n: 12 };
    contra = { lado: otro.nombre, cuota: cContra, cuotaFav: c, ...tramo,
      rinde: cContra ? tramo.pierde * cContra - 1 : null,
      rindeMalo: cContra ? tramo.ic[0] * cContra - 1 : null };
  }

  const devig = cRival ? (1 / c) / ((1 / c) + (1 / cRival)) : null;
  const discrepancia = devig != null ? pe - devig : null;
  const val = pe * c - 1;                                   /* si tenemos razón nosotros */
  const valMercado = devig != null ? devig * c - 1 : null;  /* si tiene razón el mercado */
  const precio = { cuota: c, cuotaRival: cRival ?? null, devig, discrepancia,
    cMinima: 1 / pe, val, valMercado };

  const cuentaMercado = devig != null
    ? ` El mercado la paga a ${c}: ${Math.round(devig * 100)}% una vez sacado su margen. `
      + `A esa cuota, la apuesta rinde ${val >= 0 ? '+' : '−'}${Math.abs(Math.round(val * 100))}% si tenemos razón nosotros `
      + `y ${valMercado >= 0 ? '+' : '−'}${Math.abs(Math.round(valMercado * 100))}% si la tiene el mercado.`
    : ` A ${c}, sin la cuota del rival no se puede descontar el margen de la casa.`;

  /* si la regla apunta al rival, se anota qué cuota necesita él */
  if (regla) {
    regla.cuotaOfrecida = regla.lado === otro.nombre ? (cRival ?? null) : c;
    regla.paga = regla.cuotaOfrecida != null && regla.cuotaOfrecida >= regla.cuotaMin;
  }
  return { tipo: pe < P_SEGURA ? 'flojo' : 'mira', nivel, precio, favorito: nivel.favorito, alertas, regla, contra,
    confianza: alertas.length ? 'media' : 'alta', mercado: 'gana',
    razon: razonNivel + cuentaMercado + (alertas.length ? ' ' + alertas.map(a => a.texto).join(' ') : ''),
    banderas: [`p${Math.round(pe * 100)}%`,
      ...(discrepancia != null ? [`mercado ${discrepancia >= 0 ? '+' : '−'}${Math.abs(Math.round(discrepancia * 100))}`] : []),
      ...alertas.map(a => a.clave)] };
}
