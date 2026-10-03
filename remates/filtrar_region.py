#!/usr/bin/env python3
"""Asigna región y comuna del INMUEBLE a cada remate (salida de remates.py) y filtra.

El campo "Región" del PDF es dónde se realiza el remate (a menudo Santiago/online);
la ubicación del bien viene en el texto del detalle ("comuna de X", "Conservador de
Bienes Raíces de X"). Si no se logra deducir, queda como "No determinada".

Uso: python3 filtrar_region.py datos/remates.json --out datos/filtrados.json
     python3 filtrar_region.py datos/remates.json --region "Los Ríos" --region "Los Lagos"
"""
import argparse
import json
import re
import unicodedata

from comunas import NOMBRE_REGION, REGIONES

SIN_REGION = "No determinada"


def sin_tildes(s):
    return "".join(c for c in unicodedata.normalize("NFD", s or "") if unicodedata.category(c) != "Mn").lower()


CANONICA, REGION_DE = {}, {}
for _region, _comunas in REGIONES.items():
    for _c in _comunas:
        CANONICA[sin_tildes(_c)] = _c
        REGION_DE[sin_tildes(_c)] = _region

# nombres más largos primero: "san pedro de la paz" antes que "san pedro"
_NOMBRES = "|".join(re.escape(n) for n in sorted(CANONICA, key=len, reverse=True))

# En orden de confiabilidad. Nombres como "Castro" o "San Pablo" también son calles o
# apellidos, por eso nunca se busca el nombre suelto.
PATRONES = [
    re.compile(r"comuna\s+(?:y\s+departamento\s+)?de\s+(%s)\b" % _NOMBRES),
    re.compile(r"conser[vb]ador\s+de\s+bienes\s+raices\s+(?:de|del)\s+(%s)\b" % _NOMBRES),
    re.compile(r"\bc\.?b\.?r\.?\s+(?:de\s+)?(%s)\b" % _NOMBRES),
    re.compile(r"comunas\s+de\s+[^.]{0,150}?\b(%s)\b" % _NOMBRES),   # "comunas de A, B y X"
    re.compile(r"(?:^|[/.:]\s*)(%s)\s*-" % _NOMBRES),                  # "/ Los Lagos-Calle 123"
    re.compile(r"\b(?:ciudad|localidad)\s+de\s+(%s)\b" % _NOMBRES),
    re.compile(r"\ben\s+(%s)," % _NOMBRES),                            # "En Puerto Montt, existen..."
]
PATRON_REGION = re.compile(r"region\s+(?:de\s+la\s+|del\s+|de\s+)?(%s)\b" % "|".join(
    re.escape(a) for alias in NOMBRE_REGION.values() for a in alias))
_REGION_ALIAS = {a: r for r, alias in NOMBRE_REGION.items() for a in alias}


def ubicar(reg):
    """Devuelve (region, comuna, evidencia, todas) donde `todas` son las comunas
    mencionadas (un remate puede incluir propiedades en varias comunas)."""
    detalle = sin_tildes(reg.get("detalle"))
    todas, principal = [], None
    for p in PATRONES:
        for m in p.finditer(detalle):
            n = m.group(1)
            if principal is None:
                principal = (REGION_DE[n], CANONICA[n], m.group(0))
            if CANONICA[n] not in todas:
                todas.append(CANONICA[n])
    if principal:
        return (*principal, todas)
    m = PATRON_REGION.search(detalle)
    if m:
        return _REGION_ALIAS[m.group(1)], None, m.group(0), []
    return SIN_REGION, None, None, []


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("json")
    ap.add_argument("--region", action="append", help="filtrar por región (repetible); default: todas")
    ap.add_argument("--desde-remate", help="solo remates con fecha >= YYYY-MM-DD")
    ap.add_argument("--out", help="guardar resultado en este JSON")
    a = ap.parse_args()

    vistos, res = set(), []
    for r in json.load(open(a.json)):
        if a.desde_remate and (r.get("fecha_remate") or "") < a.desde_remate:
            continue
        region, comuna, evidencia, todas = ubicar(r)
        regiones = list(dict.fromkeys([region] + [REGION_DE[sin_tildes(c)] for c in todas]))
        if a.region and not set(regiones) & set(a.region):
            continue
        # el mismo remate se publica una vez por deudor/aviso: no duplicar
        clave = (r.get("rol_causa"), r.get("fecha_remate"), r.get("valor_minimo"))
        if clave in vistos:
            continue
        vistos.add(clave)
        res.append({**r, "region_inmueble": region, "comuna_inmueble": comuna, "evidencia": evidencia,
                    "comunas_mencionadas": todas, "regiones": regiones})

    orden = list(REGIONES) + [SIN_REGION]
    res.sort(key=lambda r: (orden.index(r["region_inmueble"]), r.get("fecha_remate") or ""))
    conteo = {}
    for r in res:
        conteo[r["region_inmueble"]] = conteo.get(r["region_inmueble"], 0) + 1
    for reg in orden:
        if reg in conteo:
            print(f"{reg:20} {conteo[reg]}")
    print(f"{'TOTAL':20} {len(res)}")
    if a.out:
        json.dump(res, open(a.out, "w"), ensure_ascii=False, indent=1)


if __name__ == "__main__":
    main()
