/*
 * Self-learning list page: homework-parity toolbar behavior.
 *
 * Same trio as homework_main.page.js — auto-submit the filter form when a
 * select changes, mount the shared Calendar component from UiContext.docs
 * (the handler ships events in homework's exact shape, extension mask
 * included), and remember the chosen view per browser. Only the storage key,
 * the select name and the list container differ.
 */
import $ from 'jquery';
import { NamedPage } from 'vj/misc/Page';
import { i18n, mongoId } from 'vj/utils';

const page = new NamedPage('self_learning', async () => {
  $('[name="filter-form"] select').on('change', () => {
    $('[name="filter-form"]').trigger('submit');
  });
  const { default: Calendar } = await import('vj/components/calendar');
  if (UiContext.docs) {
    const events = UiContext.docs.map((doc) => ({
      beginAt: doc.beginAt,
      endAt: doc.endAt,
      title: doc.title,
      maskFrom: doc.penaltySince ? doc.penaltySince : null,
      maskTitle: i18n('Time Extension'),
      colorIndex: mongoId(doc._id).timestamp % 12,
      link: doc.url,
    }));
    const calendar = new Calendar(events);
    calendar.getDom().appendTo('[name="calendar_entry"]');
    const preference = localStorage.getItem('sl-view') || 'list';
    if (preference === 'calendar') {
      $('.sll-grid').hide();
      $('[name="sl_display"]').val('calendar');
    } else {
      $('[name="calendar_entry"]').hide();
      $('[name="sl_display"]').val('list');
    }
    $('[name="sl_display"]').change((ev) => {
      switch (ev.currentTarget.value) {
        case 'calendar':
          $('.sll-grid').hide();
          $('[name="calendar_entry"]').show();
          localStorage.setItem('sl-view', 'calendar');
          break;
        case 'list':
          $('.sll-grid').show();
          $('[name="calendar_entry"]').hide();
          localStorage.setItem('sl-view', 'list');
          break;
        default:
          throw new Error('Unexpected display parameter');
      }
    });
  }
});

export default page;
