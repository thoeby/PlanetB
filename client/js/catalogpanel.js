// catalogpanel.js — the Marketplace (TASKS-ui.md UI.4–6): Shop, Market,
// Selling, Licences and Earnings, each a part of one surface that takes the
// window, its tabs up in the top bar. Registering a product is Selling's
// "Put a model on sale" (registerhtml.js, catalogui.js).
//
// The categories and licences it offers are the `product` kind's properties
// (db/0040_properties.sql), so an admin decides them rather than a constant.

import * as api from './api.js';
import { mountRegister } from './catalogui.js';
import { SHOP_HTML, mountShop } from './shop.js';
import { SELLING_HTML, mountSelling } from './selling.js';
import { mountSteps } from './registerhtml.js';
import { mountEarnings, mountLicences } from './licences.js';
import { empty } from './empty.js';

// The values a product may carry, as the admin defined them. A world whose
// admin has not defined `category` or `licence` still gets a working catalog:
// the fallbacks are what the starter vocabulary ships with.
export async function productChoices() {
    const kinds = await api.rpc('vocabulary', { applies_to: 'product' }).catch(() => []);
    const props = kinds?.[0]?.properties ?? [];
    const of = (name, fallback) => {
        const found = props.find((p) => p.name === name);
        return found?.choices?.length ? found.choices : fallback;
    };
    return {
        categories: of('category', ['prop', 'building', 'vegetation', 'other']),
        licences: of('licence', ['cc0', 'free', 'paid', 'limited']),
    };
}

const into = (host, html) => {
    const box = document.createElement('div');
    box.innerHTML = html;
    host.append(box);
    return box;
};

// `panel(name)` is the chrome's body for a part (hud.panel). What a signed-in
// player sees follows the session: `refresh` is called again when it changes.
export async function mountMarketplace(panel, { onPublished } = {}) {
    into(panel('Shop'), SHOP_HTML);
    into(panel('Selling'), SELLING_HTML);
    panel('Market').append(empty('The Market comes with the new payment system',
        'Used licences, bids and the last trade are traded here once payments move to'
        + ' GNU Taler. Until then new copies are bought in the Shop.'));
    const choices = await productChoices();
    const shop = mountShop(document, { choices });
    const steps = mountSteps(document);
    const selling = mountSelling(document, {
        onRegisterOpen: () => { steps.go('model'); document.getElementById('file')?.focus(); },
    });
    const register = mountRegister(document, { choices, onPublished: async (san) => {
        await Promise.all([shop.refresh(), selling.refresh()]);
        selling.show(san);
        steps.go('done');
        await onPublished?.(san);
    } });
    const licences = mountLicences(panel('Licences'));
    const earnings = mountEarnings(panel('Earnings'));
    const refresh = async () => {
        document.getElementById('upload').hidden = !api.claims();
        await Promise.all([shop.refresh(), selling.refresh(), licences.refresh(),
            earnings.refresh()]);
    };
    return { refresh, shop, selling, register, steps, licences, earnings,
        open: shop.open, upload: register.upload, forms: register.forms,
        marks: register.marks };
}
