/* Applies the saved theme before the app paints (PRD-007 §11), so a light-theme
   user never sees a dark flash. Same logic as src/lib/theme.ts. External file:
   the CSP allows no inline scripts. */
(function () {
  var pref = 'dark';
  try { pref = localStorage.getItem('bl:theme') || 'dark'; } catch (e) {}
  var light = pref === 'light' || (pref === 'system' && window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches);
  document.documentElement.setAttribute('data-theme', light ? 'light' : 'dark');
})();
