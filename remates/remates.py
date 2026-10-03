#!/usr/bin/env python3
"""Scraper de Publicaciones de Remates del Boletín Concursal (boletinconcursal.cl).

Cómo funciona el sitio:
  1. GET  /boletin/remates                -> cookie de sesión + token CSRF (<meta name="_csrf">)
  2. POST /boletin/getRMP/  (muebles)     -> JSON DataTables paginado (draw/start/length)
     POST /boletin/getRIP/  (inmuebles)      con header X-CSRF-TOKEN. Orden: más nuevo primero.
  3. POST /boletin/downloadDocumentoByCodigo  codigoValidacion=...&_csrf=...  -> PDF
  Los PDFs son texto (no escaneados), se leen con pdftotext (poppler-utils).

Uso:
  python3 remates.py --tipo inmuebles --desde 2026-09-01
  python3 remates.py --tipo ambos --max 50 --out datos
"""
import argparse
import csv
import json
import re
import subprocess
import sys
import time
from datetime import date
from pathlib import Path

import requests

BASE = "https://www.boletinconcursal.cl/boletin"
ENDPOINTS = {"muebles": "getRMP", "inmuebles": "getRIP"}
PAGINA = 100


class Boletin:
    def __init__(self, pausa=0.5):
        self.s = requests.Session()
        self.s.headers["User-Agent"] = "Mozilla/5.0 (remates-scraper)"
        self.pausa = pausa
        self.token = None

    def _sesion(self):
        html = self.s.get(f"{BASE}/remates", timeout=30).text
        m = re.search(r'name="_csrf" content="([^"]+)"', html)
        if not m:
            raise RuntimeError("No se encontró el token CSRF")
        self.token = m.group(1)

    def _post(self, url, **kw):
        if not self.token:
            self._sesion()
        for intento in range(2):
            r = self.s.post(url, timeout=60, **kw)
            # sesión vencida -> el servidor responde 403 o redirige a HTML
            if r.status_code == 403 or "text/html" in r.headers.get("Content-Type", ""):
                self._sesion()
                kw = _refrescar_token(kw, self.token)
                continue
            r.raise_for_status()
            return r
        r.raise_for_status()
        raise RuntimeError(f"Respuesta inesperada de {url}")

    def listar(self, tipo, desde=None, maximo=None):
        """Itera publicaciones (más nuevas primero) hasta `desde` o `maximo`."""
        url = f"{BASE}/{ENDPOINTS[tipo]}/"
        start, n = 0, 0
        while True:
            r = self._post(url, data={"draw": 1, "start": start, "length": PAGINA},
                           headers={"X-CSRF-TOKEN": self.token or "",
                                    "X-Requested-With": "XMLHttpRequest"})
            js = r.json()
            filas = js.get("data") or []
            for f in filas:
                if desde and f["fchPublicacion"] < desde:
                    return
                f["tipo"] = tipo
                yield f
                n += 1
                if maximo and n >= maximo:
                    return
            start += PAGINA
            if not filas or start >= js.get("recordsTotal", 0):
                return
            time.sleep(self.pausa)

    def descargar(self, codigo, destino: Path):
        if destino.exists() and destino.stat().st_size > 0:
            return destino
        r = self._post(f"{BASE}/downloadDocumentoByCodigo",
                       data={"documento": "", "codigoValidacion": codigo, "_csrf": self.token or ""})
        if not r.content.startswith(b"%PDF"):
            raise RuntimeError(f"{codigo}: la respuesta no es un PDF")
        destino.write_bytes(r.content)
        time.sleep(self.pausa)
        return destino


def _refrescar_token(kw, token):
    if "headers" in kw and "X-CSRF-TOKEN" in kw["headers"]:
        kw["headers"]["X-CSRF-TOKEN"] = token
    if "data" in kw and "_csrf" in kw["data"]:
        kw["data"]["_csrf"] = token
    return kw


# ---------- lectura del PDF ----------

CAMPOS = {
    "Fecha del Remate": "fecha_remate",
    "Tipo Procedimiento": "tipo_procedimiento",
    "Rol Causa": "rol_causa",
    "Tribunal": "tribunal",
    "Deudor": "deudor",
    "Deudor Rut": "deudor_rut",
    "Liquidador": "liquidador",
    "Región": "region",
    "Comuna": "comuna",
    "Dirección": "direccion",
    "Valor Mínimo (pesos)": "valor_minimo",
    "Comisión": "comision",
    "Publicado en": "publicado_en",
    "Fecha": "fecha_publicacion",
}
_ETIQUETA = re.compile(r"(%s):" % "|".join(re.escape(k) for k in sorted(CAMPOS, key=len, reverse=True)))


def pdf_a_texto(ruta: Path) -> str:
    return subprocess.run(["pdftotext", "-layout", str(ruta), "-"],
                          capture_output=True, text=True, check=True).stdout


def parsear(texto: str) -> dict:
    lineas = [l.strip() for l in texto.splitlines()]
    out, seccion, detalle, tipo_bienes, direccion = {}, "cabecera", [], [], []
    aviso = []
    for l in lineas:
        if not l or l == "Publicación Martillero" or l.startswith("https://"):
            continue
        if l in ("Detalle", "Tipo Bienes", "Dirección del Remate"):
            seccion = l
            continue
        partes = _ETIQUETA.split(l)
        if len(partes) > 1 and partes[0] == "":
            # una línea puede traer dos campos: "Región: X   Comuna: Y"
            for etiqueta, valor in zip(partes[1::2], partes[2::2]):
                if CAMPOS[etiqueta] == "direccion":
                    direccion.append(valor.strip())
                else:
                    out[CAMPOS[etiqueta]] = valor.strip()
            if seccion != "Dirección del Remate":  # incluye salir de "cabecera"
                seccion = None
            continue
        if seccion == "cabecera":
            # p.ej. "Aviso de Suspensión de Remate"
            aviso.append(l)
        elif seccion == "Detalle":
            detalle.append(l)
        elif seccion == "Tipo Bienes":
            tipo_bienes.append(l)
        elif seccion == "Dirección del Remate":
            # una dirección larga queda partida arriba y abajo de la etiqueta
            direccion.append(l)
    out["direccion"] = " ".join(d for d in direccion if d)
    out["detalle"] = " ".join(detalle)
    out["tipo_bienes"] = _tipo_bienes(tipo_bienes)
    out["aviso"] = " ".join(aviso)
    out["suspendido"] = "suspensi" in out["aviso"].lower()
    _normalizar(out)
    return out


CATEGORIAS = ["Inmuebles", "Vehiculos", "Maquinas y Herramientas", "Equipos Varios",
              "Muebles y Equipos de Oficina", "Muebles de Hogar", "Otros"]


def _tipo_bienes(lineas):
    """Normalmente viene una sola categoría. A veces el PDF trae la tabla con todas
    las categorías y ninguna marca legible: en ese caso no se puede saber cuál es."""
    texto = re.sub(r"\s+", " ", " ".join(lineas))
    encontradas = [c for c in CATEGORIAS if c in texto or c.replace("de Oficina", "de") in texto]
    if len(encontradas) == len(CATEGORIAS):
        return "No especificado"
    return " | ".join(encontradas) or texto


def _fecha_iso(s):
    m = re.match(r"(\d{2})/(\d{2})/(\d{4})(?:\s+(\d{2}:\d{2}))?", s or "")
    if not m:
        return s
    d = f"{m[3]}-{m[2]}-{m[1]}"
    return f"{d} {m[4]}" if m[4] else d


def _normalizar(o):
    o["fecha_remate"] = _fecha_iso(o.get("fecha_remate"))
    o["fecha_publicacion"] = _fecha_iso(o.get("fecha_publicacion"))
    v = re.sub(r"[^\d]", "", o.get("valor_minimo", ""))
    o["valor_minimo"] = int(v) if v else None
    m = re.search(r"[\d.,]+", o.get("comision", ""))
    o["comision"] = float(m.group().replace(".", "").replace(",", ".")) if m else None
    # Montos en UF que suelen venir en el detalle ("MÍNIMO UF3.900")
    o["uf_en_detalle"] = re.findall(r"UF\s?(\d{1,3}(?:\.\d{3})*(?:,\d+)?)", o.get("detalle", ""))


# ---------- CLI ----------

COLUMNAS = ["tipo", "codigoValidacion", "procedimiento", "fchPublicacion", "deudorNombre",
            "entePublicador", "fecha_remate", "tipo_procedimiento", "rol_causa", "tribunal",
            "deudor_rut", "liquidador", "region", "comuna", "direccion", "tipo_bienes",
            "valor_minimo", "comision", "uf_en_detalle", "suspendido", "aviso", "detalle", "pdf"]


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--tipo", choices=["muebles", "inmuebles", "ambos"], default="ambos")
    ap.add_argument("--desde", help="fecha de publicación mínima YYYY-MM-DD (default: hoy)")
    ap.add_argument("--max", type=int, help="máximo de publicaciones por tipo")
    ap.add_argument("--out", default=str(Path(__file__).parent / "datos"))
    ap.add_argument("--pausa", type=float, default=0.5, help="segundos entre requests")
    ap.add_argument("--solo-listar", action="store_true", help="no descargar PDFs")
    a = ap.parse_args()

    desde = a.desde or (None if a.max else date.today().isoformat())
    out = Path(a.out)
    (out / "pdf").mkdir(parents=True, exist_ok=True)
    b = Boletin(pausa=a.pausa)
    tipos = ["muebles", "inmuebles"] if a.tipo == "ambos" else [a.tipo]

    registros = []
    for t in tipos:
        for f in b.listar(t, desde=desde, maximo=a.max):
            reg = {k: f.get(k) for k in ("tipo", "codigoValidacion", "procedimiento",
                                         "fchPublicacion", "deudorNombre", "entePublicador")}
            if not a.solo_listar and f.get("codigoValidacion"):
                try:
                    pdf = b.descargar(f["codigoValidacion"], out / "pdf" / f"{f['codigoValidacion']}.pdf")
                    reg["pdf"] = str(pdf.relative_to(out))
                    reg.update(parsear(pdf_a_texto(pdf)))
                except Exception as e:  # un PDF malo no corta el barrido
                    reg["error"] = str(e)
                    print(f"  ! {f['codigoValidacion']}: {e}", file=sys.stderr)
            registros.append(reg)
            print(f"{t:9} {reg['fchPublicacion']} {reg['deudorNombre'][:40]:40} "
                  f"{reg.get('comuna') or '':15} {reg.get('valor_minimo', '')}", file=sys.stderr)

    (out / "remates.json").write_text(json.dumps(registros, ensure_ascii=False, indent=1))
    with open(out / "remates.csv", "w", newline="", encoding="utf-8") as fh:
        w = csv.DictWriter(fh, fieldnames=COLUMNAS, extrasaction="ignore")
        w.writeheader()
        for r in registros:
            w.writerow({**r, "uf_en_detalle": "|".join(r.get("uf_en_detalle") or [])})
    print(f"\n{len(registros)} publicaciones -> {out}/remates.json y remates.csv", file=sys.stderr)


if __name__ == "__main__":
    main()
