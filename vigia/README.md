# Vigía

> **Modo actual: 100% FOCO en AH (fútbol), bajo demanda.** El bot no manda
> alertas solo: escucha tu chat de Telegram y barre cuando se lo pides. Todo
> el sistema mide UNA sola cosa: hándicap asiático (y su gemelo DNB) de
> fútbol, cuota 1.6–3.0.
>
> - **Sombras apagadas** (`"sombras": false`): ya no se anotan ni liquidan
>   apuestas fantasma — cero requests en calibración. Las sombras viejas
>   quedan congeladas en `registro.json` como historial.
> - **Props apagados** (`"propsPrueba": false`): el espejo de líneas de
>   jugador tampoco anota nada.
> - **`/tablero` muestra solo lo que estamos jugando**: AH fútbol filtrado
>   por los criterios vigentes del config (cuota y ventaja mínima), con DNB
>   contado como AH 0.0 — total y desglose FT/1T, sin bandas ni rangos.
>   `/tablero todo` da el historial completo (criterios viejos, otras
>   familias, otros deportes, sombras liquidadas).
> - `/itf` sigue disponible bajo demanda, pero ya no escribe sombras al
>   registro: solo alimenta su propio tablero de favoritos (`itf.json`).
>
> Para volver a medir más cosas: reencender `sombras`/`propsPrueba` en
> `config.json` y commitear.
>
> | Comando | Qué hace | Costo |
> |---|---|---|
> | `/barrer` | barrido del foco (fútbol) | ~110 requests, ~2 min |
> | `/rapido` | solo lo que empieza dentro de 6 h | ~30 requests |
> | `/tablero` | balance del foco AH/DNB | requests solo al liquidar |
> | `/estado` | cuota de API y último barrido | gratis |
> | `/ayuda` | lista de comandos | gratis |
>
> Escuchar no gasta requests de OddsPapi. El cron levanta un escucha cada 30
> min que vive ~28 min; si mandas un comando cuando no hay ninguno vivo, el
> mensaje espera en Telegram y se atiende al despertar el siguiente.


Barrido continuo de Betano vs el justo de Cloudbet (des-vigado) sobre OddsPapi v4.
Corre en GitHub Actions cada 15 minutos dentro del horario configurado y manda a
Telegram cada señal nueva, cada ventana ▼ (el justo bajó y Betano no siguió) y las
señales que Betano ajustó.

## Piezas

- `vigia.mjs` — el motor. Node 20+, sin dependencias.
- `config.json` — todos los criterios (ventaja mínima por deporte, cuota máxima,
  Kelly, horario, tope de requests por ciclo…). Editar y commitear: el próximo
  ciclo lo toma.
- `estado.json` — memoria entre ciclos (señales vivas, cachés, cobertura de ligas).
  Lo commitea el propio workflow; no editar a mano.
- `../.github/workflows/vigia.yml` — el reloj.

## Secretos requeridos (Settings → Secrets and variables → Actions)

| Secreto | Contenido |
|---|---|
| `ODDSPAPI_KEY` | API key de OddsPapi |
| `TELEGRAM_BOT_TOKEN` | token del bot (de @BotFather) |
| `TELEGRAM_CHAT_ID` | id numérico de tu chat con el bot |

## Probar a mano

Pestaña **Actions → Vigía → Run workflow**. Sin los secretos de Telegram el ciclo
corre igual y las señales quedan en el log (modo seco).

Local: `DRY=1 ODDSPAPI_KEY=... node vigia/vigia.mjs`

## Cadencia real (por qué "turnos" y no un ciclo por cron)

GitHub Actions ejecuta los `schedule` con criterio *best effort*: bajo carga
**salta ventanas** (medido acá: dispararon 3 de 8 ventanas de 15 min). Para que
la cadencia no dependa de esa lotería, cada ejecución es un **turno de 3 ciclos
separados por 12 minutos**, y el cron dispara cada 30 min. Aunque el scheduler
falle un par de veces, los ciclos siguen cayendo cada ~12 min.

Si el script devuelve código 3 (fuera del horario de Santiago), el turno se
corta ahí en vez de dormir en vano. `concurrency: vigia` impide que dos turnos
se pisen; un turno que llegue mientras otro corre queda encolado.

## Presupuesto

- ~15–35 requests de OddsPapi por ciclo tras el arranque (tope duro configurable);
  el primer día gasta más mientras aprende qué ligas cubre Betano.
- Minutos de GitHub Actions: ~1 por ciclo. Con el horario por defecto
  (09:00–01:00 Chile, cada 15 min) son ~1.700 min/mes — bajo el límite gratis de
  2.000 para repos privados, pero justo: si Actions avisa consumo alto, cambiar
  los cron a `*/20`.

## Familias vigiladas (lista blanca del censo 14-08-2026, ampliada)

- ⚽ Fútbol: AH FT y 1T (líneas .0/.5) · Goles Más/Menos FT y 1T · Goles por
  equipo (FT/1T/2T) · Empate no válido FT y 1T · Ambos marcan FT y 1T ·
  *castigadas al 5%:* córners (total FT/1T y hándicap) y tarjetas hándicap
- 🏀 Básquet: Total del partido · Totales por mitad · Totales por cuarto
  (hándicap fuera: sin cruce con Cloudbet en el censo — revisar con NBA)
- 🎾 Tenis: Hándicap de juegos · Ganador · Ganador 1er set · Gana un set (sí/no)
- ⚾ Béisbol: Run line · Total de carreras · Total F5 · Total 1ª entrada ·
  Ganador · Carreras por equipo · *castigada:* entrada extra sí/no
- Líneas: la central marcada por el feed **± 1 vecina** (`lineasVecinas`);
  una sola alerta por familia y partido (gana la de mayor ventaja).

Los simulados (SRL/eSoccer/eBasketball) y el par/impar quedan fuera siempre.

## Scraper ITF (`itf.mjs`)

Scraper de itftennis.com para el World Tennis Tour (M15/M25/W15…), pensado
para leer cuadros y qualis donde suele estar el valor: el primer día del
main draw y la fase previa. Sin dependencias (Node 20+).

```
node vigia/itf.mjs calendario [MT|WT] [desde] [hasta]   torneos con prize money
node vigia/itf.mjs torneo <clave|url>                   resumen de cuadros
node vigia/itf.mjs cuadro <clave|url> [M|Q] [S|D]       cuadro con resultados
node vigia/itf.mjs qualis <clave|url>                   atajo: qualifying singles
```

La clave sale de la URL pública (`m-itf-bel-2026-004`). Por partido entrega
jugadores, seed, estado de entrada (Q/LL/WC/SE/DA), sets y ganador; no hay
horarios (el order of play no está expuesto en la API abierta).

Detalle técnico: el sitio va tras Incapsula, pero `GetDrawsheet` y
`GetEventFilters` responden a un fetch pelado a ritmo humano (~1 request
por 1.5 s; una ráfaga dispara el desafío y el módulo espera y reintenta).
`GetCalendar` sí está bloqueado desde IPs de datacenter: `calendario`
intenta directo y si no, cae a `itf-calendario.json` (caché commiteado,
refrescable abriendo la URL del endpoint en un navegador normal).
