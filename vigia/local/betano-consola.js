/* ============================================================
   BETANO → JSON, desde la consola del navegador.

   Corre en la maquina de Sebastian (Chile), donde la pagina SI abre.
   Desde este contenedor betano responde 403: la salida a internet esta
   en Ohio y bloquean por region. Por eso la lectura la hace el navegador
   de el y aca solo llega el JSON.

   COMO SE USA
     1. Abrir https://lat.betano.com/sport/tenis/campeonatos/itf-hombres/10009/
     2. Elegir la pestana del pais/torneo
     3. F12 → pestana "Console" → pegar TODO esto → Enter
     4. Se descarga betano-<pais>-<fecha>.json y ademas queda copiado
     5. Repetir por cada pestana, y subir los JSON

   No depende de nombres de clases CSS, que cambian sin aviso. Busca el
   patron visual: una tarjeta que contenga exactamente DOS numeros con
   forma de cuota y dos nombres. Si algun dia deja de encontrar partidos,
   guarda igual el texto crudo de la pagina para poder arreglarlo.
   ============================================================ */
(() => {
  const ES_CUOTA = /^\s*\d{1,3}[.,]\d{1,2}\s*$/;
  const ES_HORA  = /(\d{1,2})[\/.](\d{1,2})(?:\s+(\d{1,2}:\d{2}))?/;
  const limpio = s => (s || '').replace(/\s+/g, ' ').trim();

  /* hojas cuyo texto es exactamente una cuota */
  const cuotas = [...document.querySelectorAll('*')].filter(el =>
    !el.children.length && ES_CUOTA.test(el.textContent || ''));

  /* subir hasta el contenedor que tenga exactamente 2 cuotas: esa es la tarjeta */
  function tarjetaDe(el) {
    let n = el, ult = null;
    for (let i = 0; i < 12 && n && n !== document.body; i++) {
      const c = [...n.querySelectorAll('*')].filter(x => !x.children.length && ES_CUOTA.test(x.textContent || ''));
      if (c.length === 2) ult = n;
      if (c.length > 2) break;
      n = n.parentElement;
    }
    return ult;
  }

  const vistas = new Set(), partidos = [], dudosos = [];
  for (const c of cuotas) {
    const t = tarjetaDe(c);
    if (!t || vistas.has(t)) continue;
    vistas.add(t);

    const hojas = [...t.querySelectorAll('*')].filter(x => !x.children.length && limpio(x.textContent));
    const nums = hojas.filter(x => ES_CUOTA.test(x.textContent)).map(x => +limpio(x.textContent).replace(',', '.'));
    if (nums.length !== 2) continue;

    const texto = hojas.map(x => limpio(x.textContent));
    const fh = texto.map(x => x.match(ES_HORA)).find(Boolean);
    /* nombres: texto que no es cuota, ni hora, ni etiqueta corta */
    const nombres = texto.filter(x =>
      !ES_CUOTA.test(x) && !ES_HORA.test(x) && x.length >= 4 && x.length <= 46 &&
      /[A-Za-zÀ-ÿ]/.test(x) && !/^(ganador|partido|mas|más|apuestas|en vivo|\+\d+)/i.test(x));
    /* cada nombre aparece dos veces: arriba en el enfrentamiento y junto a su cuota */
    const unicos = [...new Set(nombres)];
    const reg = { p1: unicos[0], p2: unicos[1], g1: nums[0], g2: nums[1],
      fecha: fh ? `${fh[1].padStart(2, '0')}/${fh[2].padStart(2, '0')}` : null,
      hora: fh ? (fh[3] || null) : null };
    if (!reg.p1 || !reg.p2 || reg.p1 === reg.p2) { dudosos.push(limpio(t.innerText).slice(0, 200)); continue; }
    partidos.push(reg);
  }

  /* la pestana elegida: el boton/enlace marcado como activo o seleccionado */
  const acti = [...document.querySelectorAll('[aria-selected="true"],[aria-current],.active,[class*="ctive"]')]
    .map(e => limpio(e.textContent)).filter(t => t && t.length < 40);
  const pais = acti.find(t => /^[A-Za-zÀ-ÿ .\-]+$/.test(t) && !/partido|ganador|inicio|deportes/i.test(t)) || null;

  const salida = {
    fuente: 'betano', url: location.href, pais,
    leidoEn: new Date().toISOString(),
    partidos, dudosos,
    /* red de seguridad: si el parseo falla, con esto se puede arreglar */
    textoCrudo: partidos.length ? undefined : limpio(document.body.innerText).slice(0, 20000),
  };
  const txt = JSON.stringify(salida, null, 1);

  /* En modo automatizado (betano-local.mjs) no se descarga ni se copia:
     el que guarda es el script de afuera. */
  if (window.__VIGIA_SILENCIO__) return salida;

  const nombre = `betano-${(pais || 'torneo').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z]/g, '') || 'torneo'}-${new Date().toISOString().slice(0, 10)}.json`;
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([txt], { type: 'application/json' }));
  a.download = nombre; a.click();
  try { navigator.clipboard.writeText(txt); } catch (e) {}

  console.log(`%c${partidos.length} partidos leídos${pais ? ' · ' + pais : ''}`, 'font-size:15px;font-weight:bold');
  console.table(partidos);
  if (dudosos.length) console.warn(`${dudosos.length} tarjetas no se pudieron leer:`, dudosos);
  if (!partidos.length) console.warn('No encontré partidos. El JSON lleva el texto crudo de la página para poder arreglarlo.');
  console.log(`Se descargó ${nombre} y quedó copiado al portapapeles.`);
  return salida;
})();
