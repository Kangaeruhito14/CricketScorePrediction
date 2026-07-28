/* results.js — renders the whole evaluation report from /api/report.

   Nothing on this page is written into the markup. If the model is retrained,
   every table, bar and boundary here changes with it. */
(function () {
  'use strict';

  /* Feature names as the model knows them, and as a reader would say them.
     These are labels, not figures - every number still comes from the API. */
  const FEATURE_LABEL = {
    batteam_par: 'Batting side’s scoring history',
    bowlteam_par: 'Bowling side’s concession history',
    venue_par: 'Ground’s par score',
    venue_n: 'Innings recorded at this ground',
    current_score: 'Runs so far',
    balls_bowled: 'Balls bowled',
    balls_left: 'Balls remaining',
    total_balls_f: 'Innings length',
    progress: 'How far through the innings',
    wickets_left: 'Wickets in hand',
    crr: 'Current run rate',
    last30_runs: 'Runs in the last 30 balls',
    last30_wkts: 'Wickets in the last 30 balls',
    fours: 'Fours so far',
    sixes: 'Sixes so far',
    dot_pct: 'Share of dot balls',
    boundary_pct: 'Share of boundaries',
    resource: 'Wickets in hand × balls left',
    is_chase: 'Chasing a target',
    target_runs: 'Target',
    runs_needed: 'Runs still needed',
    bat_won_toss: 'Batting side won the toss',
    bat_sr: 'Batter’s career strike rate',
    bat_balls: 'Balls the batter has faced',
    bowl_econ: 'Bowler’s career economy',
    bowl_sr: 'Bowler’s career strike rate',
    bowl_balls: 'Balls the bowler has sent down',
    match_type: 'Match type',
    family: 'Format family',
    batting_team: 'Batting team',
    bowling_team: 'Bowling team',
    venue: 'Ground',
    event: 'Competition',
    gender: 'Gender',
    innings: 'Innings number',
    year: 'Year'
  };

  const PHASE_ORDER = ['first quarter', 'second quarter', 'third quarter',
                       'final quarter', 'no ball limit'];

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  }

  /* ---------------------------------------------------------- leakage */
  function renderLeakage(rep) {
    const wrap = document.querySelector('[data-splits]');
    wrap.replaceChildren();

    const NOTES = {
      random: 'Every ball of one innings carries the same answer, so this split '
        + 'puts ball 12.3 in training and ball 12.4 in testing. The model recalls '
        + 'rather than predicts.',
      group: 'Whole matches are held out, so no innings is split in two. Honest '
        + 'about innings, but it still lets the model train on matches played '
        + 'after the ones it is tested on.',
      temporal: 'Trained on the earliest matches, tested only on later ones — the '
        + 'same position anyone is in using it on a live game. This is the number '
        + 'to quote.'
    };

    rep.leakage.forEach(function (row) {
      const card = el('div', 'split '
        + (row.honest ? 'split--honest' : 'split--flattering')
        + (row.split === 'temporal' ? ' split--headline' : ''));

      const badge = el('span', 'badge ' + (row.honest ? 'badge--predict' : 'badge--warn'),
        row.honest ? (row.split === 'temporal' ? 'The honest number' : 'Honest') : 'Misleading');
      card.appendChild(badge);
      card.appendChild(el('span', 'split__label', row.label));

      const mae = el('span', 'split__mae', fmt.dec(row.mae, 2));
      card.appendChild(mae);
      card.appendChild(el('span', 'split__unit', 'runs of average error'));
      card.appendChild(el('span', 'split__r2',
        row.r2 === null ? 'R² not recorded for this split' : 'R² ' + fmt.dec(row.r2, 3)));
      card.appendChild(el('span', 'split__note', NOTES[row.split] || ''));
      wrap.appendChild(card);
    });

    /* The size of the self-deception, stated rather than left as an exercise. */
    const random = rep.leakage.find(function (r) { return r.split === 'random'; });
    const temporal = rep.leakage.find(function (r) { return r.split === 'temporal'; });
    if (random && temporal) {
      fillAll(document, {
        'leak-gap': fmt.dec(temporal.mae - random.mae, 2),
        'leak-pct': fmt.pct(1 - random.mae / temporal.mae, 0),
        'leak-random': fmt.dec(random.mae, 2),
        'leak-temporal': fmt.dec(temporal.mae, 2)
      });
    }
  }

  /* ------------------------------------------------------ format table */
  function renderFormats(rep) {
    const rows = rep.format_table.slice().sort(function (a, b) { return a.MAE - b.MAE; });
    const maxMae = Math.max.apply(null, rows.map(function (r) { return r.MAE; }));
    const tbody = document.querySelector('[data-format-rows]');
    tbody.replaceChildren();

    rows.forEach(function (r) {
      const tr = tableRow([
        fmt.family(r.group),
        { text: fmt.int(r.n), cls: 'n' },
        '',                                  // filled with a bar below
        { text: fmt.dec(r.RMSE, 2), cls: 'n' },
        { text: fmt.dec(r.R2, 3), cls: 'n' }
      ]);
      tr.children[2].className = 'n';
      tr.children[2].appendChild(barCell(r.MAE, maxMae, 2));
      tbody.appendChild(tr);
    });

    fillAll(document, { 'n-formats': String(rows.length) });
  }

  function barCell(value, max, places) {
    const box = el('span', 'bar-cell');
    box.appendChild(el('span', 'bar-cell__value', fmt.dec(value, places)));
    const track = el('span', 'bar-cell__track');
    const fill = el('span', 'bar-cell__fill');
    fill.style.setProperty('--w', (max ? (value / max) * 100 : 0).toFixed(1) + '%');
    track.appendChild(fill);
    box.appendChild(track);
    return box;
  }

  /* ------------------------------------------------------- phase table */
  function renderPhases(rep) {
    // "t20 | final quarter" -> {family, phase}
    const parsed = rep.phase_table.map(function (r) {
      const bits = String(r.group).split('|');
      return {
        family: bits[0].trim(),
        phase: (bits[1] || '').trim(),
        n: r.n, MAE: r.MAE, RMSE: r.RMSE, R2: r.R2
      };
    });

    const families = [];
    parsed.forEach(function (r) {
      if (families.indexOf(r.family) < 0) families.push(r.family);
    });
    // Shortest innings first, so the table reads in order of scale.
    const famOrder = ['t20', 'odi', 'multiday'];
    families.sort(function (a, b) {
      return (famOrder.indexOf(a) + 1 || 99) - (famOrder.indexOf(b) + 1 || 99);
    });

    const tbody = document.querySelector('[data-phase-rows]');
    tbody.replaceChildren();

    families.forEach(function (fam) {
      const group = parsed.filter(function (r) { return r.family === fam; })
        .sort(function (a, b) {
          return PHASE_ORDER.indexOf(a.phase) - PHASE_ORDER.indexOf(b.phase);
        });
      /* Bars are scaled inside each format, never across them. A shared scale
         would invite precisely the comparison the note warns against. */
      const maxMae = Math.max.apply(null, group.map(function (r) { return r.MAE; }));

      const head = document.createElement('tr');
      head.className = 'group-row';
      const th = document.createElement('th');
      th.setAttribute('colspan', '5');
      th.setAttribute('scope', 'colgroup');
      th.textContent = fmt.family(fam);
      head.appendChild(th);
      tbody.appendChild(head);

      group.forEach(function (r) {
        const tr = tableRow([
          r.phase.charAt(0).toUpperCase() + r.phase.slice(1),
          { text: fmt.int(r.n), cls: 'n' },
          '',
          { text: fmt.dec(r.RMSE, 2), cls: 'n' },
          { text: fmt.dec(r.R2, 3), cls: 'n' }
        ]);
        tr.children[2].className = 'n';
        tr.children[2].appendChild(barCell(r.MAE, maxMae, 2));
        tbody.appendChild(tr);
      });
    });
  }

  /* -------------------------------------------------------- intervals */
  function renderCoverage(rep) {
    const iv = rep.intervals;
    const wrap = document.querySelector('[data-coverage]');
    wrap.replaceChildren();

    const rows = [
      { name: 'Raw quantile models', value: iv.quantile,
        note: 'Two extra models trained to predict the 10th and 90th percentile '
          + 'directly. On their own they come out far too narrow.' },
      { name: 'After conformal correction', value: iv.conformal,
        note: 'The model’s own errors on held-out validation matches, measured '
          + 'per format and per quarter of the innings, set the width instead.' }
    ];

    rows.forEach(function (r) {
      if (r.value === null || r.value === undefined) return;
      const short = r.value < iv.nominal - 0.03;
      const row = el('div', 'coverage__row ' + (short ? 'coverage--short' : 'coverage--good'));

      const head = el('div', 'coverage__head');
      head.appendChild(el('span', 'coverage__name', r.name));
      head.appendChild(el('span', 'coverage__pct', fmt.pct(r.value, 1)));
      row.appendChild(head);

      const track = el('div', 'coverage__track');
      const fill = el('div', 'coverage__fill');
      fill.style.setProperty('--w', (r.value * 100).toFixed(1) + '%');
      const target = el('div', 'coverage__target');
      target.style.setProperty('--target', (iv.nominal * 100).toFixed(1) + '%');
      track.append(fill, target);
      row.appendChild(track);

      row.appendChild(el('p', 'coverage__note', r.note));
      wrap.appendChild(row);
    });

    fillAll(document, {
      nominal: fmt.pct(iv.nominal, 0),
      'cov-quantile': fmt.pct(iv.quantile, 1),
      'cov-conformal': fmt.pct(iv.conformal, 1),
      'cov-shortfall': fmt.pct(iv.nominal - iv.conformal, 1)
    });
  }

  /* ------------------------------------------------------- importance */
  function renderImportance(rep) {
    const list = document.querySelector('[data-importance]');
    list.replaceChildren();
    const rows = rep.feature_importance;
    if (!rows.length) return;
    const top = rows[0].share;

    rows.forEach(function (r) {
      const row = el('div', 'importance__row');
      /* The container declares role="list", so each row has to declare
         itself an item. Without this it is a list containing nothing, which
         is worse for a screen reader than no role at all. */
      row.setAttribute('role', 'listitem');

      const name = el('div', 'importance__name');
      name.appendChild(document.createTextNode(FEATURE_LABEL[r.feature] || r.feature));
      const code = el('code', null, r.feature);
      name.appendChild(code);
      row.appendChild(name);

      const bar = el('div', 'importance__bar');
      const fill = el('span', 'importance__fill');
      // Relative to the strongest feature, so the shape of the ranking reads.
      fill.style.setProperty('--w', ((r.share / top) * 100).toFixed(1) + '%');
      bar.appendChild(fill);
      row.appendChild(bar);

      row.appendChild(el('div', 'importance__pct', fmt.pct(r.share, 1)));
      list.appendChild(row);
    });

    fillAll(document, {
      'imp-count': String(rows.length),
      'imp-top': FEATURE_LABEL[rows[0].feature] || rows[0].feature,
      'imp-top-pct': fmt.pct(rows[0].share, 1),
      'imp-top3': fmt.pct(rows.slice(0, 3).reduce(function (a, r) { return a + r.share; }, 0), 0)
    });
  }

  /* ---------------------------------------------------------- dataset */
  function renderDataset(rep) {
    const d = rep.dataset || {};
    const sp = d.split || {};

    fillAll(document, {
      matches: fmt.int(d.n_matches),
      innings: fmt.int(d.n_innings),
      deliveries: fmt.big(d.n_deliveries),
      'model-rows': fmt.big(d.n_model_rows),
      venues: fmt.int(d.n_venues),
      events: fmt.int(d.n_events),
      'date-min': fmt.date(d.date_min),
      'date-max': fmt.date(d.date_max),
      'train-n': fmt.int(sp.train && sp.train.n_matches),
      'valid-n': fmt.int(sp.valid && sp.valid.n_matches),
      'test-n': fmt.int(sp.test && sp.test.n_matches),
      'train-start': fmt.date(sp.train && sp.train.start),
      'train-end': fmt.date(sp.train && sp.train.end),
      'valid-start': fmt.date(sp.valid && sp.valid.start),
      'valid-end': fmt.date(sp.valid && sp.valid.end),
      'test-start': fmt.date(sp.test && sp.test.start),
      'test-end': fmt.date(sp.test && sp.test.end)
    });

    // Boundaries drawn to scale on the corpus's own date range.
    const t0 = Date.parse(d.date_min), t1 = Date.parse(d.date_max);
    const wrap = document.querySelector('[data-timeline]');
    if (!wrap || !t0 || !t1 || t1 <= t0) return;
    wrap.replaceChildren();

    [['train', 'Train'], ['valid', 'Validation'], ['test', 'Test']].forEach(function (pair) {
      const part = sp[pair[0]];
      if (!part) return;
      const row = el('div', 'timeline__row' + (pair[0] === 'test' ? ' timeline__row--test' : ''));
      const name = el('span', 'timeline__name');
      name.appendChild(el('span', null, pair[1]));
      name.appendChild(el('span', 'timeline__count', fmt.int(part.n_matches) + ' matches'));
      row.appendChild(name);

      const bar = el('div', 'timeline__bar');
      const span = el('div', 'timeline__span');
      const from = (Date.parse(part.start) - t0) / (t1 - t0) * 100;
      const to = (Date.parse(part.end) - t0) / (t1 - t0) * 100;
      span.style.setProperty('--from', from.toFixed(2) + '%');
      span.style.setProperty('--span', Math.max(to - from, 2).toFixed(2) + '%');
      // The bar is decoration over a table that already states the dates, so
      // it is labelled for a screen reader rather than left as a bare div.
      span.setAttribute('role', 'img');
      span.setAttribute('aria-label', pair[1] + ': ' + fmt.int(part.n_matches)
        + ' matches, ' + fmt.date(part.start) + ' to ' + fmt.date(part.end));
      span.title = fmt.date(part.start) + ' to ' + fmt.date(part.end);
      bar.appendChild(span);
      row.appendChild(bar);
      wrap.appendChild(row);
    });

    const dates = el('div', 'timeline__dates');
    dates.appendChild(el('span', null, fmt.date(d.date_min)));
    dates.appendChild(el('span', null, fmt.date(d.date_max)));
    wrap.appendChild(dates);
  }

  /* ------------------------------------------------------------- boot */
  api.report().then(function (rep) {
    renderLeakage(rep);
    renderFormats(rep);
    renderPhases(rep);
    renderCoverage(rep);
    renderImportance(rep);
    renderDataset(rep);

    fillAll(document, {
      'test-mae': fmt.dec(rep.headline.test_mae, 2),
      'test-r2': fmt.dec(rep.headline.test_r2, 3)
    });

    /* ONLY_FAMILY in the training script restricts the model to one format.
       If a build were ever produced that way, every table on this page would
       describe something narrower than the page claims. */
    if (rep.only_family) {
      const w = document.querySelector('[data-only-family]');
      w.textContent = 'This build was trained on ' + fmt.family(rep.only_family)
        + ' alone, so the figures below cover that format only.';
      w.hidden = false;
    }
  }).catch(function (e) {
    showFailure(document, e);
  });
})();
