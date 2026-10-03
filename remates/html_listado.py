#!/usr/bin/env python3
"""Genera un HTML autocontenido con el listado de remates (salida de filtrar_region.py --out).

Uso: python3 html_listado.py filtrados.json listado.html [--titulo "..."]
"""
import argparse
import json
from datetime import date

PLANTILLA = r"""<!doctype html>
<html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>__TITULO__</title>
<style>
:root{--bg:#f6f5f2;--card:#fff;--tx:#1d1d1b;--mu:#6b6a66;--li:#e4e2dc;--ac:#1f5f8b;--rios:#2f7d5b;--lagos:#1f5f8b;--warn:#b3412e;--chip:#efede8}
@media (prefers-color-scheme:dark){:root:not([data-theme=light]){--bg:#161615;--card:#1f1f1d;--tx:#ecebe7;--mu:#a09e98;--li:#33322f;--ac:#7fb3d9;--rios:#6cc39b;--lagos:#7fb3d9;--warn:#e58a78;--chip:#2a2927}}
:root[data-theme=dark]{--bg:#161615;--card:#1f1f1d;--tx:#ecebe7;--mu:#a09e98;--li:#33322f;--ac:#7fb3d9;--rios:#6cc39b;--lagos:#7fb3d9;--warn:#e58a78;--chip:#2a2927}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--tx);font:15px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif}
.wrap{max-width:980px;margin:0 auto;padding:24px 16px 60px}
h1{font-size:1.5rem;margin:0 0 4px}
.sub{color:var(--mu);margin:0 0 18px;font-size:.9rem}
.stats{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:16px}
.stat{background:var(--card);border:1px solid var(--li);border-radius:10px;padding:10px 14px;min-width:120px}
.stat b{display:block;font-size:1.35rem;font-variant-numeric:tabular-nums}
.stat span{color:var(--mu);font-size:.8rem}
.bar{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:16px;position:sticky;top:0;background:var(--bg);padding:8px 0;z-index:2}
.bar button,.bar select,.bar input{font:inherit;border:1px solid var(--li);background:var(--card);color:var(--tx);border-radius:8px;padding:6px 10px}
.bar button[aria-pressed=true]{background:var(--tx);color:var(--bg);border-color:var(--tx)}
.bar input[type=search]{flex:1;min-width:160px}
.bar label{display:flex;gap:6px;align-items:center;color:var(--mu);font-size:.9rem}
.card{background:var(--card);border:1px solid var(--li);border-left:4px solid var(--lagos);border-radius:10px;padding:14px 16px;margin-bottom:10px}
.card.rios{border-left-color:var(--rios)}
.card.susp{opacity:.6}
.top{display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap}
.lugar{font-weight:650;font-size:1.05rem}
.lugar small{font-weight:400;color:var(--mu)}
.precio{text-align:right;font-variant-numeric:tabular-nums}
.precio b{font-size:1.1rem}
.precio div{color:var(--mu);font-size:.85rem}
.meta{display:flex;gap:6px;flex-wrap:wrap;margin:8px 0}
.chip{background:var(--chip);border-radius:20px;padding:2px 9px;font-size:.8rem;color:var(--mu)}
.chip.fecha{color:var(--tx);font-weight:600}
.chip.warn{background:var(--warn);color:#fff}
.det{margin:6px 0 0;font-size:.9rem}
details summary{cursor:pointer;color:var(--ac);font-size:.85rem;margin-top:6px}
.legal{color:var(--mu);font-size:.8rem;margin-top:8px}
.legal code{user-select:all}
.vacio{color:var(--mu);text-align:center;padding:40px}
.pasado .chip.fecha{color:var(--mu);font-weight:400}
</style></head><body><div class="wrap">
<h1>__TITULO__</h1>
<p class="sub">Inmuebles en remate según el Boletín Concursal · generado __HOY__ · ubicación deducida del detalle de cada publicación</p>
<div class="stats" id="stats"></div>
<div class="bar">
 <button data-r="" aria-pressed="true">Todas</button>
 <button data-r="Los Ríos" aria-pressed="false">Los Ríos</button>
 <button data-r="Los Lagos" aria-pressed="false">Los Lagos</button>
 <select id="orden"><option value="fecha">Por fecha de remate</option><option value="precio">Menor mínimo</option><option value="precio-d">Mayor mínimo</option></select>
 <label><input type="checkbox" id="pasados"> incluir ya realizados</label>
 <label><input type="checkbox" id="susp"> incluir suspendidos</label>
 <input type="search" id="q" placeholder="Buscar comuna, deudor, rol, texto…">
</div>
<div id="lista"></div>
</div>
<script>
const DATOS = __DATOS__;
const HOY = "__HOY__";
const $ = s => document.querySelector(s);
const clp = n => n ? "$" + n.toLocaleString("es-CL") : "sin mínimo";
const esc = s => (s||"").replace(/[&<>"]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
const fmtF = f => { if(!f) return "s/f"; const [d,h]=f.split(" "); const [a,m,dd]=d.split("-"); return `${dd}/${m}/${a}${h?" "+h:""}`; };
let region = "";
document.querySelectorAll(".bar button").forEach(b => b.onclick = () => {
  region = b.dataset.r;
  document.querySelectorAll(".bar button").forEach(x => x.setAttribute("aria-pressed", x === b));
  pintar();
});
["orden","pasados","susp","q"].forEach(id => $("#"+id).addEventListener("input", pintar));

function pintar(){
  const q = $("#q").value.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g,"");
  let xs = DATOS.filter(r =>
    (!region || r.region_inmueble === region) &&
    ($("#pasados").checked || (r.fecha_remate||"9") >= HOY) &&
    ($("#susp").checked || !r.suspendido) &&
    (!q || JSON.stringify(r).toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g,"").includes(q)));
  const o = $("#orden").value;
  xs.sort((a,b) => o==="fecha" ? (a.fecha_remate||"").localeCompare(b.fecha_remate||"")
                 : o==="precio" ? (a.valor_minimo||0)-(b.valor_minimo||0) : (b.valor_minimo||0)-(a.valor_minimo||0));
  const total = xs.reduce((s,r)=>s+(r.valor_minimo||0),0);
  $("#stats").innerHTML = [
    [xs.length, "remates"],
    [xs.filter(r=>r.region_inmueble==="Los Ríos").length, "Los Ríos"],
    [xs.filter(r=>r.region_inmueble==="Los Lagos").length, "Los Lagos"],
    [xs.length ? clp(Math.round(total/xs.length)) : "–", "mínimo promedio"],
  ].map(([v,l]) => `<div class="stat"><b>${v}</b><span>${l}</span></div>`).join("");
  $("#lista").innerHTML = xs.length ? xs.map(card).join("") : `<div class="vacio">Sin resultados con estos filtros.</div>`;
}

function card(r){
  const uf = (r.uf_en_detalle||[]).map(u => "UF " + u).join(" · ");
  const pasado = (r.fecha_remate||"") < HOY;
  const det = r.detalle || "";
  const corto = det.length > 320 ? det.slice(0, 320) + "…" : det;
  return `<article class="card ${r.region_inmueble==="Los Ríos"?"rios":""} ${r.suspendido?"susp":""} ${pasado?"pasado":""}">
   <div class="top">
     <div class="lugar">${esc(r.comuna_inmueble || r.comuna || "¿?")} <small>· ${esc(r.region_inmueble)}</small></div>
     <div class="precio"><b>${clp(r.valor_minimo)}</b>${uf?`<div>${esc(uf)}</div>`:""}</div>
   </div>
   <div class="meta">
     ${r.suspendido?'<span class="chip warn">SUSPENDIDO</span>':""}
     <span class="chip fecha">Remate ${fmtF(r.fecha_remate)}${pasado?" (realizado)":""}</span>
     <span class="chip">${esc(r.tipo_procedimiento)}</span>
     <span class="chip">Comisión ${r.comision ?? "–"}%</span>
     <span class="chip">Se remata en: ${esc(r.direccion || r.comuna)}</span>
   </div>
   <p class="det">${esc(corto)}</p>
   ${det.length > 320 ? `<details><summary>Ver detalle completo</summary><p class="det">${esc(det)}</p></details>` : ""}
   <div class="legal">Deudor: ${esc(r.deudor)} · Rol ${esc(r.rol_causa)} · ${esc(r.tribunal)} · Liquidador: ${esc(r.liquidador)} · Martillero: ${esc(r.entePublicador)} · Publicado ${fmtF(r.fecha_publicacion||r.fchPublicacion)} · Código <code>${esc(r.codigoValidacion)}</code> (<a href="https://www.boletinconcursal.cl/boletin/verificacion" target="_blank" rel="noopener">verificar</a>)</div>
  </article>`;
}
pintar();
</script></body></html>"""


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("json")
    ap.add_argument("html")
    ap.add_argument("--titulo", default="Remates de inmuebles · Los Ríos y Los Lagos")
    a = ap.parse_args()
    datos = json.load(open(a.json))
    claves = ["region_inmueble", "comuna_inmueble", "comuna", "direccion", "fecha_remate", "suspendido",
              "valor_minimo", "uf_en_detalle", "comision", "tipo_procedimiento", "detalle", "deudor",
              "rol_causa", "tribunal", "liquidador", "entePublicador", "fecha_publicacion",
              "fchPublicacion", "codigoValidacion"]
    datos = [{k: r.get(k) for k in claves} for r in datos]
    html = (PLANTILLA.replace("__TITULO__", a.titulo)
            .replace("__HOY__", date.today().isoformat())
            .replace("__DATOS__", json.dumps(datos, ensure_ascii=False).replace("</", "<\\/")))
    open(a.html, "w", encoding="utf-8").write(html)
    print(f"{len(datos)} remates -> {a.html}")


if __name__ == "__main__":
    main()
