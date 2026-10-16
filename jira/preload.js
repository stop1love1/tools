const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electron', {
  version: process.versions.electron,
  // Start at login in the background (electron-main.js, setAutoStart).
  autoStart: {
    get: () => ipcRenderer.invoke('autostart:get'),
    set: (on) => ipcRenderer.invoke('autostart:set', on),
  },
});

// Linux: the window buttons sit over the right end of the top bar (titleBarOverlay in electron-main.js).
// Mark the page so its CSS makes the bar draggable and leaves room for the buttons, and keep the overlay's
// colours and height matching the bar as the theme changes or the bar wraps.
if (process.platform === 'linux') {
  window.addEventListener('DOMContentLoaded', () => {
    const root = document.documentElement;
    root.classList.add('electron-wco');
    const bar = document.querySelector('.topbar');
    if (!bar) return;

    let last = '';
    const sync = () => {
      const css = getComputedStyle(root);
      const color = css.getPropertyValue('--surface').trim();
      const symbolColor = css.getPropertyValue('--text').trim();
      const height = bar.getBoundingClientRect().height;
      const key = `${color}|${symbolColor}|${height}`;
      if (!color || !symbolColor || key === last) return;
      last = key;
      ipcRenderer.send('titlebar-overlay', { color, symbolColor, height });
    };

    sync();
    new MutationObserver(sync).observe(root, { attributes: true, attributeFilter: ['class'] });
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', sync);
    new ResizeObserver(sync).observe(bar);
  });
}
