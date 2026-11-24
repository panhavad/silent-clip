// Inline SVG icon set (stroke icons, 24x24) used instead of emoji across the UI.
const S = (d) => d.map((x) => (x.startsWith('<') ? x : `<path d="${x}"/>`)).join('');

const PATHS = {
  scissors: S(['<circle cx="6" cy="6" r="3"/>', '<circle cx="6" cy="18" r="3"/>', 'M20 4 8.12 15.88', 'M14.47 14.48 20 20', 'M8.12 8.12 12 12']),
  play: S(['M6 4l14 8-14 8z']),
  stop: S(['<rect x="6" y="6" width="12" height="12" rx="1"/>']),
  bell: S(['M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9', 'M10.3 21a1.94 1.94 0 0 0 3.4 0']),
  external: S(['M15 3h6v6', 'M10 14 21 3', 'M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6']),
  window: S(['<rect x="3" y="4" width="18" height="16" rx="2"/>', 'M3 9h18', 'M7 6.5h.01', 'M10 6.5h.01']),
  download: S(['M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4', 'M7 10l5 5 5-5', 'M12 15V3']),
  upload: S(['M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4', 'M17 8l-5-5-5 5', 'M12 3v12']),
  check: S(['M20 6 9 17l-5-5']),
  'check-circle': S(['<circle cx="12" cy="12" r="10"/>', 'm9 12 2 2 4-4']),
  alert: S(['M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z', 'M12 9v4', 'M12 17h.01']),
  x: S(['M18 6 6 18', 'M6 6l12 12']),
  trash: S(['M3 6h18', 'M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6', 'M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2']),
  refresh: S(['M21 12a9 9 0 1 1-3-6.7L21 8', 'M21 3v5h-5']),
  undo: S(['M3 7v6h6', 'M21 17a9 9 0 0 0-15-6.7L3 13']),
  copy: S(['<rect x="9" y="9" width="13" height="13" rx="2"/>', 'M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1']),
  save: S(['M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z', 'M17 21v-8H7v8', 'M7 3v5h8']),
  film: S(['<rect x="2" y="3" width="20" height="18" rx="2"/>', 'M7 3v18', 'M17 3v18', 'M2 8h5', 'M2 16h5', 'M17 8h5', 'M17 16h5', 'M2 12h20']),
  clock: S(['<circle cx="12" cy="12" r="10"/>', 'M12 6v6l4 2']),
  calendar: S(['<rect x="3" y="4" width="18" height="18" rx="2"/>', 'M16 2v4', 'M8 2v4', 'M3 10h18']),
  link: S(['M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7', 'M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7']),
  share: S(['<circle cx="18" cy="5" r="3"/>', '<circle cx="6" cy="12" r="3"/>', '<circle cx="18" cy="19" r="3"/>', 'M8.6 13.5l6.8 4', 'M15.4 6.5l-6.8 4']),
  flame: S(['M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.4-.5-2-1-3-1-2.1-.2-4.1 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.2.4-2.3 1-3.4.3 1.2 1.2 2.4 2.5 2.9z']),
  message: S(['M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z']),
  captions: S(['<rect x="3" y="5" width="18" height="14" rx="2"/>', 'M7 15h4', 'M15 15h2', 'M7 11h2', 'M13 11h4']),
  'file-text': S(['M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z', 'M14 2v6h6', 'M16 13H8', 'M16 17H8']),
  plus: S(['M12 5v14', 'M5 12h14']),
  'chevron-left': S(['m15 18-6-6 6-6']),
  'chevron-right': S(['m9 18 6-6-6-6']),
  users: S(['<circle cx="9" cy="7" r="4"/>', 'M3 21v-2a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v2', 'M16 3.1a4 4 0 0 1 0 7.8', 'M21 21v-2a4 4 0 0 0-3-3.9']),
  'user-plus': S(['<circle cx="9" cy="7" r="4"/>', 'M3 21v-2a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v2', 'M19 8v6', 'M22 11h-6']),
  shield: S(['M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z']),
  server: S(['<rect x="2" y="2" width="20" height="8" rx="2"/>', '<rect x="2" y="14" width="20" height="8" rx="2"/>', 'M6 6h.01', 'M6 18h.01']),
  monitor: S(['<rect x="2" y="3" width="20" height="14" rx="2"/>', 'M8 21h8', 'M12 17v4']),
  key: S(['<circle cx="7.5" cy="15.5" r="5.5"/>', 'm21 2-9.6 9.6', 'm15.5 7.5 3 3L22 7l-3-3']),
  logout: S(['M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4', 'm16 17 5-5-5-5', 'M21 12H9']),
  login: S(['M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4', 'm10 17 5-5-5-5', 'M15 12H3']),
  eye: S(['M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z', '<circle cx="12" cy="12" r="3"/>']),
  image: S(['<rect x="3" y="3" width="18" height="18" rx="2"/>', '<circle cx="9" cy="9" r="2"/>', 'm21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21']),
  ban: S(['<circle cx="12" cy="12" r="10"/>', 'm4.9 4.9 14.2 14.2']),
  database: S(['<ellipse cx="12" cy="5" rx="9" ry="3"/>', 'M3 5v14c0 1.7 4 3 9 3s9-1.3 9-3V5', 'M3 12c0 1.7 4 3 9 3s9-1.3 9-3']),
  pencil: S(['M17 3a2.8 2.8 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5z']),
  record: S(['<circle cx="12" cy="12" r="5" fill="currentColor"/>', '<circle cx="12" cy="12" r="9"/>']),
  loader: S(['M21 12a9 9 0 1 1-6.2-8.6']),
  radio: S(['<circle cx="12" cy="12" r="2"/>', 'M16.2 7.8a6 6 0 0 1 0 8.4', 'M7.8 16.2a6 6 0 0 1 0-8.4', 'M19.1 4.9a10 10 0 0 1 0 14.2', 'M4.9 19.1a10 10 0 0 1 0-14.2']),
  // Brand glyphs (filled, shown on the platform colour)
  search: S(['<circle cx="11" cy="11" r="7"/>', 'm20 20-3.5-3.5']),
  shuffle: S(['M16 3h5v5', 'M4 20 21 3', 'M21 16v5h-5', 'm15 15 6 6', 'M4 4l5 5']),
  grid: S(['<rect x="3" y="3" width="7" height="7" rx="1"/>', '<rect x="14" y="3" width="7" height="7" rx="1"/>', '<rect x="3" y="14" width="7" height="7" rx="1"/>', '<rect x="14" y="14" width="7" height="7" rx="1"/>']),
  youtube: '<path d="M8 5.5v13l11-6.5z" fill="currentColor" stroke="none"/>',
  tiktok: '<path d="M15.5 2.5c.4 2.4 2 4 4.5 4.3v3.4c-1.6 0-3.1-.5-4.4-1.3v6.4a6.2 6.2 0 1 1-6.2-6.2c.3 0 .6 0 .9.1v3.5a2.8 2.8 0 1 0 1.9 2.6V2.5z" fill="currentColor" stroke="none"/>',
  instagram: S(['<rect x="3" y="3" width="18" height="18" rx="5"/>', '<circle cx="12" cy="12" r="4"/>', '<circle cx="17.5" cy="6.5" r="1" fill="currentColor" stroke="none"/>']),
};

export function icon(name, cls = '') {
  return `<svg class="ic ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${PATHS[name] || ''}</svg>`;
}

/** Replace <i data-i="name"></i> placeholders in static HTML. */
export function hydrateIcons(root = document) {
  root.querySelectorAll('i[data-i]').forEach((el) => { el.outerHTML = icon(el.dataset.i, el.className); });
}

export const PLATFORM_ICON = { youtube: 'youtube', tiktok: 'tiktok', instagram: 'instagram' };
