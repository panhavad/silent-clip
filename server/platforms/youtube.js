// YouTube Shorts via YouTube Data API v3 (resumable upload) using the user's linked Google account.
import fs from 'node:fs';
import { call, form } from './http.js';

const SCOPES = 'https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.readonly';

export const youtube = {
  id: 'youtube',
  label: 'YouTube Shorts',
  configured: () => Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET),

  authUrl(state, redirectUri) {
    return `https://accounts.google.com/o/oauth2/v2/auth?${form({
      client_id: process.env.GOOGLE_CLIENT_ID, redirect_uri: redirectUri, response_type: 'code',
      scope: SCOPES, access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true', state,
    })}`;
  },

  async exchange(code, redirectUri) {
    const { data: t } = await call('https://oauth2.googleapis.com/token', {
      method: 'POST',
      body: form({ code, client_id: process.env.GOOGLE_CLIENT_ID, client_secret: process.env.GOOGLE_CLIENT_SECRET, redirect_uri: redirectUri, grant_type: 'authorization_code' }),
    }, 'Google token exchange');
    const { data: ch } = await call('https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true', {
      headers: { Authorization: `Bearer ${t.access_token}` },
    }, 'YouTube channel lookup');
    const c = ch.items?.[0];
    if (!c) throw new Error('This Google account has no YouTube channel');
    return {
      externalId: c.id, username: c.snippet.customUrl || c.snippet.title, displayName: c.snippet.title,
      avatar: c.snippet.thumbnails?.default?.url || null,
      accessToken: t.access_token, refreshToken: t.refresh_token, expiresAt: Date.now() + t.expires_in * 1000,
    };
  },

  async refresh(acc) {
    const { data: t } = await call('https://oauth2.googleapis.com/token', {
      method: 'POST',
      body: form({ client_id: process.env.GOOGLE_CLIENT_ID, client_secret: process.env.GOOGLE_CLIENT_SECRET, refresh_token: acc.refreshToken, grant_type: 'refresh_token' }),
    }, 'Google token refresh');
    return { accessToken: t.access_token, refreshToken: t.refresh_token || acc.refreshToken, expiresAt: Date.now() + t.expires_in * 1000 };
  },

  async publish({ acc, clip, file }) {
    const size = fs.statSync(file).size;
    let description = clip.description || '';
    if (!/#shorts/i.test(description)) description += '\n#Shorts';
    const meta = {
      snippet: {
        title: (clip.title || 'Twitch moment').replace(/[<>]/g, '').slice(0, 100),
        description: description.replace(/[<>]/g, '').slice(0, 4900),
        tags: (clip.hashtags || []).map((h) => h.replace(/^#/, '')).slice(0, 15),
        categoryId: '20',
      },
      status: { privacyStatus: process.env.YOUTUBE_PRIVACY || 'public', selfDeclaredMadeForKids: false },
    };
    const { res } = await call('https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${acc.accessToken}`, 'Content-Type': 'application/json; charset=UTF-8',
        'X-Upload-Content-Type': 'video/mp4', 'X-Upload-Content-Length': String(size),
      },
      body: JSON.stringify(meta),
    }, 'YouTube upload init');
    const location = res.headers.get('location');
    if (!location) throw new Error('YouTube did not return an upload URL');
    const { data } = await call(location, {
      method: 'PUT', headers: { 'Content-Type': 'video/mp4', 'Content-Length': String(size) }, body: fs.readFileSync(file),
    }, 'YouTube upload');
    return { externalId: data.id, url: `https://www.youtube.com/shorts/${data.id}` };
  },
};
