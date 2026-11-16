// Publishing happens from the browser. YouTube uses the official Data API with a
// short-lived token from Google Identity Services; TikTok / Instagram use assisted posting.
let gisPromise = null;
let ytToken = null;

function loadGis() {
  if (!gisPromise) {
    gisPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'https://accounts.google.com/gsi/client';
      s.async = true;
      s.onload = resolve;
      s.onerror = () => { gisPromise = null; reject(new Error('Could not load Google Identity Services')); };
      document.head.append(s);
    });
  }
  return gisPromise;
}

async function youtubeToken(clientId) {
  if (ytToken && ytToken.exp > Date.now() + 60000) return ytToken.value;
  await loadGis();
  return new Promise((resolve, reject) => {
    const client = window.google.accounts.oauth2.initTokenClient({
      client_id: clientId,
      scope: 'https://www.googleapis.com/auth/youtube.upload',
      callback: (r) => {
        if (r.error) return reject(new Error(r.error_description || r.error));
        ytToken = { value: r.access_token, exp: Date.now() + (Number(r.expires_in) || 3600) * 1000 };
        resolve(r.access_token);
      },
      error_callback: (e) => reject(new Error(e?.message || e?.type || 'Google authorization cancelled')),
    });
    client.requestAccessToken();
  });
}

export function postText(clip) {
  return `${clip.title}\n\n${clip.hashtags.join(' ')}`;
}

export async function uploadToYouTube(clip, { clientId, privacy = 'public', onProgress = () => {} }) {
  const token = await youtubeToken(clientId);
  const blob = await (await fetch(clip.videoUrl, { credentials: 'same-origin' })).blob();
  let description = clip.description || '';
  if (!/#shorts/i.test(description)) description += '\n#Shorts';
  const metadata = {
    snippet: {
      title: clip.title.replace(/[<>]/g, '').slice(0, 100) || 'Twitch moment',
      description: description.replace(/[<>]/g, '').slice(0, 4900),
      tags: clip.hashtags.map((h) => h.replace(/^#/, '')).slice(0, 15),
      categoryId: '20',
    },
    status: { privacyStatus: privacy, selfDeclaredMadeForKids: false },
  };
  const init = await fetch('https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json; charset=UTF-8',
      'X-Upload-Content-Type': 'video/mp4',
      'X-Upload-Content-Length': String(blob.size),
    },
    body: JSON.stringify(metadata),
  });
  if (!init.ok) {
    const err = await init.json().catch(() => ({}));
    if (init.status === 401) ytToken = null;
    throw new Error(err.error?.message || `YouTube init failed (${init.status})`);
  }
  const uploadUrl = init.headers.get('Location');
  if (!uploadUrl) throw new Error('YouTube did not return an upload URL');
  const result = await new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', uploadUrl);
    xhr.setRequestHeader('Content-Type', 'video/mp4');
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    xhr.onload = () => (xhr.status < 300 ? resolve(JSON.parse(xhr.responseText)) : reject(new Error(`YouTube upload failed (${xhr.status})`)));
    xhr.onerror = () => reject(new Error('Network error during YouTube upload'));
    xhr.send(blob);
  });
  return { id: result.id, url: `https://www.youtube.com/shorts/${result.id}` };
}

export async function shareClip(clip) {
  const blob = await (await fetch(clip.videoUrl, { credentials: 'same-origin' })).blob();
  const file = new File([blob], `${clip.title.replace(/[^\w\- ]+/g, '').trim().slice(0, 60) || 'clip'}.mp4`, { type: 'video/mp4' });
  if (navigator.canShare?.({ files: [file] })) {
    await navigator.share({ files: [file], title: clip.title, text: postText(clip) });
    return true;
  }
  return false;
}

export const UPLOAD_PAGES = {
  tiktok: 'https://www.tiktok.com/tiktokstudio/upload',
  instagram: 'https://www.instagram.com/',
  youtube: 'https://studio.youtube.com/',
};
