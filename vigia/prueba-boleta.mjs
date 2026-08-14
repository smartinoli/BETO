import { chromium } from 'playwright-core';
import fs from 'node:fs';

/* Página falsa con el HTML REAL que mandó el usuario, más otras selecciones
   para comprobar que elige la correcta y no cualquiera. */
const paginaBetano = `<!doctype html><html><body>
<div class="market"><h3>Resultado del partido</h3>
  <div role="button" tabindex="0" class="selections__selection selection-horizontal-button" data-qa="event-selection" aria-selected="false" aria-label="Bet on 1 with odds 2.10." data-selnid="10066970424"><span class="selection-horizontal-button__title"><span class="s-name">1</span></span><span>2.10</span></div>
  <div role="button" tabindex="0" class="selections__selection selection-horizontal-button" data-qa="event-selection" aria-selected="false" aria-label="Bet on X with odds 3.35." data-selnid="10066970425"><span class="selection-horizontal-button__title"><span class="s-name">X</span></span><span>3.35</span></div>
  <div role="button" tabindex="0" class="selections__selection selection-horizontal-button" data-qa="event-selection" aria-selected="false" aria-label="Bet on 2 with odds 3.50." data-selnid="10066970426"><span class="selection-horizontal-button__title"><span class="s-name">2</span></span><span>3.50</span></div>
</div>
<div class="market"><h3>Goles Más/Menos</h3>
  <div role="button" class="selection-horizontal-button" data-qa="event-selection" aria-selected="false" aria-label="Bet on Más de 2.5 with odds 1.91." data-selnid="10066971111"><span class="s-name">Más de 2.5</span><span>1.91</span></div>
  <div role="button" class="selection-horizontal-button" data-qa="event-selection" aria-selected="false" aria-label="Bet on Menos de 2.5 with odds 1.95." data-selnid="10066971112"><span class="s-name">Menos de 2.5</span><span>1.95</span></div>
</div>
<div class="market"><h3>Córners Más/Menos</h3>
  <div role="button" class="selection-horizontal-button" data-qa="event-selection" aria-selected="false" aria-label="Bet on Más de 2.5 with odds 1.80." data-selnid="10066972222"><span class="s-name">Más de 2.5</span><span>1.80</span></div>
</div>
<script>
 document.querySelectorAll('[data-qa="event-selection"]').forEach(function(b){
   b.addEventListener('click', function(){ window.__CLICK = b.getAttribute('data-selnid'); });
 });
</script>
</body></html>`;

const html = fs.readFileSync('/home/user/BETO/vigia/boleta.html', 'utf8');
const fn = html.match(/function LLENAR_BOLETA\(\)\{[\s\S]*?\n\}\n/)[0];

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', headless: true });
const casos = [
  { titulo: 'por data-selnid exacto', hash: '#vg=10066971111~m1~M%C3%A1s%20de%202.5~1.91~Goles%20M%C3%A1s%2FMenos', espera: '10066971111' },
  { titulo: 'sin id: rótulo + cuota + familia (goles, NO córners)', hash: '#vg=~m1~M%C3%A1s%20de%202.5~1.91~Goles%20M%C3%A1s%2FMenos', espera: '10066971111' },
  { titulo: 'sin id: debe elegir córners por familia', hash: '#vg=~m1~M%C3%A1s%20de%202.5~1.80~C%C3%B3rners%20M%C3%A1s%2FMenos', espera: '10066972222' },
  { titulo: 'empate (X) por id', hash: '#vg=10066970425~m1~X~3.35~Ganador', espera: '10066970425' },
];

for (const c of casos) {
  const page = await browser.newPage();
  await page.setContent(paginaBetano);
  await page.evaluate(h => { location.hash = h; }, c.hash);
  await page.evaluate("(" + fn + ")(); void 0;".replace("(function", "(function"));
  await page.waitForTimeout(2500);
  const clic = await page.evaluate(() => window.__CLICK || null);
  const aviso = await page.evaluate(() => {
    const d = [...document.querySelectorAll('div')].filter(x => x.style.position === 'fixed')[0];
    return d ? d.textContent.slice(0, 60) : null;
  });
  console.log(`${clic === c.espera ? '✓' : '✗'} ${c.titulo}\n    clic en ${clic} (esperado ${c.espera}) · aviso: ${aviso}`);
  await page.close();
}

/* caso extra: ya seleccionada → NO debe hacer clic */
const page = await browser.newPage();
await page.setContent(paginaBetano.replace('aria-selected="false" aria-label="Bet on Más de 2.5 with odds 1.91." data-selnid="10066971111"',
  'aria-selected="true" aria-label="Bet on Más de 2.5 with odds 1.91." data-selnid="10066971111"'));
await page.evaluate(() => { location.hash = '#vg=10066971111~m1~M%C3%A1s%20de%202.5~1.91~Goles'; });
await page.evaluate("(" + fn + ")(); void 0;".replace("(function", "(function"));
await page.waitForTimeout(2000);
const clic2 = await page.evaluate(() => window.__CLICK || null);
const aviso2 = await page.evaluate(() => {
  const d = [...document.querySelectorAll('div')].filter(x => x.style.position === 'fixed')[0];
  return d ? d.textContent.slice(0, 70) : null;
});
console.log(`${clic2 === null ? '✓' : '✗'} ya en la boleta: no la toca\n    clic: ${clic2} · aviso: ${aviso2}`);

/* caso extra: cuota movida → debe advertir */
const p3 = await browser.newPage();
await p3.setContent(paginaBetano);
await p3.evaluate(() => { location.hash = '#vg=10066971111~m1~M%C3%A1s%20de%202.5~2.05~Goles'; });
await p3.evaluate("(" + fn + ")(); void 0;");
await p3.waitForTimeout(2000);
const aviso3 = await p3.evaluate(() => {
  const d = [...document.querySelectorAll('div')].filter(x => x.style.position === 'fixed')[0];
  return d ? d.textContent : null;
});
console.log(`${/ahora paga/.test(aviso3 || '') ? '✓' : '✗'} avisa si la cuota se movió\n    ${aviso3}`);

await browser.close();
