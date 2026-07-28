/* about.js — the scale and date figures on the methodology page come from
   /api/report, so the prose never drifts from the data behind it. */
(function () {
  'use strict';

  api.report().then(function (rep) {
    const d = rep.dataset || {};
    const sp = d.split || {};
    const tr = sp.train || {};
    const va = sp.valid || {};
    const te = sp.test || {};

    fillAll(document, {
      matches: fmt.int(d.n_matches),
      innings: fmt.int(d.n_innings),
      deliveries: fmt.big(d.n_deliveries),
      'deliveries-exact': fmt.int(d.n_deliveries),
      'model-rows': fmt.big(d.n_model_rows),
      venues: fmt.int(d.n_venues),
      events: fmt.int(d.n_events),
      'date-min': fmt.date(d.date_min),
      'date-max': fmt.date(d.date_max),

      'train-n': fmt.int(tr.n_matches),
      'train-start': fmt.date(tr.start),
      'train-end': fmt.date(tr.end),
      'valid-n': fmt.int(va.n_matches),
      'valid-start': fmt.date(va.start),
      'valid-end': fmt.date(va.end),
      'test-n': fmt.int(te.n_matches),
      'test-start': fmt.date(te.start),
      'test-end': fmt.date(te.end)
    });

    /* The gap between every delivery in the archive and the rows the model
       actually trains on is the honest version of "we cleaned the data", so
       it is stated rather than glossed over. */
    const dropped = d.n_deliveries && d.n_model_rows
      ? d.n_deliveries - d.n_model_rows : null;
    fillAll(document, {
      'rows-dropped': dropped === null ? '—' : fmt.big(dropped),
      'rows-kept-pct': dropped === null ? '—'
        : fmt.pct(d.n_model_rows / d.n_deliveries)
    });
  }).catch(function (e) {
    showFailure(document, e);
  });
})();
