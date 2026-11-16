// Manual posting helpers (fallback when an account isn't linked).
// Linked-account publishing is done by the server — see server/publisher.js.

export function postText(clip) {
  return `${clip.title}\n\n${clip.hashtags.join(' ')}`;
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
