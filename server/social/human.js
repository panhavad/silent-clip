// Human-like interaction helpers: random pauses, hover-before-click, per-character typing.
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const rand = (a, b) => a + Math.random() * (b - a);
export const pause = (a = 400, b = 1100) => sleep(rand(a, b));
const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';

export class LoggedOutError extends Error {
  constructor(label) { super(`Not logged in to ${label}. Open Settings → Social accounts and log in again.`); this.loggedOut = true; this.final = true; }
}

/** Hover, hesitate, then click — instead of an instant programmatic click. */
export async function humanClick(locator, { timeout = 30000 } = {}) {
  await locator.waitFor({ state: 'visible', timeout });
  await locator.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {});
  await locator.hover({ timeout: 5000 }).catch(() => {});
  await pause(180, 520);
  await locator.click({ timeout });
}

/** Type like a person: word by word with small random delays; '\n' becomes Enter. */
export async function humanType(page, text, { fast = false } = {}) {
  const lines = String(text).split('\n');
  for (let i = 0; i < lines.length; i++) {
    for (const word of lines[i].split(/(?<= )/)) {
      if (word) await page.keyboard.type(word, { delay: fast ? rand(6, 18) : rand(25, 70) });
      if (Math.random() < 0.15) await pause(120, 450);
    }
    if (i < lines.length - 1) { await page.keyboard.press('Enter'); await pause(60, 200); }
  }
}

export async function clearAndType(page, locator, text, opts) {
  await humanClick(locator);
  await page.keyboard.press(`${MOD}+A`);
  await pause(80, 200);
  await page.keyboard.press('Backspace');
  await pause(150, 400);
  await humanType(page, text, opts);
}

/** Click the first visible match among `candidates` within `ms`; returns true if something was clicked. */
export async function clickIfVisible(candidates, ms = 1500) {
  const end = Date.now() + ms;
  do {
    for (const c of candidates) {
      const el = c.first();
      if (await el.isVisible().catch(() => false)) {
        await humanClick(el, { timeout: 5000 }).catch(() => {});
        return true;
      }
    }
    await sleep(250);
  } while (Date.now() < end);
  return false;
}

/** Resolve as soon as one of the conditions returns a truthy value (each is polled). */
export async function waitForAny(conditions, { timeout = 60000, every = 500, what = 'the page' } = {}) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    for (const [name, fn] of Object.entries(conditions)) {
      const v = await fn().catch(() => false);
      if (v) return { name, value: v };
    }
    await sleep(every);
  }
  throw new Error(`Timed out waiting for ${what}`);
}
