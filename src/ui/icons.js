// Ícones de linha (24×24, traço) usados na interface.
export const TOOL_ICONS = {
  select: 'M5 3l13 8-6 1.5L9 19z',
  corridor: 'M3 20c3-8 6-12 9-12s4 4 9-4 M5 21c3-8 6-11 8-11s3 3 8-4',
  wall: 'M3 7h18v10H3z M3 12h18 M9 7v5 M15 12v5',
  area: 'M4 5h16v14H4z M4 5l3 3h10l3-3 M7 8v8 M17 8v8',
  connector: 'M4 20h4v-4h4v-4h4V8h4',
  asset: 'M12 3l8 4.5v9L12 21l-8-4.5v-9z M12 12l8-4.5 M12 12v9 M12 12L4 7.5',
  agent: 'M12 3a3 3 0 1 0 0.01 0z M7 21v-6a5 5 0 0 1 10 0v6',
  item: 'M8.5 5a3.5 3.5 0 1 0 .01 0z M11 10.5l8 8 M16 15.5l2-2 M18 17.5l2-2',
  zone: 'M4 8V4h4 M16 4h4v4 M20 16v4h-4 M8 20H4v-4 M10 12l2-2 2 2-2 2z',
  light: 'M9 18h6 M10 21h4 M12 3a6 6 0 0 0-3.5 10.9c.6.5 1 1.2 1 2.1h5c0-.9.4-1.6 1-2.1A6 6 0 0 0 12 3z',
};

export const UI_ICONS = {
  eye: 'M2 12s3.6-6 10-6 10 6 10 6-3.6 6-10 6S2 12 2 12z M12 9.4a2.6 2.6 0 1 0 .01 0z',
  eyeOff: 'M3 3l18 18 M10.6 6.1A10.8 10.8 0 0 1 12 6c6.4 0 10 6 10 6a17 17 0 0 1-3.1 3.6 M6.6 6.6C3.7 8.3 2 12 2 12s3.6 6 10 6a9.6 9.6 0 0 0 4.4-1',
  close: 'M6 6l12 12M18 6L6 18',
  trash: 'M4 7h16 M9 7V4h6v3 M6 7l1 13h10l1-13 M10 11v6 M14 11v6',
  copy: 'M8 8h12v12H8z M16 8V4H4v12h4',
  focus: 'M4 9V4h5 M15 4h5v5 M20 15v5h-5 M9 20H4v-5 M12 10a2 2 0 1 0 .01 0z',
  chevron: 'M9 6l6 6-6 6',
  swap: 'M7 7h13 M16 3l4 4-4 4 M17 17H4 M8 13l-4 4 4 4',
  reset: 'M4 12a8 8 0 1 0 2.3-5.6 M4 4v4h4',
  link: 'M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1 M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1',
  play: 'M8 5v14l11-7z',
  dice: 'M5 5h14v14H5z M9 9h.01 M15 15h.01 M15 9h.01 M9 15h.01',
  upload: 'M12 16V4 M7 9l5-5 5 5 M5 20h14',
  logic: 'M4 5h6v5H4z M14 14h6v5h-6z M7 10v4a2 2 0 0 0 2 2h5 M17 14V9a2 2 0 0 0-2-2h-5',
  plus: 'M12 5v14 M5 12h14',
  bolt: 'M13 3L5 14h6l-1 7 8-11h-6z',
  code: 'M8 7l-5 5 5 5 M16 7l5 5-5 5 M14 4l-4 16',
  flag: 'M5 21V4 M5 4h11l-2 4 2 4H5',
};

/** SVG inline de um caminho de ícone. */
export function svgIcon(d, cls = '') {
  return `<svg viewBox="0 0 24 24"${cls ? ` class="${cls}"` : ''} aria-hidden="true"><path d="${d}"/></svg>`;
}
