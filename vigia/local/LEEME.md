# Leer las cuotas de Betano desde Chile

Betano bloquea la salida a internet de Claude: la IP está en Columbus, Ohio
(datacenter de Google) y todos sus dominios responden **403 de Cloudflare**.
Probado con fetch plano y con Chromium real — mismo resultado, "Betano Splash
Screen" con el cuerpo vacío. Es un bloqueo **geográfico**, no un desafío
antibot: no hay nada que resolver desde allá.

Así que la lectura la hace tu navegador, en Chile, y al repositorio sólo llega
un JSON.

---

## Opción 1 — el snippet (no instala nada, empieza ahora)

1. Abre la página del torneo, por ejemplo
   `https://lat.betano.com/sport/tenis/campeonatos/itf-hombres/10009/`
2. Elige la pestaña del país
3. `F12` → pestaña **Console** → pega **todo** `betano-consola.js` → Enter
4. Se descarga `betano-<País>-<fecha>.json` y además queda copiado
5. Repite por cada pestaña

Verás en la consola una tabla con lo que leyó, para revisarlo antes de subir.

## Opción 2 — el script local (para hacerlo en una pasada)

Una sola vez, en una carpeta cualquiera:

```
npm init -y
npm install playwright
npx playwright install chromium
```

Copia ahí `betano-local.mjs` y `betano-consola.js`, **juntos**. Después:

```
node betano-local.mjs
```

Abre el navegador a la vista. Vas clickeando las pestañas de país y él guarda
un JSON cada vez que ve partidos nuevos. Cuando termines, `Ctrl+C`. Todo queda
en `./cuotas/`.

Si el navegador de Playwright no arranca, usa el Chrome que ya tienes:

```
node betano-local.mjs --chrome "C:\Program Files\Google\Chrome\Application\chrome.exe"
```

## Después, de este lado

```
node vigia/itf-cuotas-archivos.mjs cuotas/*.json
node vigia/itf-mercado.mjs      # ¿el mercado cotiza esta ronda por nivel?
node vigia/itf-proximos.mjs     # las seguras
```

El cargador **verifica cada partido contra el cuadro oficial de la ITF** antes
de guardarlo. Si los nombres no calzan, te lo dice y no escribe nada — así un
archivo del torneo equivocado no ensucia el registro.

## Si algo no lee

Los nombres de clases de Betano cambian sin aviso. Por eso el lector no
depende de ellos: busca el patrón visual (una tarjeta con exactamente dos
cuotas y dos nombres). Aun así, si algún día devuelve cero partidos:

- el snippet guarda el texto crudo de la página dentro del JSON
- el script local guarda `cuotas/pagina-cruda.html`

Mándame cualquiera de los dos y lo ajusto.

## Los PDF siguen sirviendo

`node vigia/itf-cuotas-archivos.mjs archivo.pdf` también funciona. El JSON es
mejor porque trae la hora exacta y el país sin adivinar, pero si un día te
resulta más cómodo imprimir, no se pierde nada.
