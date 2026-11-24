// TikTok: drives the TikTok Studio web uploader like a person would.
import { humanClick, clearAndType, clickIfVisible, waitForAny, pause, sleep, LoggedOutError } from './human.js';

const PRIVACY_TEXT = { everyone: /^everyone$/i, friends: /^friends$/i, only_me: /^only (you|me)$/i };

export const tiktok = {
  id: 'tiktok',
  label: 'TikTok',
  loginUrl: 'https://www.tiktok.com/login?lang=en',
  homeUrl: 'https://www.tiktok.com/tiktokstudio/upload?lang=en',
  hosts: ['tiktok.com'],
  sessionCookies: { urls: ['https://www.tiktok.com'], names: ['sessionid', 'sessionid_ss'] },

  async identify(page) {
    await page.goto('https://www.tiktok.com/tiktokstudio?lang=en', { waitUntil: 'domcontentloaded', timeout: 45000 });
    if (/\/login/.test(page.url())) return null;
    const info = await page.evaluate(async () => {
      try {
        const r = await fetch('/passport/web/account/info/?aid=1459', { credentials: 'include' });
        return (await r.json())?.data || null;
      } catch { return null; }
    }).catch(() => null);
    return info?.username ? { username: info.username, displayName: info.screen_name || info.username, avatar: info.avatar_url || null } : { displayName: 'TikTok account' };
  },

  async publish({ page, file, clip, settings, step, final, account }) {
    step('Opening TikTok Studio');
    await page.goto('https://www.tiktok.com/tiktokstudio/upload?from=creator_center&lang=en', { waitUntil: 'domcontentloaded', timeout: 60000 });
    const fileInput = page.locator('input[type=file][accept*="video"], input[type=file]').first();
    const { name } = await waitForAny({
      upload: () => fileInput.count(),
      login: async () => /\/login/.test(page.url()) || page.getByText(/^log in to tiktok$/i).first().isVisible(),
    }, { timeout: 60000, what: 'the TikTok upload page' });
    if (name === 'login') throw new LoggedOutError(this.label);
    await pause(800, 1600);

    step('Uploading video');
    await fileInput.setInputFiles(file);
    const editor = page.locator('div.public-DraftEditor-content[contenteditable="true"], div[contenteditable="true"]').first();
    await editor.waitFor({ state: 'visible', timeout: 120000 });
    await dismissTips(page);
    await pause(1000, 2000);

    step('Writing caption');
    const caption = `${clip.title}\n\n${(clip.hashtags || []).join(' ')}`.slice(0, 2150);
    await clearAndType(page, editor, `${caption} `);
    await pause(800, 1500);
    await page.mouse.click(5, 300).catch(() => {}); // close the hashtag suggestion list
    await dismissTips(page);

    const privacy = settings.tiktokPrivacy || 'everyone';
    if (privacy !== 'everyone') {
      step(`Setting who can watch: ${privacy.replace('_', ' ')}`);
      const ok = await setPrivacy(page, privacy);
      // Never post publicly by mistake when a private post was requested.
      if (!ok) throw new Error(`Could not set "Who can watch" to ${privacy.replace('_', ' ')} on TikTok`);
    }

    step('Waiting for the upload to finish');
    const post = page.locator('button[data-e2e="post_video_button"]').or(page.getByRole('button', { name: /^post$/i })).first();
    await waitForAny({
      ready: async () => (await post.isVisible()) && (await post.isEnabled()) && (await post.getAttribute('aria-disabled')) !== 'true'
        && !(await page.getByText(/uploading/i).first().isVisible().catch(() => false)),
    }, { timeout: 20 * 60000, every: 2000, what: 'the TikTok upload to finish' });
    await pause(1200, 2500);

    step('Posting');
    final();
    await humanClick(post);
    await clickIfVisible([page.getByRole('button', { name: /^post now$/i })], 6000);
    await waitForAny({
      done: async () => /tiktokstudio\/content|\/manage/.test(page.url())
        || page.getByText(/(your video (has been|is being) (uploaded|posted))|video published|posted successfully/i).first().isVisible(),
    }, { timeout: 5 * 60000, what: 'TikTok to confirm the post' });

    let url = account?.username ? `https://www.tiktok.com/@${account.username}` : 'https://www.tiktok.com/tiktokstudio/content';
    let externalId = null;
    await sleep(2500);
    const href = await page.locator('a[href*="/video/"]').first().getAttribute('href', { timeout: 8000 }).catch(() => null);
    if (href) { externalId = href.match(/video\/(\d+)/)?.[1] || null; url = new URL(href, 'https://www.tiktok.com').href; }
    return { externalId, url };
  },
};

async function dismissTips(page) {
  await clickIfVisible([
    page.getByRole('button', { name: /^(got it|not now|skip|ok|close)$/i }),
  ], 1200);
}

async function setPrivacy(page, privacy) {
  const want = PRIVACY_TEXT[privacy];
  const label = page.getByText(/who can (watch|view) this video/i).first();
  if (!(await label.isVisible().catch(() => false))) return false;
  await label.scrollIntoViewIfNeeded().catch(() => {});
  const box = label.locator('xpath=following::*[@role="combobox" or self::button or contains(@class,"select")][1]').first();
  await humanClick(box, { timeout: 8000 }).catch(() => {});
  const option = page.getByRole('option', { name: want }).or(page.locator('[role=option], li, .option-item').filter({ hasText: want })).first();
  if (!(await option.isVisible({ timeout: 4000 }).catch(() => false))) return false;
  await humanClick(option);
  await pause(400, 900);
  const shown = ((await box.textContent().catch(() => '')) || '').trim();
  return want.test(shown.split('\n')[0].trim());
}
