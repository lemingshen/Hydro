import $ from 'jquery';
import ProblemSelectAutoComplete from 'vj/components/autocomplete/ProblemSelectAutoComplete';
import { ConfirmDialog } from 'vj/components/dialog';
import { NamedPage } from 'vj/misc/Page';
import { i18n, request, tpl } from 'vj/utils';

export default new NamedPage(['self_learning_create', 'self_learning_edit'], () => {
  ProblemSelectAutoComplete.getOrConstruct($('[name="pids"]'), { multi: true, clearDefaultValue: false });
  $(document).on('click', '[value="delete"]', (ev) => {
    ev.preventDefault();
    new ConfirmDialog({
      $body: tpl.typoMsg(i18n('Confirm deleting this self-learning session? Tutoring conversations will be deleted as well.')),
    }).open().then((action) => {
      if (action !== 'yes') return;
      request.post('', { operation: 'delete' }).then((res) => {
        window.location.href = res.url;
      });
    });
  });
});
