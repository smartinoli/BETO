#!/usr/bin/env python3
"""Junta inmuebles (salida de filtrar_region.py) y muebles (salida de remates.py) en un
solo JSON compacto para la página de remates.

Uso: python3 datos_artifact.py inmuebles_filtrados.json muebles_remates.json salida.json
"""
import json
import re
import sys
from datetime import date

from comunas import NOMBRE_REGION, REGIONES
from filtrar_region import REGION_DE, sin_tildes

# Campos que llegan a la página (sin RUT del deudor)
CAMPOS = ["codigoValidacion", "fecha_remate", "fchPublicacion", "suspendido", "aviso", "valor_minimo",
          "uf_en_detalle", "comision", "tipo_bienes", "tipo_procedimiento", "rol_causa", "tribunal",
          "deudor", "liquidador", "entePublicador", "direccion", "comuna", "region", "detalle"]

_ALIAS_REGION = sorted(((a, r) for r, al in NOMBRE_REGION.items() for a in al), key=lambda x: -len(x[0]))
_PATENTE = re.compile(r"(?:patente|ppu|inscripci[oó]n|placa)\s*(?:n[°º.]*\s*)?:?\s*([A-Z]{2,4}[.\s-]?\d{2,4}(?:-[\dK])?)", re.I)
_ANIO = re.compile(r"a[ñn]o\s*:?\s*((?:19|20)\d{2})\b", re.I)


def region_lugar(texto, comuna=None):
    """'Región de la Araucanía' -> 'Araucanía'. Si el PDF no trae región, se deduce de la comuna."""
    t = sin_tildes(texto)
    for alias, region in _ALIAS_REGION:
        if alias in t:
            return region
    return REGION_DE.get(sin_tildes(comuna), "No determinada")


def vehiculos(detalle):
    pats = list(dict.fromkeys(m.group(1).upper().replace(" ", "") for m in _PATENTE.finditer(detalle or "")))
    anios = list(dict.fromkeys(_ANIO.findall(detalle or "")))
    return pats, anios


def compactar(r, clase):
    o = {k: r.get(k) for k in CAMPOS}
    o["clase"] = clase
    if clase == "inmuebles":
        o["region_x"] = r["region_inmueble"]
        o["comuna_x"] = r.get("comuna_inmueble")
        o["regiones"] = r.get("regiones") or [r["region_inmueble"]]
        o["comunas"] = r.get("comunas_mencionadas") or []
        o["evidencia"] = r.get("evidencia")
    else:
        # en muebles la ubicación útil es dónde se remata/exhibe
        reg = region_lugar(r.get("region"), r.get("comuna"))
        com = (r.get("comuna") or "").title() or None
        o["region_x"], o["comuna_x"] = reg, com
        o["regiones"], o["comunas"] = [reg], [com] if com else []
        o["patentes"], o["anios"] = vehiculos(r.get("detalle"))
    return {k: v for k, v in o.items() if v not in (None, "", [], False)}


def main():
    inm, mue, salida = sys.argv[1:4]
    datos = [compactar(r, "inmuebles") for r in json.load(open(inm))]

    vistos = set()
    for r in json.load(open(mue)):
        if "error" in r or not r.get("fecha_remate"):
            continue
        # el mismo remate se republica (p. ej. un aviso de suspensión): queda el más reciente,
        # que es el primero porque el listado viene de nuevo a viejo
        clave = (r.get("rol_causa"), r.get("fecha_remate"), r.get("valor_minimo"), (r.get("detalle") or "")[:120])
        if clave in vistos:
            continue
        vistos.add(clave)
        datos.append(compactar(r, "muebles"))

    out = {"generado": date.today().isoformat(), "regiones": list(REGIONES) + ["No determinada"], "remates": datos}
    json.dump(out, open(salida, "w"), ensure_ascii=False, separators=(",", ":"))
    n = {c: sum(d["clase"] == c for d in datos) for c in ("inmuebles", "muebles")}
    print(f"{n} -> {salida}")


if __name__ == "__main__":
    main()
