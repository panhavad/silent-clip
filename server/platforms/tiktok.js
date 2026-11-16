// TikTok via Login Kit + Content Posting API (Direct Post, FILE_UPLOAD) — or "inbox" drafts
// when TIKTOK_POST_MODE=inbox (works before the app passes TikTok's audit for public posting).
import fs from 'node:fs';
import { call, form, sleep, captionFor } from './http.js';

const API = 'https://open.tiktokapis.com/v2';
const json = (token) => ({ Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=UTF-8' });

async function tokens(body) {
  const { data: t } = await call(`${API}/oauth/token/`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form({ client_key: process.env.TIKTOK_CLIENT_KEY, client_secret: process.env.TIKTOK_CLIENT_SECRET, ...body }),
  }, 'TikTok token');
  if (t.error) throw new Error(`TikTok token: ${t.error_description || t.error}`);
  return t;
}

export const tiktok = {
  id: 'tiktok',
  label: 'TikTok',
  configured: () => Boolean(process.env.TIKTOK_CLIENT_KEY && process.env.TIKTOK_CLIENT_SECRET),

  authUrl(state, redirectUri) {
    return `https://www.tiktok.com/v2/auth/authorize/?${form({
      client_key: process.env.TIKTOK_CLIENT_KEY, response_type: 'code', redirect_uri: redirectUri, state,
      scope: 'user.info.basic,user.info.profile,video.publish,video.upload',
    })}`;
  },

  async exchange(code, redirectUri) {
    const t = await tokens({ code, grant_type: 'authorization_code', redirect_uri: redirectUri });
    const { data: u } = await call(`${API}/user/info/?fields=open_id,avatar_url,display_name,username`, {
      headers: { Authorization: `Bearer ${t.access_token}` },
    }, 'TikTok profile');
    const user = u.data?.user || {};
    return {
      externalId: t.open_id || user.open_id, username: user.username || user.display_name, displayName: user.display_name,
      avatar: user.avatar_url || null, accessToken: t.access_token, refreshToken: t.refresh_token,
      expiresAt: Date.now() + t.expires_in * 1000,
    };
  },

  async refresh(acc) {
    const t = await tokens({ grant_type: 'refresh_token', refresh_token: acc.refreshToken });
    return { accessToken: t.access_token, refreshToken: t.refresh_token || acc.refreshToken, expiresAt: Date.now() + t.expires_in * 1000 };
  },

  async publish({ acc, clip, file, pollMs = 5000 }) {
    const size = fs.statSync(file).size;
    const source = { source: 'FILE_UPLOAD', video_size: size, chunk_size: size, total_chunk_count: 1 };
    const inbox = process.env.TIKTOK_POST_MODE === 'inbox';
    let init;
    if (inbox) {
      ({ data: init } = await call(`${API}/post/publish/inbox/video/init/`, {
        method: 'POST', headers: json(acc.accessToken), body: JSON.stringify({ source_info: source }),
      }, 'TikTok inbox init'));
    } else {
      const { data: info } = await call(`${API}/post/publish/creator_info/query/`, {
        method: 'POST', headers: json(acc.accessToken), body: '{}',
      }, 'TikTok creator info');
      const options = info.data?.privacy_level_options || [];
      const privacy = options.includes('PUBLIC_TO_EVERYONE') ? 'PUBLIC_TO_EVERYONE' : (options[0] || 'SELF_ONLY');
      ({ data: init } = await call(`${API}/post/publish/video/init/`, {
        method: 'POST', headers: json(acc.accessToken),
        body: JSON.stringify({
          post_info: { title: captionFor(clip, 2200), privacy_level: privacy, disable_duet: false, disable_comment: false, disable_stitch: false, video_cover_timestamp_ms: 1000 },
          source_info: source,
        }),
      }, 'TikTok post init'));
    }
    const { publish_id: publishId, upload_url: uploadUrl } = init.data || {};
    if (!publishId || !uploadUrl) throw new Error(`TikTok init returned no upload URL: ${JSON.stringify(init.error || init)}`);
    await call(uploadUrl, {
      method: 'PUT',
      headers: { 'Content-Type': 'video/mp4', 'Content-Length': String(size), 'Content-Range': `bytes 0-${size - 1}/${size}` },
      body: fs.readFileSync(file),
    }, 'TikTok upload');

    const profile = `https://www.tiktok.com/@${acc.username || ''}`;
    for (let i = 0; i < 60; i++) {
      await sleep(pollMs);
      const { data: st } = await call(`${API}/post/publish/status/fetch/`, {
        method: 'POST', headers: json(acc.accessToken), body: JSON.stringify({ publish_id: publishId }),
      }, 'TikTok status');
      const s = st.data || {};
      if (s.status === 'FAILED') throw new Error(`TikTok rejected the video: ${s.fail_reason || 'unknown reason'}`);
      if (s.status === 'PUBLISH_COMPLETE' || (inbox && s.status === 'SEND_TO_USER_INBOX')) {
        const postId = s.publicaly_available_post_id?.[0];
        return { externalId: String(postId || publishId), url: postId && acc.username ? `${profile}/video/${postId}` : profile };
      }
    }
    return { externalId: publishId, url: profile };
  },
};
