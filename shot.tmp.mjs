import { chromium } from '@playwright/test';
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
const errs = [];
page.on('pageerror', (e) => errs.push(String(e.stack ?? e).slice(0, 200)));
await page.goto('http://localhost:8080/app/play.html', { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#hud');
await page.waitForTimeout(3500);
const open = async (key, part) => {
  await page.keyboard.press(key);
  await page.waitForTimeout(500);
  if (part) { await page.click(`#panel .parts button[data-tab="${part}"]`); await page.waitForTimeout(900); }
  return page.evaluate(() => ({
    title: document.querySelector('#panel .title')?.textContent,
    part: document.getElementById('panel')?.dataset.part,
    body: document.querySelector('#panel .tab-body:not([hidden])')?.childElementCount,
  }));
};
for (const [key, part] of [['1', null], ['2', null], ['3', null], ['4', null], ['5', null],
  ['`', 'Setup'], ['`', 'Vocabulary'], ['`', 'Symbols'], ['`', 'Ground cover'],
  ['p', null], ['6', null]]) {
  console.log(key, part ?? '', JSON.stringify(await open(key, part)));
}
console.log('errors:', errs.length ? errs.slice(0, 4).join(' | ') : 'none');
await browser.close();
