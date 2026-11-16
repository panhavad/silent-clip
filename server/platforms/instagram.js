// Instagram Reels via the Instagram API with Instagram Login (Business / Creator accounts).
// Instagram pulls the video from a signed public URL when PUBLIC_URL is https; otherwise the
// bytes are pushed with the resumable upload endpoint.
import fs from 'node:fs';
import { call, form, sleep, captionFor } from './http.js';

const GRAPH = 'https://graph.instagram.com/v21.0';

export const instagram = {
  id: 'instagram',
  label: 'Instagram Reels',
  configured: () => Boolean(process.env.INSTAGRAM_APP_ID && process.env.INSTAGRAM_APP_SECRET),
  // Long-lived tokens can't be refreshed after they expire, so refresh a week early.
  refreshBeforeMs: 7 * 24 * 3600 * 1000,

  authUrl(state, redirectUri) {
    return `https://www.instagram.com/oauth/authorize?${form({
      enable_fb_login: 0, force_authentication: 1, client_id: process.env.INSTAGRAM_APP_ID, redirect_uri: redirectUri,
      response_type: 'code', scope: 'instagram_business_basic,instagram_business_content_publish', state,
    })}`;
  },

  async exchange(code, redirectUri) {
    const { data: short } = await call('https://api.instagram.com/oauth/access_token', {
      method: 'POST',
      body: form({ client_id: process.env.INSTAGRAM_APP_ID, client_secret: process.env.INSTAGRAM_APP_SECRET, grant_type: 'authorization_code', redirect_uri: redirectUri, code }),
    }, 'Instagram token exchange');
    const s = short.data?.[0] || short;
    const { data: long } = await call(`https://graph.instagram.com/access_token?${form({
      grant_type: 'ig_exchange_token', client_secret: process.env.INSTAGRAM_APP_SECRET, access_token: s.access_token,
    })}`, {}, 'Instagram long-lived token');
    const { data: me } = await call(`${GRAPH}/me?${form({ fields: 'user_id,username,name,profile_picture_url', access_token: long.access_token })}`, {}, 'Instagram profile');
    return {
      externalId: String(me.user_id || s.user_id), username: me.username, displayName: me.name || me.username,
      avatar: me.profile_picture_url || null, accessToken: long.access_token, refreshToken: null,
      expiresAt: Date.now() + (long.expires_in || 5184000) * 1000,
    };
  },

  async refresh(acc) {
    const { data } = await call(`https://graph.instagram.com/refresh_access_token?${form({ grant_type: 'ig_refresh_token', access_token: acc.accessToken })}`, {}, 'Instagram token refresh');
    return { accessToken: data.access_token, refreshToken: null, expiresAt: Date.now() + (data.expires_in || 5184000) * 1000 };
  },

  async publish({ acc, clip, file, publicUrl, pollMs = 5000 }) {
    const token = acc.accessToken;
    const params = { media_type: 'REELS', caption: captionFor(clip, 2200), share_to_feed: 'true', access_token: token };
    if (publicUrl) params.video_url = publicUrl; else params.upload_type = 'resumable';
    const { data: container } = await call(`${GRAPH}/${acc.externalId}/media`, { method: 'POST', body: form(params) }, 'Instagram create reel');
    if (!publicUrl) {
      const size = fs.statSync(file).size;
      await call(`https://rupload.facebook.com/ig-api-upload/v21.0/${container.id}`, {
        method: 'POST',
        headers: { Authorization: `OAuth ${token}`, offset: '0', file_size: String(size), 'Content-Type': 'application/octet-stream' },
        body: fs.readFileSync(file),
      }, 'Instagram upload');
    }
    for (let i = 0; ; i++) {
      await sleep(pollMs);
      const { data: st } = await call(`${GRAPH}/${container.id}?${form({ fields: 'status_code,status', access_token: token })}`, {}, 'Instagram status');
      if (st.status_code === 'FINISHED') break;
      if (st.status_code === 'ERROR' || st.status_code === 'EXPIRED') throw new Error(`Instagram could not process the video: ${st.status || st.status_code}`);
      if (i > 60) throw new Error('Instagram processing timed out');
    }
    const { data: pub } = await call(`${GRAPH}/${acc.externalId}/media_publish`, {
      method: 'POST', body: form({ creation_id: container.id, access_token: token }),
    }, 'Instagram publish');
    const { data: media } = await call(`${GRAPH}/${pub.id}?${form({ fields: 'permalink', access_token: token })}`, {}, 'Instagram permalink').catch(() => ({ data: {} }));
    return { externalId: pub.id, url: media.permalink || `https://www.instagram.com/${acc.username || ''}` };
  },
};
