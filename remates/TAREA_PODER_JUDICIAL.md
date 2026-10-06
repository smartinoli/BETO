# Tarea: ebooks del Poder Judicial con Claude in Chrome

Hay que correrla en una sesión **local** (Claude Desktop, pestaña Code, en el clon de este repo)
con la extensión **Claude in Chrome** conectada. La Oficina Judicial Virtual tiene protección
anti-bots (F5) y captcha: no se automatiza con scripts, curl ni Playwright. Si aparece un captcha,
lo resuelve el usuario en su Chrome.

## Objetivo
Para cada remate próximo del Boletín Concursal, buscar su causa en
https://oficinajudicialvirtual.pjud.cl/indexN.php (Consulta de causas), entrar a la causa,
descargar el **ebook** (expediente en PDF), leerlo y resumir lo útil para un postor.

## 1. Lista de causas
```bash
git checkout claude/focused-carson-7jvi5e
python3 remates/remates.py --tipo inmuebles --desde 2026-08-01 --out remates/datos
python3 remates/filtrar_region.py remates/datos/remates.json --out remates/datos/filtrados.json
```
De `remates/datos/filtrados.json`, tomar los remates con `fecha_remate` posterior a hoy y
`suspendido` falso, agrupar por (`rol_causa`, `tribunal`) y ordenar por fecha, el más próximo primero.

## 2. En Chrome (por causa, empezando por las más próximas)
1. `tabs_context_mcp` y abrir una pestaña nueva; no usar las del usuario.
2. Consulta de causas → competencia **Civil** → rol (tipo C, número y año) y tribunal.
   Los nombres de tribunal pueden variar ("3er" / "3º", tildes).
3. Entrar al detalle (la lupa) y descargar el **ebook**. Guardarlo en
   `remates/datos/ebooks/<rol>_<tribunal>.pdf`; si queda en Descargas, moverlo desde ahí.
4. Si una causa no aparece o es ambigua, anotarla y seguir.
5. Si hay captcha o algo falla 2-3 veces, parar y avisar al usuario.

Primero hacer **una sola causa de punta a punta** y mostrarla antes de seguir con el resto.

## 3. Lectura de cada ebook
Con `pdftotext -layout` (si está escaneado, avisar que necesita OCR), extraer:
- estado de la causa y la última resolución con fecha;
- si el remate sigue agendado, se reprogramó o se suspendió, y la fecha vigente;
- mínimo, garantía para participar y plazo para pagar el saldo;
- deudas o gravámenes (contribuciones, gastos comunes, hipotecas, otros embargos);
- ocupación del inmueble y tasación, si las hay.

Guardar todo en `remates/datos/ebooks/resumen.json` (una entrada por causa, con la ruta del PDF)
y mostrar una tabla corta con lo más importante.

## Notas
- `remates/datos/` está en `.gitignore`: los ebooks traen datos personales y **no se suben a git**.
- Si se agrega un script para cruzar o resumir, se commitea en la misma rama.
