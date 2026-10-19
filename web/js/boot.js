// Runs before first paint so the page never flashes the wrong look.
(function () {
  var get = function (k) { try { return JSON.parse(localStorage.getItem('sshcode.' + k)); } catch (e) { return null; } };
  var s = get('settings') || {};
  var pref = s.appearance || get('theme') || 'system';
  var dark = pref === 'dark' || (pref !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches);
  var root = document.documentElement, d = root.dataset;
  d.theme = dark ? 'dark' : 'light';
  d.accent = s.accent || 'blue';
  d.wall = s.wallpaper || 'aurora';
  d.layout = s.layout || 'floating';
  d.motion = s.motion === false ? 'off' : 'on';
  d.glass = s.sidebarGlass === false ? 'off' : 'on';
  d.density = s['files.density'] || 'regular';
  d.icons = s['files.colorIcons'] === false ? 'mono' : 'color';
  var pane = (get('pane') || {})[d.theme];
  if (pane) {
    root.style.setProperty('--pane', pane.bg);
    d.pane = pane.scheme;
  } else {
    d.pane = d.theme;
  }
})();
