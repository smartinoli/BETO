#!/usr/bin/env node
/* ============================================================
   ITF-CUOTAS-CARGAR — mete cuotas leídas de pantallazos de Betano
   en vigia/itf-cuotas-manuales.json, y avisa cuáles NO cruzan.

   Por qué existe: betano.com nos responde 403 desde este entorno (bloqueo
   geográfico de Cloudflare, salimos por Washington) y OddsPapi no entrega
   el precio hasta que el partido empieza. Así que las cuotas llegan por
   pantallazo de Sebastián y alguien tiene que pasarlas a JSON sin errores.

   Lo importante que hace: cruza cada cuota contra el order of play y dice
   cuáles NO encontraron partido. Ahí saltan las diferencias de escritura
   entre Betano e ITF ("Baybar" contra "Baybars", "Luca" contra "Lucca"),
   que si no se corrigen dejan la cuota muerta en el archivo.

   Uso — una línea por partido, separada por "|":
     node vigia/itf-cuotas-cargar.mjs <<'FIN'
     M25 Oviedo | Xavi Palomar | 1.16 | Alvaro De Miguel Montero | 4.60
     FIN

   Opciones:
     --probar    solo informa el cruce, no escribe
     --limpiar   además borra las entradas viejas que ya no cruzan con
                 ningún partido pendiente (partidos ya jugados)
   ============================================================ */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pareceElMismo } from './itf-cruce.mjs';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const ARCHIVO = path.join(DIR, 'itf-cuotas-manuales.json');
const OOP = path.join(DIR, 'datos', 'itf', 'oop');
const leer = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')) } catch { return null } };
const hoy = new Date().toISOString().slice(0, 10);

/* partidos que ITF marca por jugar, para verificar el cruce */
function pendientes() {
  const out = [];
  let arch = [];
  try { arch = fs.readdirSync(OOP) } catch { return out; }
  for (const f of arch) {
    const j = leer(path.join(OOP, f));
    if (!j || j.fecha < hoy) continue;
    for (const p of j.partidos || []) {
      if (p.tipo !== 'MS' && p.tipo !== 'MSQ') continue;
      if (p.estado !== 'pendiente') continue;
      const n = (p.lados || []).map(l => l.nombre).filter(Boolean);
      if (n.length === 2) out.push({ n, clave: j.clave, fecha: j.fecha, ronda: p.ronda });
    }
  }
  return out;
}
const cruza = (a, b, lista) => lista.find(x =>
  (pareceElMismo(a, { nombre: x.n[0] }) && pareceElMismo(b, { nombre: x.n[1] })) ||
  (pareceElMismo(a, { nombre: x.n[1] }) && pareceElMismo(b, { nombre: x.n[0] })));

/* ---------- entrada ---------- */
const args = process.argv.slice(2);
const soloProbar = args.includes('--probar');
const limpiar = args.includes('--limpiar');
const crudo = fs.readFileSync(0, 'utf8');
const nuevas = [];
for (const linea of crudo.split('\n')) {
  const t = linea.trim();
  if (!t || t.startsWith('#')) continue;
  const c = t.split('|').map(x => x.trim());
  if (c.length < 5) { console.log(`  ⚠ línea ignorada (faltan campos): ${t.slice(0, 60)}`); continue; }
  const [torneo, p1, g1, p2, g2] = c;
  if (!(+g1 > 1) || !(+g2 > 1)) { console.log(`  ⚠ cuotas inválidas en: ${t.slice(0, 60)}`); continue; }
  nuevas.push({ torneo, p1, p2, g1: +g1, g2: +g2, visto: new Date().toISOString().slice(0, 16) + 'Z' });
}

const doc = leer(ARCHIVO) || { nota: 'cuotas leídas a mano de betano.com', casa: 'betano', cuotas: [] };
const lista = pendientes();
const mismoPar = (a, b) =>
  (pareceElMismo(a.p1, { nombre: b.p1 }) && pareceElMismo(a.p2, { nombre: b.p2 })) ||
  (pareceElMismo(a.p1, { nombre: b.p2 }) && pareceElMismo(a.p2, { nombre: b.p1 }));

let add = 0, upd = 0;
const sinCruce = [];
for (const n of nuevas) {
  const m = cruza(n.p1, n.p2, lista);
  if (!m) { sinCruce.push(n); continue; }
  /* se guarda con la escritura de ITF: así el cruce nunca depende de cómo
     lo escriba Betano, que es de donde vinieron todos los fallos */
  n.p1 = pareceElMismo(n.p1, { nombre: m.n[0] }) ? m.n[0] : m.n[1];
  n.p2 = n.p1 === m.n[0] ? m.n[1] : m.n[0];
  if (!pareceElMismo(nuevas.find(x => x === n).p1, { nombre: m.n[0] })) { /* orientación ya resuelta arriba */ }
  const prev = doc.cuotas.findIndex(x => mismoPar(x, n));
  if (prev >= 0) { doc.cuotas[prev] = { ...doc.cuotas[prev], ...n }; upd++; }
  else { doc.cuotas.push(n); add++; }
}

if (limpiar) {
  const antes = doc.cuotas.length;
  doc.cuotas = doc.cuotas.filter(c => cruza(c.p1, c.p2, lista));
  const fuera = antes - doc.cuotas.length;
  if (fuera) console.log(`  limpieza: ${fuera} entradas de partidos ya jugados`);
}

console.log(`\n${add} nuevas · ${upd} actualizadas · ${doc.cuotas.length} en el archivo`);
if (sinCruce.length) {
  console.log(`\n⚠ ${sinCruce.length} NO cruzan con ningún partido pendiente de ITF — revisá la escritura:`);
  for (const n of sinCruce) {
    console.log(`   ${n.p1} vs ${n.p2}  (${n.torneo})`);
    /* pista: buscar apellidos parecidos entre los pendientes */
    const tok = s => String(s).toLowerCase().split(/\s+/).filter(x => x.length >= 4);
    const pistas = lista.filter(x => x.n.some(nn => tok(nn).some(t => tok(n.p1 + ' ' + n.p2).some(u => t.startsWith(u.slice(0, 4)) || u.startsWith(t.slice(0, 4))))));
    for (const p of pistas.slice(0, 2)) console.log(`      ¿será?  ${p.n.join(' vs ')}  [${p.clave} ${p.ronda}]`);
  }
}
if (soloProbar) { console.log('\n(--probar: no se escribió nada)'); process.exit(0); }
fs.writeFileSync(ARCHIVO, JSON.stringify(doc, null, 1));
console.log(`✓ ${ARCHIVO}`);
