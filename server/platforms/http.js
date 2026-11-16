export async function call(url, opts = {}, label = 'request') {
  const res = await fetch(url, opts);
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) {
    const msg = data?.error?.message || data?.error_description || data?.error?.code || data?.message
      || (typeof data?.error === 'string' ? data.error : '') || text.slice(0, 200);
    throw new Error(`${label} failed (${res.status}): ${msg}`);
  }
  return { data, res };
}

export const form = (obj) => new URLSearchParams(Object.entries(obj).filter(([, v]) => v != null).map(([k, v]) => [k, String(v)]));
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Post text shared by all platforms: title + hashtags.
export function captionFor(clip, max = 2200) {
  const tags = (clip.hashtags || []).join(' ');
  return `${clip.title}\n\n${tags}`.slice(0, max);
}
