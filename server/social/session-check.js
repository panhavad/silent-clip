// Shared sign-in checks used by the keep-alive, the Check button and posting.

/**
 * Ask the platform whether this browser is signed in and, when it says no, try the platform's silent
 * re-sign-in once (Google keeps its own account login even when YouTube's cookies lapse).
 * Resolves true / false, or null when the platform gave no clear answer. Sets `page.__healed` on repair.
 */
export async function healSignIn(driver, page) {
  const first = await driver.signedIn(page).catch(() => null);
  if (first !== false || !driver.passiveLoginUrl) return first;
  await page.goto(driver.passiveLoginUrl, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
  // The silent sign-in hops through a few redirects; give it time to land.
  for (let i = 0; i < 30 && /accounts\.google\.com\/(ServiceLogin|CheckCookie|signin\/v\d\/passive)/.test(page.url()); i++) {
    await page.waitForTimeout(500);
  }
  const again = await driver.signedIn(page).catch(() => null);
  if (again === true) page.__healed = true;
  return again === null ? false : again;
}
