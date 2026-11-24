// Instagram Reels: drives instagram.com's "Create" flow like a person would.
import { humanClick, clearAndType, clickIfVisible, waitForAny, pause, LoggedOutError } from './human.js';

export const instagram = {
  id: 'instagram',
  label: 'Instagram Reels',
  loginUrl: 'https://www.instagram.com/accounts/login/?hl=en',
  homeUrl: 'https://www.instagram.com/?hl=en',
  loggedOutUrl: /accounts\/login/,
  hosts: ['instagram.com', 'facebook.com'],
  sessionCookies: { urls: ['https://www.instagram.com'], names: ['sessionid'] },

  async identify(page, cookies = []) {
    await page.goto('https://www.instagram.com/?hl=en', { waitUntil: 'domcontentloaded', timeout: 45000 });
    if (/accounts\/login/.test(page.url())) return null;
    const uid = cookies.find((c) => c.name === 'ds_user_id')?.value;
    const user = uid ? await page.evaluate(async (id) => {
      try {
        const r = await fetch(`/api/v1/users/${id}/info/`, { headers: { 'X-IG-App-ID': '936619743392459' }, credentials: 'include' });
        return (await r.json())?.user || null;
      } catch { return null; }
    }, uid).catch(() => null) : null;
    return user?.username
      ? { username: user.username, displayName: user.full_name || user.username, avatar: user.profile_pic_url || null }
      : { displayName: 'Instagram account' };
  },

  async publish({ page, file, clip, step, final, account }) {
    step('Opening Instagram');
    await page.goto('https://www.instagram.com/?hl=en', { waitUntil: 'domcontentloaded', timeout: 60000 });
    if (/accounts\/login/.test(page.url())) throw new LoggedOutError(this.label);
    const create = page.locator('svg[aria-label="New post"], svg[aria-label="Create"]').first();
    const { name } = await waitForAny({
      ready: () => create.isVisible(),
      login: async () => /accounts\/login/.test(page.url())
        || page.locator('input[name=username], input[name=email]').first().isVisible()
        || page.getByRole('link', { name: /^log in$/i }).or(page.getByRole('button', { name: /^log in$/i })).first().isVisible(),
    }, { timeout: 60000, what: 'Instagram to load' });
    if (name === 'login') throw new LoggedOutError(this.label);
    await dismiss(page);
    await pause(800, 1600);

    step('Starting a new post');
    await humanClick(create);
    await clickIfVisible([page.locator('svg[aria-label="Post"]').locator('xpath=ancestor::a[1] | ancestor::*[@role="link" or @role="button"][1]'), page.getByRole('link', { name: /^post$/i })], 2500);
    const dialog = page.getByRole('dialog').last();
    const fileInput = page.locator('form[enctype="multipart/form-data"] input[type=file], div[role=dialog] input[type=file], input[type=file][accept*="video"]').first();
    await fileInput.waitFor({ state: 'attached', timeout: 30000 });
    await pause(700, 1500);

    step('Uploading video');
    await fileInput.setInputFiles(file);
    await clickIfVisible([page.getByRole('button', { name: /^ok$/i })], 6000); // "Video posts are now shared as reels"

    step('Choosing the 9:16 crop');
    const cropBtn = page.locator('svg[aria-label="Select crop"]').first();
    if (await cropBtn.isVisible({ timeout: 15000 }).catch(() => false)) {
      await humanClick(cropBtn);
      await clickIfVisible([page.getByText(/^original$/i), page.getByText(/^9:16$/)], 3000);
      await pause();
    }

    for (const label of ['Edit', 'Caption']) {
      step(`Next: ${label}`);
      await humanClick(dialog.getByRole('button', { name: /^next$/i }).first(), { timeout: 60000 });
      await pause(1200, 2200);
    }

    step('Writing caption');
    const caption = `${clip.title}\n\n${(clip.hashtags || []).join(' ')}`.slice(0, 2150);
    const box = page.locator('div[aria-label="Write a caption..."][contenteditable="true"], div[contenteditable="true"][role="textbox"]').first();
    await clearAndType(page, box, caption);
    await pause(900, 1800);

    step('Sharing');
    final();
    await humanClick(dialog.getByRole('button', { name: /^share$/i }).first());
    await waitForAny({
      shared: () => page.getByText(/your (reel|post) has been shared|reel shared|post shared/i).first().isVisible(),
      checkmark: () => page.locator('img[alt="Animated checkmark"]').first().isVisible(),
    }, { timeout: 10 * 60000, every: 1500, what: 'Instagram to confirm the reel was shared' });
    await clickIfVisible([page.locator('svg[aria-label="Close"]')], 3000);
    const url = account?.username ? `https://www.instagram.com/${account.username}/reels/` : 'https://www.instagram.com/';
    return { externalId: null, url };
  },
};

async function dismiss(page) {
  await clickIfVisible([page.getByRole('button', { name: /^not now$/i })], 1500);
}
