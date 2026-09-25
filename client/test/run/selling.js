// Putting a product on sale the way a maker does it now (TASKS-ui.md UI.5):
// Marketplace › Selling, in four steps — the model, its parts, its name and
// price, and Register — and finding one again in the Shop.

import { expect, panel, UI } from './players.js';

// One of the four steps, by the stepper at the top of the form.
export const step = (c, id) => c.page.locator(`#upload .rg-step[data-step="${id}"]`).click();

// Selling, at the first step.
export async function onSale(c) {
    await panel(c, 'Selling');
    await expect(c.page.locator('#upload')).toBeVisible({ timeout: UI });
    await step(c, 'model');
}

// The last step, and Register.
export async function register(c) {
    await step(c, 'done');
    await c.page.locator('#publish').click();
}

// The Shop, searched by name, and the card that name is on.
export async function inTheShop(c, name) {
    await panel(c, 'Shop');
    await c.page.locator('#type').selectOption('');
    await c.page.locator('#q').fill(name);
    await c.page.getByRole('button', { name: 'Find', exact: true }).click();
    const card = c.page.locator('#results li', { hasText: name }).first();
    await expect(card).toBeVisible({ timeout: UI });
    return card;
}

export const sanOf = async (c, name) =>
    (await (await inTheShop(c, name)).locator('.san').textContent()).trim();
