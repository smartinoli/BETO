#!/usr/bin/env python3
"""Filtra remates (salida de remates.py) por región del INMUEBLE, no del lugar del remate.

El campo "Región" del PDF es dónde se realiza el remate (a menudo Santiago/online);
la ubicación del bien viene en el texto del detalle ("comuna de X", "Conservador de
Bienes Raíces de X"). Se buscan ambas cosas.

Uso: python3 filtrar_region.py datos/remates.json [--desde-remate 2026-10-03]
"""
import argparse
import json
import re
import unicodedata

COMUNAS = {
    "Los Ríos": ["Valdivia", "Corral", "Lanco", "Los Lagos", "Máfil", "Mariquina", "Paillaco",
                 "Panguipulli", "La Unión", "Futrono", "Lago Ranco", "Río Bueno",
                 "Niebla", "Coñaripe", "Liquiñe"],
    "Los Lagos": ["Puerto Montt", "Calbuco", "Cochamó", "Fresia", "Frutillar", "Los Muermos",
                  "Llanquihue", "Maullín", "Puerto Varas", "Castro", "Ancud", "Chonchi",
                  "Curaco de Vélez", "Dalcahue", "Puqueldón", "Queilén", "Quellón", "Quemchi",
                  "Quinchao", "Osorno", "Puerto Octay", "Purranque", "Puyehue", "Río Negro",
                  "San Juan de la Costa", "San Pablo", "Chaitén", "Futaleufú", "Hualaihué",
                  "Palena", "Chiloé", "Achao", "Alerce", "Entre Lagos"],
}
REGIONES = {"Los Ríos": r"regi[oó]n de los r[ií]os", "Los Lagos": r"regi[oó]n de los lagos"}


def sin_tildes(s):
    return "".join(c for c in unicodedata.normalize("NFD", s or "") if unicodedata.category(c) != "Mn").lower()


def _patrones(region):
    # Nombres como "Castro", "Osorno" o "Palena" también son calles o apellidos:
    # en el detalle solo cuentan tras "comuna de" o "Conservador de Bienes Raíces de".
    nombres = "|".join(re.escape(sin_tildes(c)) for c in COMUNAS[region])
    return [
        re.compile(r"comuna\s+de\s+(%s)\b" % nombres),
        re.compile(r"conservador\s+de\s+bienes\s+ra[ií]ces\s+de\s+(%s)\b" % nombres),
        re.compile(r"\bcbr\s+(?:de\s+)?(%s)\b" % nombres),
        re.compile(sin_tildes(REGIONES[region])),
    ]


PATRONES = {r: _patrones(r) for r in COMUNAS}


def region_inmueble(reg):
    """Devuelve (region, evidencia) o (None, None)."""
    detalle = sin_tildes(reg.get("detalle"))
    for region, pats in PATRONES.items():
        for p in pats:
            m = p.search(detalle)
            if m:
                return region, m.group(0)
    # sin pista en el detalle: usar la región/comuna donde se remata
    lugar = sin_tildes(f"{reg.get('region')} {reg.get('comuna')}")
    for region in COMUNAS:
        if sin_tildes(region) in lugar or any(sin_tildes(c) == sin_tildes(reg.get("comuna")) for c in COMUNAS[region]):
            return region, f"lugar del remate: {reg.get('comuna')}"
    return None, None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("json")
    ap.add_argument("--desde-remate", help="solo remates con fecha >= YYYY-MM-DD")
    ap.add_argument("--out", help="guardar resultado en este JSON")
    a = ap.parse_args()

    vistos, res = set(), []
    for r in json.load(open(a.json)):
        if a.desde_remate and (r.get("fecha_remate") or "") < a.desde_remate:
            continue
        region, evidencia = region_inmueble(r)
        if not region:
            continue
        # el mismo remate se publica una vez por deudor/aviso: no duplicar
        clave = (r.get("rol_causa"), r.get("fecha_remate"), r.get("valor_minimo"))
        if clave in vistos:
            continue
        vistos.add(clave)
        res.append({**r, "region_inmueble": region, "evidencia": evidencia})

    res.sort(key=lambda r: (r["region_inmueble"], r.get("fecha_remate") or ""))
    for r in res:
        uf = ", ".join(r.get("uf_en_detalle") or [])
        print(f"[{r['region_inmueble']}] {r.get('fecha_remate')} {'SUSPENDIDO ' if r.get('suspendido') else ''}"
              f"${r.get('valor_minimo') or 0:,}{' / UF ' + uf if uf else ''} — {r.get('deudor')} "
              f"({r.get('rol_causa')}, {r.get('tribunal')})\n    {r['evidencia']} | {(r.get('detalle') or '')[:220]}")
    print(f"\n{len(res)} remates")
    if a.out:
        json.dump(res, open(a.out, "w"), ensure_ascii=False, indent=1)


if __name__ == "__main__":
    main()
