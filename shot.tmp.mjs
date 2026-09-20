import { chromium } from '@playwright/test';
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
page.on('pageerror', (e) => console.log('PAGEERROR', String(e.stack ?? e).slice(0, 300)));
await page.goto('http://localhost:8080/app/play.html', { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#hud');
await page.waitForTimeout(3500);
await page.keyboard.press('5');
await page.waitForTimeout(1200);
console.log(JSON.stringify(await page.evaluate(() => ({
  title: document.querySelector('#panel .title')?.textContent,
  says: document.querySelector('.sc-brush-says')?.textContent,
  shaped: document.querySelector('.sc-shaped')?.textContent,
  here: document.querySelector('.sc-here')?.textContent,
  clear: document.querySelector('.sc-clear')?.textContent,
}))));
await page.click('.sc-brush-level');
await page.waitForTimeout(400);
console.log('level fields:', await page.evaluate(() =>
  [...document.querySelectorAll('.sc-fields label')].map((l) => [l.dataset.uses, l.hidden])));
await page.click('.sc-brush-line');
await page.waitForTimeout(400);
console.log('line:', await page.evaluate(() => ({
  corners: document.querySelector('.sc-corners')?.textContent,
  box: !document.querySelector('.sc-line-box')?.hidden })));
await page.screenshot({ path: '/tmp/shots/terrain.png' });
await browser.close();
