// Pre-paint theme, density and language (04-ui.md section 9, ADR 0036, ADR 0039, ADR 0072). Classic blocking script, external so
// the CSP needs no inline allowance. Reads the new key first and the legacy key as a fallback; any failure keeps the defaults of
// index.html. The language part repeats detectLocale of src/i18n/locale.ts (this script cannot import it); the locale test runs
// both against the same inputs.
(function () {
  var root = globalThis.document.documentElement;
  var THEMES = ['auto', 'light', 'dark'];
  var DENSITIES = ['comfortable', 'compact'];
  var LOCALES = ['en', 'vi'];

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

  // The first browser language whose primary subtag is supported; null when the browser lists none at all.
  function detectLanguage() {
    try {
      var languages = globalThis.navigator.languages;
      if (!Array.isArray(languages)) return null;
      for (var tag of languages) {
        if (typeof tag !== 'string') continue;
        var primary = tag.trim().toLowerCase().split(/[-_]/)[0].trim();
        if (LOCALES.indexOf(primary) !== -1) return primary;
      }
      return 'en';
    } catch {
      return null;
    }
  }

  var prefs = read('mcs.ui.v3') || read('ccm.prefs.v1');
  if (prefs !== null) {
    if (THEMES.indexOf(prefs.theme) !== -1) root.setAttribute('data-theme', prefs.theme);
    if (DENSITIES.indexOf(prefs.density) !== -1) root.setAttribute('data-density', prefs.density);
  }
  // `lang` is read by screen readers to pick a voice, so it is set before the first paint: the stored choice, else the browser.
  var language = prefs !== null && LOCALES.indexOf(prefs.locale) !== -1 ? prefs.locale : detectLanguage();
  if (language !== null) root.setAttribute('lang', language);
})();
