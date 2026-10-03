# Remates – Boletín Concursal

Baja las publicaciones de remates de https://www.boletinconcursal.cl/boletin/remates,
descarga cada PDF y extrae sus campos a JSON/CSV.

Requisitos: Python 3 + `requests`, y `pdftotext` (paquete `poppler-utils`).

```bash
python3 remates.py                                   # lo publicado hoy (muebles + inmuebles)
python3 remates.py --tipo inmuebles --desde 2026-09-01
python3 remates.py --max 50 --solo-listar            # sin bajar PDFs
```

Salida en `datos/`: `pdf/<codigo>.pdf` (caché: no se re-descargan), `remates.json`, `remates.csv`.

## Cómo funciona el sitio
| Paso | Request |
|---|---|
| Sesión | `GET /boletin/remates` → cookie + token CSRF en `<meta name="_csrf">` |
| Listado muebles | `POST /boletin/getRMP/` `draw,start,length` + header `X-CSRF-TOKEN` |
| Listado inmuebles | `POST /boletin/getRIP/` (igual) |
| PDF | `POST /boletin/downloadDocumentoByCodigo` `codigoValidacion=…&_csrf=…` |

El listado viene ordenado de más nuevo a más antiguo (~27 mil muebles, ~9 mil inmuebles).

## Campos extraídos del PDF
fecha_remate, tipo_procedimiento, rol_causa, tribunal, deudor, deudor_rut, liquidador,
region, comuna, direccion, detalle, tipo_bienes, valor_minimo (pesos, int), comision (%),
fecha_publicacion, uf_en_detalle (montos "UF …" hallados en el detalle), suspendido/aviso.

Ojo:
- `valor_minimo` = 0 o 1 es común en muebles (sin mínimo publicado).
- `suspendido = true` cuando el PDF es un "Aviso de Suspensión de Remate".
- `tipo_bienes = "No especificado"` cuando el PDF trae la tabla con todas las categorías sin marca.
