import { AutoloadPage } from 'vj/misc/Page';
import { getTheme } from 'vj/utils';

/**
 * Theme unifier for the PTA UI components.
 *
 * All custom components (problem rail, result modal, AI tutor cards, AI
 * Studio, class report, subjective tasks, bulk import, ...) scope their
 * dark styles under `.pta-dark` on <html>. Historically each page module
 * added that class itself via getTheme(), which left script-less pages
 * (e.g. the session templates) and any page whose module bails out early
 * without the tag — so `.pta-dark` rules silently never applied there.
 *
 * This autoload makes the tag universal and authoritative: the
 * server-rendered `theme--dark` class (layout/html5.html renders
 * `theme--{{ user.theme }}` on every page) is mirrored into `pta-dark`
 * before any named page runs. The per-page calls remain as harmless
 * no-ops, so nothing depends on module load order anymore.
 */
export default new AutoloadPage('ptaThemeSyncPage', () => {
  const root = document.documentElement;
  if (root.classList.contains('theme--dark') || getTheme() === 'dark') {
    root.classList.add('pta-dark');
  } else {
    // A stale tag (e.g. bfcache restore after the user switched back to
    // light) would leave dark component chrome on a light page.
    root.classList.remove('pta-dark');
  }
});
