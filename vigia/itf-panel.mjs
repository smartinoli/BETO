#!/usr/bin/env node
/* ============================================================
   ITF-PANEL — genera vigia/itf-panel.html: el mapa del circuito
   en una página, desde los datos ya cosechados (sin red).

   Fuentes locales:
     itf-calendario.json            torneos con bolsa/superficie/fechas
     datos/itf/*.aceptacion.json    entry lists con rankings y retiros fechados
     datos/itf/*.json               cuadros de torneos terminados (cosecha)
     datos/itf/vivo/*.json          cuadros de torneos EN JUEGO (modo vivo)
     itf.json                       tablero de favoritos de vigía (cuotas)

   Uso: node vigia/itf-panel.mjs        → escribe vigia/itf-panel.html
        node vigia/itf-panel.mjs vivo   → antes intenta refrescar los cuadros
                                          de los torneos en juego (endpoints
                                          abiertos; corta si el WAF desafía)
   ============================================================ */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pareceElMismo } from './itf-cruce.mjs';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const DATOS = path.join(DIR, 'datos', 'itf');
const VIVO = path.join(DATOS, 'vivo');
const SALIDA = path.join(DIR, 'itf-panel.html');

const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const hoy = new Date().toISOString().slice(0, 10);

/* ---------- carga ---------- */
const cal = JSON.parse(fs.readFileSync(path.join(DIR, 'itf-calendario.json'), 'utf8'));
const torneos = cal.torneos;
const leer = f => { try { return JSON.parse(fs.readFileSync(path.join(DATOS, f), 'utf8')) } catch { return null; } };
const aceptacionDe = clave => leer(clave + '.aceptacion.json');
const cuadrosDe = clave => leer(clave + '.json');

const activos = torneos.filter(t => t.desde <= hoy && t.hasta >= hoy);
const porVenir = torneos.filter(t => t.desde > hoy).sort((a, b) => a.desde.localeCompare(b.desde));
const terminados = torneos.filter(t => t.hasta < hoy).sort((a, b) => b.hasta.localeCompare(a.hasta));

/* ---------- modo vivo: refrescar cuadros de los torneos en juego ---------- */
if (process.argv[2] === 'vivo') {
  const { eventos, cuadro } = await import('./itf.mjs');
  fs.mkdirSync(VIVO, { recursive: true });
  let wafSeguidos = 0;
  /* Los que no tienen cuadro van primero; los bajados hace <3 h se saltan
     para no gastar tolerancia del WAF en datos frescos. */
  const edad = t => { try { return Date.now() - new Date(JSON.parse(fs.readFileSync(path.join(VIVO, t.clave + '.json'), 'utf8')).bajado).getTime() } catch { return Infinity; } };
  const cola = [...activos].sort((a, b) => edad(b) - edad(a));
  for (const t of cola) {
    if (wafSeguidos >= 2) { console.log('  WAF en serie: sigo con lo que hay'); break; }
    if (edad(t) < 3 * 3600e3) { console.log(`  = vivo ${t.clave} fresco`); continue; }
    try {
      const ev = await eventos(t.clave);
      const cuadros = {};
      for (const c of ev.cuadros.filter(c => c.tipo === 'S')) {
        cuadros[c.evento] = await cuadro({ tournamentId: ev.tournamentId, tourType: ev.tourType, evento: c.evento, tipo: 'S' });
      }
      fs.writeFileSync(path.join(VIVO, t.clave + '.json'), JSON.stringify({ clave: t.clave, bajado: new Date().toISOString(), cuadros }));
      console.log(`  ✓ vivo ${t.clave}`);
      wafSeguidos = 0;
    } catch (e) { console.log(`  ✗ vivo ${t.clave}: ${e.message.split(':')[0]}`); if (e.waf) wafSeguidos++; }
  }
}
const vivoDe = clave => { try { return JSON.parse(fs.readFileSync(path.join(VIVO, clave + '.json'), 'utf8')) } catch { return null; } };
const tablero = (() => { try { return JSON.parse(fs.readFileSync(path.join(DIR, 'itf.json'), 'utf8')) } catch { return null; } })();

/* ---------- métricas de entry list ---------- */
const MES = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };
function fechaRetiro(info) {
  const m = /W\s+(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4})/.exec(info || '');
  return m ? new Date(+m[3], MES[m[2]] ?? 0, +m[1]) : null;
}
function metricasEntry(t) {
  const a = aceptacionDe(t.clave);
  if (!a) return null;
  const mda = a.secciones.MDA || [], w = a.secciones.W || [];
  const ranks = mda.map(e => e.atp).filter(Boolean);
  const inicio = new Date(t.desde + 'T00:00:00Z');
  const tardios = w.filter(e => { const f = fechaRetiro(e.info); return f && (inicio - f) / 864e5 <= 7; }).length;
  const cabezas = mda.filter(e => e.atp).sort((x, y) => x.atp - y.atp).slice(0, 5);
  return {
    corte: ranks.length ? Math.max(...ranks) : null,
    mejor: ranks.length ? Math.min(...ranks) : null,
    sinRank: mda.length - ranks.length,
    mda: mda.length, q: (a.secciones.Q || []).length, alt: (a.secciones.A || []).length,
    retiros: w.length, tardios, cabezas,
  };
}

/* ---------- comportamiento de los terminados ---------- */
const stats = { torneos: 0, r1: 0, r1Q: 0, qVs: 0, qGana: 0, seedVs: 0, seedGana: 0, partidosM: 0, retirosM: 0, llVs: 0, llGana: 0, campSeed: 0, campTotal: 0 };
const campeones = [];
for (const t of terminados) {
  const d = cuadrosDe(t.clave);
  if (!d?.cuadros?.M) continue;
  stats.torneos++;
  for (const r of d.cuadros.M.rondas) {
    for (const p of r.partidos) {
      if (p.estado !== 'jugado') continue;
      stats.partidosM++;
      if (/retired/i.test(p.nota || '')) stats.retirosM++;
      if (r.numero === 1) {
        stats.r1++;
        if (p.lados.some(l => l.entrada === 'Q')) stats.r1Q++;
        const q = p.lados.find(l => l.entrada === 'Q'), noQ = p.lados.find(l => l.entrada !== 'Q');
        if (q && noQ && noQ.entrada !== 'Q') { stats.qVs++; if (q.ganador) stats.qGana++; }
        const ll = p.lados.find(l => l.entrada === 'LL'), noLL = p.lados.find(l => l.entrada !== 'LL');
        if (ll && noLL && noLL.entrada !== 'LL') { stats.llVs++; if (ll.ganador) stats.llGana++; }
        const s = p.lados.find(l => l.seed), noS = p.lados.find(l => !l.seed);
        if (s && noS) { stats.seedVs++; if (s.ganador) stats.seedGana++; }
      }
    }
  }
  const fin = d.cuadros.M.rondas.find(r => /^final$/i.test(r.nombre));
  const g = fin?.partidos?.[0]?.lados?.find(l => l.ganador);
  if (g) {
    stats.campTotal++;
    if (g.seed) stats.campSeed++;
    campeones.push({ t, nombre: g.nombre, seed: g.seed, entrada: g.entrada });
  }
}
const pct = (a, b) => b ? Math.round(100 * a / b) + '%' : '—';

/* ---------- render ---------- */
const chipSup = s => {
  const c = /clay/i.test(s) ? 'arcilla' : /hard/i.test(s) ? 'dura' : /grass/i.test(s) ? 'pasto' : 'otra';
  const txt = /clay/i.test(s) ? 'Arcilla' : /hard/i.test(s) ? 'Dura' : /grass/i.test(s) ? 'Pasto' : esc(s || '?');
  return `<span class="chip sup-${c}">${txt}</span>`;
};
const chipCat = c => `<span class="chip cat">${esc(c || '?')}</span>`;
const num = v => v == null ? '—' : String(v);
const rango = t => `${t.desde.slice(5).replace('-', '/')}–${t.hasta.slice(5).replace('-', '/')}`;

function tarjetaActivo(t) {
  const m = metricasEntry(t);
  const cabezas = m?.cabezas?.length
    ? `<ol class="cabezas">${m.cabezas.map(e => `<li><span class="rk">${e.atp}</span> ${esc(e.nombre)} <span class="pais">${esc(e.pais || '')}</span></li>`).join('')}</ol>`
    : '<p class="nota">Sin entry list fotografiada.</p>';
  return `<article class="tarjeta">
    <header>
      <h3>${esc(t.nombre)}</h3>
      <div class="fila-chips">${chipCat(t.categoria)}${chipSup(t.superficie)}<span class="chip fechas">${rango(t)}</span></div>
      <p class="sub">${esc(t.pais)} · ${esc(t.bolsa || '?')}${t.promocional ? ' · ' + esc(t.promocional) : ''}</p>
    </header>
    ${m ? `<dl class="metricas">
      <div><dt>Corte ATP</dt><dd>${num(m.mejor)}–${num(m.corte)}</dd></div>
      <div><dt>Sin rank</dt><dd>${m.sinRank}/${m.mda}</dd></div>
      <div><dt>Retiros pre</dt><dd>${m.retiros}</dd></div>
      <div><dt>Última semana</dt><dd>${m.tardios}</dd></div>
    </dl>` : ''}
    ${cabezas}
    ${t.enlace ? `<a class="enlace" href="${esc(t.enlace)}draws-and-results/" target="_blank" rel="noopener">cuadro en itftennis.com ↗</a>` : ''}
  </article>`;
}

function filaVenir(t) {
  const m = metricasEntry(t);
  return `<tr>
    <td class="mono">${rango(t)}</td>
    <td>${chipCat(t.categoria)}</td>
    <td>${esc(t.nombre)}</td>
    <td>${esc(t.pais)}</td>
    <td>${chipSup(t.superficie)}</td>
    <td class="mono">${esc(t.bolsa || '?')}</td>
    <td class="mono">${m ? num(m.mejor) + '–' + num(m.corte) : '—'}</td>
    <td class="mono">${m ? m.retiros : '—'}</td>
    <td class="mono">${m ? m.alt : '—'}</td>
  </tr>`;
}

/* ---------- por jugarse: cuadros en vivo ---------- */
const RONDA_CORTA = { 1: 'R1', 2: 'R2', 3: 'QF', 4: 'SF', 5: 'F' };

/* Marca compacta de un lado: seed y/o entrada distinta de DA. */
const marcaDe = l => [l?.seed ? `[${l.seed}]` : null, l?.entrada && l.entrada !== 'DA' ? l.entrada : null].filter(Boolean).join('');

function trayectoriaHtml(nombre, cuadros) {
  const pasos = [];
  const orden = Object.entries(cuadros).sort(([a], [b]) => (a === 'Q' ? 0 : 1) - (b === 'Q' ? 0 : 1));
  for (const [evento, c] of orden) {
    for (const r of c.rondas) {
      for (const p of r.partidos) {
        if (p.estado !== 'jugado') continue;
        const idx = p.lados.findIndex(l => pareceElMismo(nombre, l));
        if (idx < 0) continue;
        const yo = p.lados[idx], rival = p.lados[1 - idx];
        const ronda = evento === 'Q' ? 'Q' + r.numero : (RONDA_CORTA[r.numero] || 'R' + r.numero);
        const pares = yo.sets.map((s, i) => s + '-' + (rival.sets[i] ?? '?')).join(' ');
        /* Contra quién: la marca del rival (seed/Q/WC/LL/JE…) le da peso al resultado. */
        const vs = marcaDe(rival);
        pasos.push(`<span class="${yo.ganador ? 'paso-g' : 'paso-p'}">${ronda}${yo.ganador ? '✓' : '✗'} ${esc(pares)}</span>`
          + (vs ? ` <span class="paso-vs">v${esc(vs)}</span>` : '')
          + (/retired/i.test(p.nota || '') && !yo.ganador ? ' <span class="paso-ret">RET</span>' : ''));
      }
    }
  }
  return pasos.join(' · ');
}

/* Cuotas del tablero de vigía (itf.json) para un partido pendiente:
   empareja por nombres en ambos órdenes y devuelve por lado la cuota de
   Betano (favorito o no) y la de bet365 (solo la del favorito viene en el
   feed). null = OddsPapi no trajo nombres para ese partido todavía. */
const cuotasIndice = tablero?.partidos ? Object.values(tablero.partidos).filter(e => e.p1 && e.p2) : [];
function cuotasDe(lados) {
  for (const e of cuotasIndice) {
    let mapa = null;
    if (pareceElMismo(e.p1, lados[0]) && pareceElMismo(e.p2, lados[1])) mapa = [1, 2];
    else if (pareceElMismo(e.p1, lados[1]) && pareceElMismo(e.p2, lados[0])) mapa = [2, 1];
    if (!mapa) continue;
    return {
      bFix: e.bFix || null,
      porLado: lados.map((l, i) => {
        const esFav = e.fav === mapa[i];
        return { betano: esFav ? e.cB : e.dB, b365: esFav ? e.cJ : null, esFav };
      }),
    };
  }
  return null;
}

const cuotaTxt = c => {
  if (!c || (c.betano == null && c.b365 == null)) return '<span class="jug-c mono sin">—</span>';
  const b = c.betano != null ? (+c.betano).toFixed(2) : '—';
  const j = c.b365 != null ? (+c.b365).toFixed(2) : '—';
  return `<span class="jug-c mono${c.esFav ? ' fav' : ''}">B ${b} · 365 ${j}</span>`;
};

function jugadorHtml(l, cuadros, listado, cuota) {
  const e = listado.find(x => pareceElMismo(l.nombre, { nombre: x.nombre }));
  const rank = e?.atp ? `ATP ${e.atp}` : (e?.wtn ? `WTN ${e.wtn}` : 'sin rank');
  const marcas = marcaDe(l);
  const tray = trayectoriaHtml(l.nombre, cuadros);
  return `<div class="jug"><span class="jug-n">${esc(l.nombre)}${marcas ? ' <b>' + esc(marcas) + '</b>' : ''}</span>
    <span class="jug-r mono">${rank}</span>
    ${cuotaTxt(cuota)}
    <span class="jug-t">${tray || 'debuta'}</span></div>`;
}

function seccionPorJugarse() {
  const bloques = [];
  for (const t of activos) {
    const v = vivoDe(t.clave);
    if (!v) continue;
    const a = aceptacionDe(t.clave);
    const listado = a ? Object.values(a.secciones).flat() : [];
    const filas = [];
    for (const [evento, c] of Object.entries(v.cuadros)) {
      for (const r of c.rondas) {
        for (const p of r.partidos) {
          if (p.estado !== 'pendiente' || !p.lados.every(l => l.nombre)) continue;
          const ronda = evento === 'Q' ? 'Q·R' + r.numero : (RONDA_CORTA[r.numero] || 'R' + r.numero);
          const cuotas = cuotasDe(p.lados);
          const abrir = cuotas?.bFix
            ? `<a class="enlace-bet" href="https://lat.betano.com/cuotas-de-partido/e-e/${esc(cuotas.bFix)}/" target="_blank" rel="noopener">Betano ↗</a>`
            : '';
          filas.push(`<tr><td class="mono">${ronda}${abrir ? '<br>' + abrir : ''}</td>
            <td class="celda-partido">${p.lados.map((l, i) => jugadorHtml(l, v.cuadros, listado, cuotas?.porLado?.[i])).join('')}</td></tr>`);
        }
      }
    }
    if (!filas.length) continue;
    bloques.push(`<h3 class="sub-torneo">${esc(t.nombre)} <span class="mono sub-fecha">cuadro al ${esc((v.bajado || '').slice(0, 16).replace('T', ' '))}</span></h3>
      <div class="tabla-envoltura"><table class="tabla-partidos">
      <thead><tr><th>Ronda</th><th>Partido — seed/entrada · ranking · cuotas (Betano · bet365) · cómo llega, con la marca del rival de cada resultado</th></tr></thead>
      <tbody>${filas.join('\n')}</tbody></table></div>`);
  }
  if (!bloques.length) return `<p class="nota">Sin cuadros en vivo aún: correr <span class="mono">node vigia/itf-panel.mjs vivo</span> (o esperar a que el WAF se enfríe).</p>`;
  return bloques.join('\n');
}

/* ---------- tablero de cuotas (vigía · itf.json) ---------- */
function seccionCuotas() {
  if (!tablero?.partidos) return '';
  const entradas = Object.values(tablero.partidos);
  const conNombre = entradas.filter(e => e.p1);
  const filas = conNombre
    .sort((a, b) => (a.estado === 'pendiente' ? 0 : 1) - (b.estado === 'pendiente' ? 0 : 1) || (a.t || '').localeCompare(b.t || ''))
    .map(e => {
      const fav = e.fav === 1 ? e.p1 : e.p2;
      const est = e.estado === 'F' ? '<span class="chip est-f">favorito ganó</span>'
        : e.estado === 'D' ? '<span class="chip est-d">favorito cayó</span>'
        : '<span class="chip">pendiente</span>';
      const ctx = [e.ronda, e.entFav && e.entFav !== 'DA' ? 'fav ' + e.entFav : null, e.entRival && e.entRival !== 'DA' ? 'vs ' + e.entRival : null].filter(Boolean).join(' · ');
      return `<tr>
        <td>${esc(e.torneo || '?')}</td>
        <td>${esc(e.p1)} vs ${esc(e.p2)}${e.bFix ? ` <a class="enlace-bet" href="https://lat.betano.com/cuotas-de-partido/e-e/${esc(e.bFix)}/" target="_blank" rel="noopener">↗</a>` : ''}</td>
        <td>${esc(fav || '?')}</td>
        <td class="mono">${e.cB?.toFixed?.(2) ?? e.cB}</td>
        <td class="mono">${e.cJ?.toFixed?.(2) ?? e.cJ}</td>
        <td>${est}${e.marcador ? ' <span class="mono">' + esc(e.marcador) + '</span>' : ''}</td>
        <td class="mono">${esc(ctx || '—')}</td>
      </tr>`;
    });
  const sinNombre = entradas.length - conNombre.length;
  return `<section>
    <p class="eyebrow">Cuotas en seguimiento — tablero de favoritos de vigía (/itf)</p>
    ${filas.length ? `<div class="tabla-envoltura"><table>
      <thead><tr><th>Torneo</th><th>Partido</th><th>Favorito</th><th>Betano</th><th>bet365</th><th>Resultado</th><th>Contexto cuadro</th></tr></thead>
      <tbody>${filas.join('\n')}</tbody></table></div>` : '<p class="nota">Aún sin partidos con nombres en el tablero.</p>'}
    <p class="nota" style="margin-top:8px">${entradas.length} partidos seguidos; ${sinNombre} llegaron sin nombres desde OddsPapi (sin nombre no hay cruce con el cuadro). El contexto lo anota itf-cruce al liquidar.</p>
  </section>`;
}

function filaCampeon(c) {
  return `<tr>
    <td class="mono">${rango(c.t)}</td>
    <td>${chipCat(c.t.categoria)}</td>
    <td>${esc(c.t.nombre)}</td>
    <td>${esc(c.nombre)}</td>
    <td class="mono">${c.seed ? '[' + c.seed + ']' : '—'}</td>
    <td>${c.entrada === 'DA' ? 'directa' : esc(c.entrada || '—')}</td>
  </tr>`;
}

const html = `<title>Vigía ITF</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@500;600;700&family=IBM+Plex+Sans:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500&display=swap">
<style>
:root{
  --papel:#F3F5F7; --carta:#FFFFFF; --tinta:#1A2732; --tinta2:#5A6B7A;
  --linea:#D9E0E6; --acento:#0F6B5C; --acento-suave:#E3EFEB;
  --arcilla-bg:#F4E3DD; --arcilla-tx:#8C3A25; --dura-bg:#E0EAF5; --dura-tx:#24568C;
  --pasto-bg:#E2EEDF; --pasto-tx:#33632F; --alerta:#A33B2A;
}
@media (prefers-color-scheme: dark){ :root:not([data-theme="light"]){
  --papel:#0F151B; --carta:#161F28; --tinta:#DAE4EC; --tinta2:#8FA1B0;
  --linea:#26313C; --acento:#3FB79E; --acento-suave:#15302B;
  --arcilla-bg:#3A241D; --arcilla-tx:#E5A18F; --dura-bg:#1C2C40; --dura-tx:#9FC0E8;
  --pasto-bg:#20301D; --pasto-tx:#A6CC9F; --alerta:#E08A79;
}}
:root[data-theme="dark"]{
  --papel:#0F151B; --carta:#161F28; --tinta:#DAE4EC; --tinta2:#8FA1B0;
  --linea:#26313C; --acento:#3FB79E; --acento-suave:#15302B;
  --arcilla-bg:#3A241D; --arcilla-tx:#E5A18F; --dura-bg:#1C2C40; --dura-tx:#9FC0E8;
  --pasto-bg:#20301D; --pasto-tx:#A6CC9F; --alerta:#E08A79;
}
*{box-sizing:border-box}
body{margin:0;background:var(--papel);color:var(--tinta);
  font:15px/1.55 "IBM Plex Sans",system-ui,sans-serif;}
.envoltura{max-width:1160px;margin:0 auto;padding:32px 20px 64px;display:flex;flex-direction:column;gap:40px}
header.cabecera h1{font-family:"Barlow Condensed",sans-serif;font-weight:700;font-size:44px;
  line-height:1.05;margin:0;letter-spacing:.5px;text-wrap:balance}
header.cabecera .bajo{color:var(--tinta2);margin:6px 0 0;font-size:14px}
.eyebrow{font-family:"Barlow Condensed",sans-serif;font-weight:600;font-size:15px;
  letter-spacing:2.5px;text-transform:uppercase;color:var(--acento);margin:0 0 12px}
section h2{margin:0}
/* stats del pasado */
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px}
.tile{background:var(--carta);border:1px solid var(--linea);border-radius:6px;padding:14px 16px}
.tile .v{font-family:"Barlow Condensed",sans-serif;font-weight:700;font-size:34px;line-height:1;
  font-variant-numeric:tabular-nums}
.tile .k{color:var(--tinta2);font-size:12.5px;margin-top:5px;line-height:1.35}
/* tarjetas en juego */
.malla{display:grid;grid-template-columns:repeat(auto-fill,minmax(330px,1fr));gap:14px}
.tarjeta{background:var(--carta);border:1px solid var(--linea);border-radius:6px;padding:16px 18px;
  display:flex;flex-direction:column;gap:10px}
.tarjeta h3{font-family:"Barlow Condensed",sans-serif;font-weight:600;font-size:23px;margin:0;line-height:1.1}
.tarjeta .sub{color:var(--tinta2);font-size:13px;margin:4px 0 0}
.fila-chips{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}
.chip{font-family:"IBM Plex Mono",monospace;font-size:11.5px;padding:2px 8px;border-radius:99px;
  border:1px solid var(--linea);color:var(--tinta2);white-space:nowrap}
.chip.cat{background:var(--acento-suave);color:var(--acento);border-color:transparent;font-weight:500}
.chip.sup-arcilla{background:var(--arcilla-bg);color:var(--arcilla-tx);border-color:transparent}
.chip.sup-dura{background:var(--dura-bg);color:var(--dura-tx);border-color:transparent}
.chip.sup-pasto{background:var(--pasto-bg);color:var(--pasto-tx);border-color:transparent}
.metricas{display:grid;grid-template-columns:repeat(4,auto);gap:4px 18px;margin:0;padding:10px 0;
  border-top:1px solid var(--linea);border-bottom:1px solid var(--linea)}
.metricas dt{font-size:11px;color:var(--tinta2);text-transform:uppercase;letter-spacing:.8px}
.metricas dd{margin:0;font-family:"IBM Plex Mono",monospace;font-size:14px;font-weight:500;
  font-variant-numeric:tabular-nums;white-space:nowrap}
.metricas dd.alerta{color:var(--alerta)}
.cabezas{margin:0;padding:0 0 0 2px;list-style:none;display:flex;flex-direction:column;gap:3px;font-size:13.5px}
.cabezas .rk{font-family:"IBM Plex Mono",monospace;color:var(--tinta2);display:inline-block;
  min-width:42px;font-variant-numeric:tabular-nums}
.cabezas .pais{color:var(--tinta2);font-size:12px}
.nota{color:var(--tinta2);font-size:13px;margin:0}
.enlace{color:var(--acento);font-size:13px;text-decoration:none;margin-top:auto}
.enlace:hover,.enlace:focus-visible{text-decoration:underline}
a:focus-visible{outline:2px solid var(--acento);outline-offset:2px}
/* tablas */
.tabla-envoltura{overflow-x:auto;background:var(--carta);border:1px solid var(--linea);border-radius:6px}
table{border-collapse:collapse;width:100%;font-size:13.5px;min-width:720px}
th{font-family:"Barlow Condensed",sans-serif;font-weight:600;font-size:14px;letter-spacing:1px;
  text-transform:uppercase;color:var(--tinta2);text-align:left;padding:10px 14px;
  border-bottom:1px solid var(--linea);white-space:nowrap}
td{padding:8px 14px;border-bottom:1px solid var(--linea);vertical-align:middle}
tr:last-child td{border-bottom:0}
.mono{font-family:"IBM Plex Mono",monospace;font-size:12.5px;font-variant-numeric:tabular-nums;white-space:nowrap}
footer{color:var(--tinta2);font-size:12.5px;border-top:1px solid var(--linea);padding-top:14px}
/* por jugarse */
.sub-torneo{font-family:"Barlow Condensed",sans-serif;font-weight:600;font-size:20px;margin:18px 0 8px}
.sub-fecha{font-size:11.5px;color:var(--tinta2);font-weight:400;margin-left:8px}
.tabla-partidos{min-width:560px}
.celda-partido{display:flex;flex-direction:column;gap:6px;padding:10px 14px}
.jug{display:grid;grid-template-columns:minmax(180px,240px) 84px 128px 1fr;gap:12px;align-items:baseline}
.jug-n b{color:var(--acento);font-weight:600}
.jug-r{color:var(--tinta2)}
.jug-c{font-size:12px;color:var(--tinta2);white-space:nowrap}
.jug-c.fav{color:var(--tinta);font-weight:500}
.jug-c.sin{opacity:.45}
.jug-t{font-family:"IBM Plex Mono",monospace;font-size:12px;color:var(--tinta2)}
.enlace-bet{color:var(--acento);font-size:11.5px;text-decoration:none;white-space:nowrap}
.enlace-bet:hover,.enlace-bet:focus-visible{text-decoration:underline}
.paso-g{color:var(--acento)}
.paso-vs{color:var(--tinta);font-weight:500}
.paso-p,.paso-ret{color:var(--alerta)}
.chip.est-f{background:var(--acento-suave);color:var(--acento);border-color:transparent}
.chip.est-d{background:var(--arcilla-bg);color:var(--alerta);border-color:transparent}
@media (max-width:640px){ .jug{grid-template-columns:1fr;gap:2px} }
</style>
<div class="envoltura">
<header class="cabecera">
  <h1>Vigía ITF</h1>
  <p class="bajo">World Tennis Tour masculino · generado ${hoy} · calendario al ${esc((cal.actualizado || '').slice(0, 10))}</p>
</header>

<section>
  <p class="eyebrow">El pasado, medido — ${stats.torneos} torneos terminados, ${stats.partidosM} partidos de main draw</p>
  <div class="tiles">
    <div class="tile"><div class="v">${pct(stats.r1Q, stats.r1)}</div><div class="k">partidos de R1 con un qualifier</div></div>
    <div class="tile"><div class="v">${pct(stats.qGana, stats.qVs)}</div><div class="k">gana el qualifier vs entrada directa (n${stats.qVs})</div></div>
    <div class="tile"><div class="v">${stats.llGana}/${stats.llVs}</div><div class="k">record de lucky losers en R1</div></div>
    <div class="tile"><div class="v">${pct(stats.seedGana, stats.seedVs)}</div><div class="k">gana el seed vs no-seed en R1 (n${stats.seedVs})</div></div>
    <div class="tile"><div class="v">${pct(stats.retirosM, stats.partidosM)}</div><div class="k">partidos de main que terminan en retiro</div></div>
    <div class="tile"><div class="v">${stats.campSeed}/${stats.campTotal}</div><div class="k">campeones con seed</div></div>
  </div>
</section>

<section>
  <p class="eyebrow">En juego esta semana — ${activos.length} torneos</p>
  <div class="malla">
    ${activos.map(tarjetaActivo).join('\n')}
  </div>
</section>

<section>
  <p class="eyebrow">Por jugarse — cuadros en vivo de los torneos en juego</p>
  ${seccionPorJugarse()}
</section>

${seccionCuotas()}

<section>
  <p class="eyebrow">Por venir — ${porVenir.length} torneos</p>
  <div class="tabla-envoltura"><table>
    <thead><tr><th>Fechas</th><th>Cat.</th><th>Torneo</th><th>País</th><th>Sup.</th><th>Bolsa</th><th>Corte ATP</th><th>Retiros pre</th><th>Alternates</th></tr></thead>
    <tbody>${porVenir.map(filaVenir).join('\n')}</tbody>
  </table></div>
  <p class="nota" style="margin-top:8px">Corte ATP = mejor y peor ranking de los aceptados directos al momento de la foto de la entry list. Los retiros pre-torneo vienen fechados en los datos.</p>
</section>

${campeones.length ? `<section>
  <p class="eyebrow">Terminados cosechados — campeones</p>
  <div class="tabla-envoltura"><table>
    <thead><tr><th>Fechas</th><th>Cat.</th><th>Torneo</th><th>Campeón</th><th>Seed</th><th>Entrada</th></tr></thead>
    <tbody>${campeones.map(filaCampeon).join('\n')}</tbody>
  </table></div>
</section>` : ''}

<footer>
  Datos: itftennis.com (endpoints abiertos + fotos de entry list vía navegador) · cuotas y justo viven en vigía (/itf).
  Regenerar: <span class="mono">node vigia/itf-panel.mjs</span> · refrescar datos: <span class="mono">itf-navegador.mjs cosecha</span> + <span class="mono">itf-cosecha.mjs cosechar</span>.
</footer>
</div>`;

fs.writeFileSync(SALIDA, html);
console.log(`✓ ${SALIDA} (${(html.length / 1024).toFixed(0)} KB) · ${activos.length} en juego · ${porVenir.length} por venir · ${stats.torneos} terminados con cuadro`);
