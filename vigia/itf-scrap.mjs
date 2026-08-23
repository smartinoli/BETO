#!/usr/bin/env node
/* ============================================================
   ITF-SCRAP — el orquestador: baja SOLO lo que falta.

   Lee el mapa maestro (itf-mapa.mjs), calcula el diff entre lo que hay
   en disco y lo que el estado de cada torneo exige, y ejecuta esa cola
   con el navegador. Nada de "recorrer todo y rezar": cada request tiene
   una razón que el panel puede mostrar.

   Qué exige cada estado (hombres singles, M15/M25):
     PROXIMO    acceptance list (ITF la borra al terminar: es lo urgente)
     QUALI      acceptance fresca + order of play + cuadro Q
     MAIN       order of play del día + cuadros M/Q  (aquí vive la mesa)
     TERMINADO  si quedan filas del registro sin cerrar → una última
                pasada de cuadros; si no queda nada → ARCHIVADO
     ARCHIVADO  nada, nunca más.

   WAF: dos fases con contextos separados, porque mezclar rompe (medido):
     fase A (contexto virgen, goto directo a cada torneo): oop + cuadros
     fase B (contexto calentado en la página del calendario): calendario
            + acceptance lists
   Dentro de cada fase, lo que falla por WAF va al FINAL de la cola y se
   reintenta hasta 3 vueltas. "Sin días de order of play" NO es error del
   WAF: es que ITF aún no publica — se anota y no se insiste.

   Frescura para no repetir: oop de hoy < 30 min → no se toca;
   acceptance < 4 días (PROXIMO/QUALI) → no se toca.

   Uso:  node vigia/itf-scrap.mjs            corrida completa
         node vigia/itf-scrap.mjs --plan     solo muestra la cola, no baja
   ============================================================ */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { abrirNavegador, calentar, cosecharTorneo, bajarCalendario, bajarAceptacion, pausaHumana, DATOS, CACHE_CALENDARIO } from './itf-navegador.mjs';
import { refrescarMapa, torneosDelMapa, guardarMapa, cargarMapa } from './itf-mapa.mjs';

const MIN_OOP = 30 * 60e3;          /* oop más fresco que esto no se re-baja */
const DIAS_ACC = 4 * 864e5;         /* acceptance más fresca que esto tampoco */
const leer = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')) } catch { return null } };
const edad = iso => iso ? Date.now() - new Date(iso).getTime() : Infinity;

/* ---------- armar la cola ---------- */
export function planificar(hoy = new Date().toISOString().slice(0, 10)) {
  const m = refrescarMapa();
  const filas = torneosDelMapa(m, hoy);
  const cal = leer(CACHE_CALENDARIO);
  const colaA = [], colaB = [], archivar = [], notas = [];
  if (edad(cal?.actualizado) > 3 * 864e5) colaB.push({ tipo: 'calendario', razon: 'caché con más de 3 días' });
  for (const { clave, t, estado } of filas) {
    if (/CANCELLED/i.test(t.nombre)) continue;
    if (estado === 'ARCHIVADO') continue;
    const fr = t.frescura;
    if (estado === 'TERMINADO') {
      if (t.pendientesDeCierre > 0 && edad(fr.cuadroM === 'historico' ? null : fr.cuadroM) > 2 * 3600e3)
        colaA.push({ tipo: 'cosecha', clave, t, razon: `${t.pendientesDeCierre} filas del registro sin cerrar` });
      else if (t.pendientesDeCierre === 0) archivar.push(clave);
      continue;
    }
    /* acceptance: urgente en PROXIMO (se borra), refrescable en QUALI */
    if ((estado === 'PROXIMO' || estado === 'QUALI') && (!fr.aceptacion || edad(fr.aceptacion) > DIAS_ACC))
      colaB.push({ tipo: 'aceptacion', clave, t, razon: fr.aceptacion ? 'snapshot con más de 4 días' : 'sin snapshot y ITF la borra al final' });
    /* order of play + cuadros: solo con el torneo en cancha */
    if (estado === 'QUALI' || estado === 'MAIN') {
      const oopHoy = fr.oop[hoy];
      if (!oopHoy || edad(oopHoy) > MIN_OOP)
        colaA.push({ tipo: 'cosecha', clave, t, razon: oopHoy ? `oop de hoy de las ${oopHoy.slice(11, 16)}` : (estado === 'QUALI' ? 'quali: aún sin oop' : 'sin oop de hoy') });
    }
  }
  return { mapa: m, colaA, colaB, archivar };
}

/* cola con reintentos: lo que falla por WAF va al final, hasta 3 vueltas */
async function ejecutarCola(cola, trabajar, log) {
  let pendiente = [...cola];
  const sinDias = [];
  for (let vuelta = 1; vuelta <= 3 && pendiente.length; vuelta++) {
    if (vuelta > 1) log(`  — vuelta ${vuelta}: reintento de ${pendiente.length}`);
    const falló = [];
    for (const item of pendiente) {
      try { await trabajar(item); }
      catch (e) {
        if (/sin días/i.test(e.message)) { sinDias.push(item.clave); log(`  ∅ ${item.clave}: ITF aún no publica programación`); }
        else { falló.push(item); log(`  ✗ ${item.clave || item.tipo}: ${e.message.split('\n')[0].slice(0, 90)}`); }
      }
    }
    pendiente = falló;
  }
  return { fallidos: pendiente.map(i => i.clave || i.tipo), sinDias };
}

/* ---------- corrida ---------- */
export async function correr({ soloPlan = false, log = console.log } = {}) {
  const hoy = new Date().toISOString().slice(0, 10);
  const { colaA, colaB, archivar } = planificar(hoy);
  log(`Plan: ${colaA.length} cosechas (oop/cuadros) · ${colaB.length} tareas de calendario/acceptance · ${archivar.length} por archivar`);
  for (const i of [...colaA, ...colaB]) log(`  · ${i.tipo.padEnd(10)} ${(i.clave || '').padEnd(22)} ${i.razon}`);
  if (soloPlan) return null;

  const res = { fase: {}, archivados: 0 };
  const { browser } = await abrirNavegador();
  try {
    /* FASE A: goto directo por torneo (sin pisar el calendario antes) */
    if (colaA.length) {
      const ctx = await browser.newContext({ ignoreHTTPSErrors: !!process.env.HTTPS_PROXY });
      const page = await ctx.newPage();
      log(`— fase A: ${colaA.length} torneos (oop + cuadros)`);
      res.fase.A = await ejecutarCola(colaA, i => cosecharTorneo(page, { clave: i.clave, enlace: i.t.enlace }, hoy), log);
      await ctx.close();
    }
    /* FASE B: contexto calentado en el calendario */
    if (colaB.length) {
      const ctx = await browser.newContext({ ignoreHTTPSErrors: !!process.env.HTTPS_PROXY });
      const page = await calentar(ctx, 'https://www.itftennis.com/en/tournament-calendar/mens-world-tennis-tour-calendar/');
      log(`— fase B: ${colaB.length} tareas (calendario/acceptance)`);
      res.fase.B = await ejecutarCola(colaB, async i => {
        await pausaHumana();
        if (i.tipo === 'calendario') {
          const desde = new Date(Date.now() - 28 * 864e5).toISOString().slice(0, 10);
          const hasta = new Date(Date.now() + 14 * 864e5).toISOString().slice(0, 10);
          const torneos = [];
          for (const c of ['MT', 'WT']) { torneos.push(...await bajarCalendario(page, c, desde, hasta)); await pausaHumana(); }
          fs.writeFileSync(CACHE_CALENDARIO, JSON.stringify({ actualizado: new Date().toISOString(), nota: `MT,WT ${desde} a ${hasta} vía navegador`, torneos }, null, 1));
          log(`  ✓ calendario: ${torneos.length} torneos`);
        } else {
          const a = await bajarAceptacion(page, i.clave);
          if (!Object.keys(a.secciones).length) { log(`  ∅ ${i.clave}: lista vacía (ITF ya la borró)`); return; }
          fs.writeFileSync(path.join(DATOS, i.clave + '.aceptacion.json'), JSON.stringify(a));
          const n = Object.fromEntries(Object.entries(a.secciones).map(([k, v]) => [k, v.length]));
          log(`  ✓ ${i.clave}  MDA:${n.MDA ?? 0} Q:${n.Q ?? 0} A:${n.A ?? 0} W:${n.W ?? 0}`);
        }
      }, log);
    }
  } finally { await browser.close(); }

  /* archivar y dejar el mapa al día con lo recién bajado */
  const m = refrescarMapa();
  for (const sem of Object.values(m.semanas))
    for (const [clave, t] of Object.entries(sem))
      if (archivar.includes(clave)) { t.archivado = true; res.archivados++; }
  guardarMapa(m);
  log(`Listo. ${res.archivados} torneos archivados. Mapa al día.`);
  return res;
}

/* ---------- CLI ---------- */
const esCli = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (esCli) await correr({ soloPlan: process.argv.includes('--plan') });
