# Vigía

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

## Presupuesto

- ~15–35 requests de OddsPapi por ciclo tras el arranque (tope duro configurable);
  el primer día gasta más mientras aprende qué ligas cubre Betano.
- Minutos de GitHub Actions: ~1 por ciclo. Con el horario por defecto
  (09:00–01:00 Chile, cada 15 min) son ~1.700 min/mes — bajo el límite gratis de
  2.000 para repos privados, pero justo: si Actions avisa consumo alto, cambiar
  los cron a `*/20`.

## Familias vigiladas (lista blanca del censo 14-08-2026)

- ⚽ Fútbol: AH tiempo completo y 1er tiempo (solo líneas .0/.5), Goles Más/Menos FT
- 🏀 Básquet: Total del partido, Total 1ª mitad, Total 1er cuarto
- 🎾 Tenis: Hándicap de juegos, Ganador, Ganador 1er set
- ⚾ Béisbol: Run line, Total de carreras, Total primeras 5, Total 1ª entrada, Ganador

Los simulados (SRL/eSoccer/eBasketball) quedan fuera siempre.
