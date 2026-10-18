// Pre-paint theme and density (04-ui.md section 9, ADR 0036, ADR 0039). Classic blocking script, external so the CSP needs
// no inline allowance. Reads the new key first and the legacy key as a fallback; any failure keeps the defaults of index.html.
(function () {
  var root = globalThis.document.documentElement;
  var THEMES = ['auto', 'light', 'dark'];
  var DENSITIES = ['comfortable', 'compact'];

  function read(key) {
    try {
      var raw = globalThis.localStorage.getItem(key);
      if (raw === null) return null;
      var data = JSON.parse(raw);
      return data !== null && typeof data === 'object' ? data : null;
    } catch {
      return null;
    }
  }

  var prefs = read('mcs.ui.v3') || read('ccm.prefs.v1');
  if (prefs === null) return;
  if (THEMES.indexOf(prefs.theme) !== -1) root.setAttribute('data-theme', prefs.theme);
  if (DENSITIES.indexOf(prefs.density) !== -1) root.setAttribute('data-density', prefs.density);
})();
