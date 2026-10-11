# BETO · Vigía ITF — memoria del proyecto

Sistema de Sebastián para apostar en ITF masculino (M15/M25) en Betano Chile.
Todo vive en la rama `claude/itf-scrapers-prize-money-7oy59k` (es la rama de
trabajo; los workflows y GitHub Pages apuntan a ella). Hablamos en español,
horas siempre en hora de Chile (`America/Santiago`).

Este archivo es el punto de partida de cualquier sesión nueva. Lo que está
acá se midió: no es opinión.

## Reglas de trato (las impuso Sebastián, siguen vigentes)

- **No hacer cosas que no pidió.** Nada de features extra, nada de "mejoras"
  de pasada. Si algo parece necesario, se propone en una frase y se espera.
- **No lanzar corridas largas ni Actions sin avisar**, salvo que él pida
  "actualiza todo". Avisar antes de correr y contar el resultado después.
- **Simple y rápido.** El botón de Betano tiene que ser: API → partidos →
  tabla. Sin pasos extra, sin límites artificiales de partidos.
- **No mentir en los mensajes**: "no se pudo consultar" ≠ "nadie lo cotiza".
- **Nunca commitear el PAT de GitHub.** Vive solo en el localStorage del
  navegador de Sebastián (`tabla-pat`).
- **Las cuotas salen directo de Betano** (decidido por Sebastián el
  2026-10-11; antes la regla era "Betano no se scrapea nunca"). OddsPapi
  se sacó del sistema ITF ese día. El workflow de fútbol (`vigia.yml`)
  todavía usa su secret `ODDSPAPI_KEY`: no tocarlo.
- **Sin identificadores de modelo** en commits, PRs ni código. Trailer de
  commits: `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>` +
  `Claude-Session: <url de la sesión>`.

## Qué hay y cómo se conecta

Todo en `vigia/`. Datos en `vigia/datos/itf/`.

| Pieza | Archivo | Qué hace |
|---|---|---|
| Scraper ITF (navegador) | `itf-navegador.mjs` | calendario, entry lists (`cosecha`), cuadros + order of play (`oop`). Chromium vía Playwright; la ITF tiene WAF y bloquea seguido. |
| Cuadros sueltos | `itf-cuadros.mjs <claves…>` o `--ahora N` | baja SOLO el drawsheet de torneos dados, con reintento en sesión nueva. Es el rescate cuando el WAF tumba el `oop`. |
| Mapa de torneos | `datos/itf/torneos.json` | semanas → claves (`m-itf-xxx-2026-nnn`), nombres, fechas. |
| Entry lists | `datos/itf/<clave>.aceptacion.json` | fichas: WTN, ATP, ITF, edad, JR, seed, entrada. |
| Cuadros vivos | `datos/itf/vivo/<clave>.json` | rondas, partidos, sets, ganador, `bajado`. |
| Cuotas | `itf-betano.mjs [--horas 36]` | lee el JSON interno de Betano Chile (`betanosports.com/api/sport/tenis/ligas/` → ligas `itf-hombres/<país>/<id>/` → partidos con mercado `HTOH` Ganador). Fetch simple, sin key ni navegador; un pedido por liga. Betano nombra las ligas por PAÍS y separa la quali ("Italia - Clasificación"). El torneo se asigna si el partido cae entre quali y final y los dos jugadores están en la entry list (prefiere cuadro/quali sobre alternos A y retirados W). Escribe `itf-cuotas-bet365.json` (nombre histórico, mismo formato; `fixtureId` = `betano-<id>`). |
| Índice viejo | `datos/itf/historico-indice.json` | fixtures de OddsPapi hasta el 2026-10-11. Ya no se actualiza; el informe lo lee solo para veredictos viejos. |
| Modelo | `itf-modelo.mjs` | logística simétrica sin constante: ΔWTN por grupo de ronda (Q1 / buenas=Q2,R1 / medias=Q3,R2 / finales=QF,SF,F) + escalón sub-19 + games cedidos + torneo anterior + localía. Constantes de fábrica + `datos/itf/modelo-aprendido.json` si existe (`MODELO_ORIGEN`). |
| Aprendizaje | `itf-aprender.mjs` | rearma banco (`itf-banco.mjs` → `_auditoria.json`), refit (`itf-ajuste.mjs`), valida LOTO (dejando un torneo afuera) y escribe el aprendido SOLO si mejora el log-loss. `--probar` = simulacro. |
| Rating Elo | `itf-rating.mjs` → `datos/itf/rating.json` | Elo propio desde los cuadros, con z-score por era del WTN (la ITF recalibró el WTN el 26-08: mediana 13.9 → 8.1; `CORTE_ESCALA`). Imprime la "evaluación honesta". Hoy es decorativo: no entra en la decisión. |
| Informe/veredictos | `itf-informe.mjs --bet365` | cruza cuotas con fichas y cuadros, calcula prob del modelo, califica resultados (`datos/itf/veredictos-historia.json`), exporta `itf-tabla.json` y `itf-informe.html`. |
| Tabla | `itf-tabla.mjs` → `itf-tabla.html` | la página de uso diario (ver abajo). |
| Rutina del día | `itf-dia.mjs [--horas N]` | Betano → informe → tabla. |
| Torneos "de ahora" | `itf-ahora.mjs` | torneos ITF Men cuya semana (quali → final) cae en las próximas N h, según `torneos.json`. Lo usa `itf-cuadros --ahora`. |
| Workflow | `.github/workflows/tabla.yml` | `workflow_dispatch` con input `que`: `betano` (itf-dia --horas 36), `cuadros-ahora` (itf-cuadros --ahora 36 + informe + tabla), `todo` (calendario + cosecha + oop + rating + itf-dia), `modelo` (itf-aprender). Commitea como `vigia-bot` ("tabla: corrida a pedido …") y publica `index.html` + `tabla.html` en Pages: https://smartinoli.github.io/BETO/ |

Hay más scripts en `vigia/` (`vigia.mjs` y `vigia.yml` son el sistema viejo
de fútbol AH; `vigia/README.md` habla de eso). No tocarlos.

## La página (tabla.html)

Una fila por jugador (dos por partido): cuota, % modelo, **valor**
(= % × cuota), rival (datos apagados), torneo, edad, WTN, ITF, ATP, jr,
local, hora de Chile. Solo partidos **que no han empezado y tienen cuota**
de los dos lados. Marcas: `(3)` sembrado, `(Q)`, `(WC)`, `[JR]`. Todas las
columnas ordenan y filtran; filtro de ronda Q/R1/R2/F. ★ = pisa la casilla
del manual. Verde en valor solo si modelo ≥ 80 % y valor ≥ 1.08.
Todas las cuotas son de Betano. El nombre abre el buscador de Betano.

Cuatro botones que disparan `tabla.yml` por la API de GitHub con el PAT del
navegador: **1·Cuadros de ahora**, **2·Betano ahora**, Semana completa,
Que aprenda el modelo.

## Rutina semanal (lo que de verdad hay que hacer)

1. **Lunes o martes**: botón *Semana completa* (10–15 min). Baja calendario,
   listas, cuadros y rating de la semana nueva, y califica la anterior.
2. **El WAF deja cuadros afuera casi siempre** (bajó 4 de 13 varias veces).
   Rescate: `ITF_CHROME=/opt/pw-browsers/chromium node vigia/itf-cuadros.mjs <claves que faltan>`,
   repetir con los que fallen (2–3 pasadas). Luego `node vigia/itf-rating.mjs`,
   `node vigia/itf-aprender.mjs`, `node vigia/itf-informe.mjs --bet365`,
   `node vigia/itf-tabla.mjs`, commit y push. Para saber qué falta: comparar
   `torneos.json` semana actual contra `bajado` de `datos/itf/vivo/*.json`.
   (Playwright local: `npm i --no-save playwright@1.54`; `node_modules` está
   en `.gitignore`.)
3. **Cada día que se juega**: botón *Betano ahora* (1–2 min). Mirar solo ★ y
   verdes. Si no hay, no se apuesta.
4. **Si pasan semanas sin apretar botones** se pierden las cuotas de esas
   semanas (no se capturan hacia atrás) y los cuadros cuestan tres pasadas.
   Los resultados sí se recuperan después (alimentan modelo y rating), la
   medición contra el mercado no.

## Lo medido (748 partidos calificados con cuota, 24-08 → 06-10)

Acierto del modelo semana a semana: 70, 71, 70, 76, 66 %. Calibrado: cuando
dice 80–89 cumple ~83–86; 90–94 → 92; 95+ → 95.

Favorito del mercado con cuota 1.20–1.99:

| Segmento | n | gana | rinde |
|---|---|---|---|
| **R1 modelo 90+ o R2 modelo 80+** (la regla) | 15 | 100 % | **+34 %** |
| R1 modelo 80–89 | 29 | 76 % | +2 % |
| R2 modelo 80–89 | 6 | 100 % | +29 % |
| QF / SF / F | pocos | modelo 56 % < mercado 61 % | no jugar |
| Trámites (cuota < 1.20) | 266 | 86 % | **−6 %** |
| Contra el mercado (modelo elige al no favorito) | 89 | 66 % | −1 % |

**Regla del manual**: favorito del mercado a 1.20–1.99, y modelo ≥ 90 % en R1
o ≥ 80 % en R2, valor ≥ 1.08. Nada en QF/SF/F, nada bajo 1.20, nunca contra
el mercado aunque la columna valor sea grande. Volumen: ~3 jugadas por
semana, semanas con cero. Eso es lo que da +34 %. (La casilla del informe
todavía marca 80 %+ en R1: las jugadas de 80–89 en R1 que salieron bien
fueron suerte, no regla. Pendiente decidir si endurecer la casilla.)

Las 3 de la semana 37 (todas ganadas, +31 %): Palomar 1.26 (R1, 81 %, fuera
de regla estricta), Sumizawa 1.22 (R1, 90 %), Deflandre 1.44 (R2, 91 %).

## El modelo, en números

- Banco: 6401 partidos sin junior élite (06-10). Log-loss LOTO 0.4949,
  acierto 76.0 %. Constantes aprendidas: pendiente por grupo ≈ Q1 0.44 /
  buenas 0.45 / medias 0.40 / finales 0.30; **sub-19 0.98** (era 1.66 el
  02-09, baja cada semana con más datos); cedidos 1.57; previo 0.36;
  local 0.13.
- **El escalón sub-19 NO castiga de más** (medido 2026-09-07 sobre 3164
  partidos): con brecha de WTN chica el favorito mayor pierde más de lo que
  gana (0–1: gana 10 %; 1–2: 38 %; 2–3: 42 %). Toparlo o impedir que dé
  vuelta al favorito empeora el LOTO. No tocar. Lo que sí: donde el modelo
  da vuelta al favorito del mercado, el mercado ha acertado más (8 casos,
  2 aciertos). Casi no hay cuotas en esa zona.
- Señales medidas y descartadas: ATP, ranking ITF, ranking nacional,
  sembrado, tipo de entrada, superficie, categoría, mismo país.
- Elo (8314 partidos, 3325 jugadores): log-loss 0.530 vs WTN 0.551, acierto
  73.7 vs 75.6 %. Mejor calibrado, no mejor en acierto. Cubre ~la mitad de
  los jugadores (3+ partidos). Candidato a entrar como mezcla cuando tenga
  más historia; probar contra cuotas antes.

## Cosas que ya pasaron y no hay que volver a aprender

- Betano (2026-10-11): su JSON responde 403 al user-agent de Python y 200
  a `node`, `curl` y `Mozilla/5.0`. La página de liga ITF Hombres redirige
  a la portada de Tenis aunque haya partidos: no fiarse de lo que se ve,
  el JSON sí los trae. `lat.betano.com` da error de certificado en el
  navegador del panel; el sitio de Chile es `betanosports.com`.
- ITF y el navegador del panel (2026-10-11): el WAF (Imperva) bloquea al
  quinto request igual que con Playwright y muestra CAPTCHA. El navegador
  no lo resuelve.
- Lo de OddsPapi que sigue abajo es historia: ya no se usa en ITF.

- OddsPapi: `tournamentName` es solo la ciudad; categoría "ITF Men"/"ITF
  Women" (filtrar). Los fixtures ITF se publican y despublican. El mercado
  abre ~11 h antes (10 h en Asia). Betano cubre ~30 % de los partidos en la
  API, bet365 ~80 %. Del 03-09 al 06-09 la API no trajo Betano ni bet365
  para ningún ITF (solo cloudbet) y sí para el US Open: fue de su lado, se
  arregló solo. `NOT_FOUND` = la API no tiene cuota de nadie todavía.
- Rate limit: 2.6 s entre requests ya da RATE_LIMITED; 3.2 s aguanta. Un
  martes cargado son ~100 partidos, ~6 min.
- El timeout de 15 min en itf-dia mató una corrida y se perdió todo porque
  se escribía al final → ahora 35 min y escritura incremental.
- `continue-on-error` en los pasos de scrape del workflow: si un paso muere
  por timeout, `|| echo` no corre y antes se caía el job entero.
- El botón de Betano estuvo limitado a 8 h y Sebastián lo vio "pegado con
  dos tres campeonatos": ahora 36 h, semana entera.
- La cuenta de OddsPapi es plan dev, 100 000 requests/mes, casas bet365,
  betano, cloudbet, deportes 10 y 12. Las Betano regionales (pe, mx, pt…)
  están en la lista de OddsPapi pero no en el plan; Chile no existe como
  casa separada.
- Commits del bot chocan con los nuestros: `git pull --rebase` antes de
  push; si hay conflicto en JSON generados, tomar el remoto y regenerar.

## Pendientes (ninguno urgente, todos a decisión de Sebastián)

- Endurecer la casilla del informe a la regla medida (R1 90+, R2 80+, nada
  en QF+).
- Medir si el Elo (o la mezcla) mejora las jugadas contra cuotas.
- Retomar el botón de Betano los días de juego para no perder la medición.
- Semana 40 (28-09 a 04-10) quedó sin cuotas capturadas: 2 partidos
  calificados. No se recupera.

## Artefactos publicados

- Tabla: https://smartinoli.github.io/BETO/tabla.html (también artifact
  216a6da6-2813-411a-b5d4-a3cddaed6f2b).
- Informe: https://smartinoli.github.io/BETO/ (artifact
  069ed53d-c784-4c4d-8e7f-bb983e5dbf64).
