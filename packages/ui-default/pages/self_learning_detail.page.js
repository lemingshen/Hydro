import $ from 'jquery';
import { NamedPage } from 'vj/misc/Page';
import { i18n } from 'vj/utils';

/**
 * PTA fork: the session page's score board (teacher view) can be expanded
 * to a full-screen overlay so a wide class × task table is comfortable to
 * read; the board itself already scrolls both ways with a sticky header.
 *
 * While expanded, the section is MOVED to <body>: a fixed-position element
 * stays trapped inside any ancestor that has a transform, filter or
 * stacking context (theme animations do), which is how an overlay can end
 * up beneath its own backdrop. A placeholder marks where to put it back.
 * Esc, the button, or the backdrop close it.
 */
export default new NamedPage('self_learning_detail', () => {
  const $section = $('.sld-results');
  const $btn = $section.find('.sld-results__expand');
  if (!$section.length || !$btn.length) return;
  let $backdrop = null;
  let $placeholder = null;
  const setExpanded = (on) => {
    if (on === $section.hasClass('sld-results--full')) return;
    if (on) {
      $placeholder = $('<div class="sld-results__placeholder" hidden></div>');
      $section.before($placeholder);
      $backdrop = $('<div class="sld-results__backdrop"></div>').appendTo(document.body).on('click', () => setExpanded(false));
      $section.appendTo(document.body).addClass('sld-results--full');
      $('body').css('overflow', 'hidden');
    } else {
      $section.removeClass('sld-results--full');
      if ($placeholder) {
        $placeholder.replaceWith($section);
        $placeholder = null;
      }
      if ($backdrop) $backdrop.remove();
      $backdrop = null;
      $('body').css('overflow', '');
    }
    $btn.find('span').text(on ? i18n('Close') : i18n('Expand'));
    $btn.attr('title', on ? i18n('Back to the normal view') : i18n('Expand the score board'));
    $btn.contents().first().replaceWith(document.createTextNode(on ? '✕ ' : '⛶ '));
  };
  $btn.on('click', () => setExpanded(!$section.hasClass('sld-results--full')));
  $(document).on('keydown', (ev) => {
    if (ev.key === 'Escape' && $section.hasClass('sld-results--full')) setExpanded(false);
  });
});
