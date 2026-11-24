// YouTube Shorts: drives YouTube Studio's upload dialog like a person would.
import { humanClick, clearAndType, clickIfVisible, waitForAny, pause, LoggedOutError } from './human.js';

const VISIBILITY = { public: 'PUBLIC', unlisted: 'UNLISTED', private: 'PRIVATE' };

export const youtube = {
  id: 'youtube',
  label: 'YouTube Shorts',
  loginUrl: 'https://accounts.google.com/ServiceLogin?service=youtube&hl=en&continue=https%3A%2F%2Fstudio.youtube.com%2F',
  homeUrl: 'https://studio.youtube.com/',
  hosts: ['youtube.com', 'google.com'],
  sessionCookies: { urls: ['https://www.youtube.com'], names: ['LOGIN_INFO', 'SID', '__Secure-3PSID'] },

  async identify(page) {
    await page.goto('https://studio.youtube.com/?hl=en', { waitUntil: 'domcontentloaded', timeout: 45000 });
    if (/accounts\.google\.com/.test(page.url())) return null;
    const name = await page.locator('#entity-name, ytcp-entity-page-header #channel-title, .channel-title').first()
      .textContent({ timeout: 15000 }).catch(() => null);
    return { displayName: name?.trim() || 'YouTube channel', username: name?.trim() || null };
  },

  async publish({ page, file, clip, settings, step, final }) {
    step('Opening YouTube Studio');
    await page.goto('https://www.youtube.com/upload?hl=en', { waitUntil: 'domcontentloaded', timeout: 60000 });
    if (/accounts\.google\.com|ServiceLogin/.test(page.url())) throw new LoggedOutError(this.label);
    const fileInput = page.locator('ytcp-uploads-dialog input[type=file], input[type=file][name=Filedata], input[type=file]').first();
    await waitForAny({
      dialog: () => fileInput.count(),
      noChannel: () => page.getByText(/create (a|your) channel/i).first().isVisible(),
      login: async () => /accounts\.google\.com/.test(page.url()),
    }, { timeout: 60000, what: 'the YouTube upload dialog' }).then(({ name }) => {
      if (name === 'login') throw new LoggedOutError(this.label);
      if (name === 'noChannel') throw Object.assign(new Error('This Google account has no YouTube channel yet. Create one on YouTube first.'), { final: true });
    });
    await pause(600, 1400);

    step('Uploading video');
    await fileInput.setInputFiles(file);
    const title = page.locator('#title-textarea #textbox').first();
    await title.waitFor({ state: 'visible', timeout: 120000 });
    await pause(1200, 2500);

    step('Writing title and description');
    const titleText = (clip.title || 'Twitch moment').replace(/[<>]/g, '').slice(0, 100);
    let description = (clip.description || '').replace(/[<>]/g, '');
    if (!/#shorts/i.test(description)) description += `${description ? '\n' : ''}#Shorts`;
    await clearAndType(page, title, titleText);
    await pause();
    await clearAndType(page, page.locator('#description-textarea #textbox').first(), description.slice(0, 4900), { fast: true });
    await pause();

    step('Setting audience');
    await humanClick(page.locator('tp-yt-paper-radio-button[name="VIDEO_MADE_FOR_KIDS_NOT_MFK"]').first());
    await pause();

    for (const label of ['Video elements', 'Checks', 'Visibility']) {
      step(`Next: ${label}`);
      await humanClick(page.locator('#next-button').first());
      await pause(900, 1800);
    }

    const vis = VISIBILITY[settings.youtubeVisibility] || 'PUBLIC';
    step(`Setting visibility to ${vis.toLowerCase()}`);
    const radio = page.locator(`tp-yt-paper-radio-button[name="${vis}"]`).first();
    await humanClick(radio);
    if ((await radio.getAttribute('aria-checked').catch(() => null)) === 'false') {
      throw new Error(`Could not set visibility to ${vis.toLowerCase()}`);
    }
    const href = await page.locator('ytcp-video-info a.ytcp-video-info, .video-url-fadeable a').first()
      .getAttribute('href', { timeout: 60000 }).catch(() => null);

    step('Waiting for the upload to finish');
    const progress = page.locator('ytcp-uploads-dialog ytcp-video-upload-progress .progress-label, ytcp-uploads-dialog .progress-label').first();
    await waitForAny({
      done: async () => !/uploading/i.test((await progress.textContent({ timeout: 2000 })) || ''),
    }, { timeout: 20 * 60000, every: 2000, what: 'the YouTube upload to finish' });
    const errorText = await page.locator('ytcp-uploads-dialog #error-message').first().textContent({ timeout: 1000 }).catch(() => '');
    if (errorText?.trim()) throw new Error(`YouTube: ${errorText.trim()}`);

    step('Publishing');
    final();
    await humanClick(page.locator('#done-button').first());
    const { name } = await waitForAny({
      shared: () => page.locator('ytcp-video-share-dialog, ytcp-uploads-still-processing-dialog').first().isVisible(),
      warning: () => page.locator('ytcp-prechecks-warning-dialog').first().isVisible(),
    }, { timeout: 180000, what: 'YouTube to confirm the video was published' });
    if (name === 'warning') {
      await clickIfVisible([page.locator('ytcp-prechecks-warning-dialog #primary-action-button'), page.getByRole('button', { name: /publish/i })], 5000);
      await page.locator('ytcp-video-share-dialog, ytcp-uploads-still-processing-dialog').first().waitFor({ timeout: 120000 }).catch(() => {});
    }
    const id = href?.match(/(?:youtu\.be\/|shorts\/|v=)([\w-]{6,})/)?.[1] || null;
    return { externalId: id, url: id ? `https://www.youtube.com/shorts/${id}` : 'https://studio.youtube.com/' };
  },
};
