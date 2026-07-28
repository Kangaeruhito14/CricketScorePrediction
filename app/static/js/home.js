/* home.js — fills the home page from /api/report and runs one live worked
   example through /api/predict. Nothing on this page is written by hand:
   if the model is retrained, the page changes with it. */
(function () {
  'use strict';

  /* The inputs below are an illustration; the projection they produce is not.
     It is a real call to the same endpoint the prediction page uses, so the
     hero shows the model working rather than a picture of it working. */
  const EXAMPLE = {
    family: 't20',
    event: 'Indian Premier League',
    batting_team: 'Chennai Super Kings',
    bowling_team: 'Mumbai Indians',
    venue: 'Wankhede Stadium',
    innings: 1,
    overs_completed: 11,
    balls_this_over: 4,
    current_score: 96,
    wickets: 2,
    fours: 8,
    sixes: 3,
    target: 0
  };

  function pctBetween(value, min, max) {
    if (max <= min) return 50;
    return Math.max(0, Math.min(100, ((value - min) / (max - min)) * 100));
  }

  async function loadReport() {
    const rep = await api.report();
    const d = rep.dataset || {};

    /* Deliberately not one headline error figure. Error scales with how many
       runs a format produces, so a single blended number would flatter T20 and
       libel the multi-day model at the same time. */
    const rows = (rep.format_table || []).slice()
      .sort(function (a, b) { return a.MAE - b.MAE; });

    const tbody = document.querySelector('[data-format-rows]');
    if (tbody) {
      tbody.replaceChildren();
      rows.forEach(function (r) {
        tbody.appendChild(tableRow([
          fmt.family(r.group),
          { text: fmt.int(r.n), cls: 'n' },
          { text: fmt.dec(r.MAE, 1), cls: 'n' },
          { text: fmt.dec(r.R2, 3), cls: 'n' }
        ]));
      });
    }

    const t20 = rows.find(function (r) { return r.group === 't20'; });
    const iv = rep.intervals || {};

    fillAll(document, {
      matches: fmt.int(d.n_matches),
      deliveries: fmt.big(d.n_deliveries),
      innings: fmt.int(d.n_innings),
      formats: String((rep.format_table || []).length),
      coverage: fmt.pct(iv.conformal),
      nominal: fmt.pct(iv.nominal),
      't20-mae': t20 ? fmt.dec(t20.MAE, 1) : '—',
      'date-range': fmt.date(d.date_min) + ' to ' + fmt.date(d.date_max),
      'test-start': fmt.date(d.split && d.split.test && d.split.test.start)
    });
    return rep;
  }

  async function loadExample() {
    const panel = document.querySelector('[data-example]');
    if (!panel) return;
    const p = await api.predict(EXAMPLE);

    /* Scale the rail across the plausible finishes for this state: it cannot
       end below what is already scored, and the upper end is the top of the
       band with a little air so the marker is never flush to the edge. */
    const min = EXAMPLE.current_score;
    const max = Math.max(p.high, p.projected_at_crr) + 12;

    const rail = panel.querySelector('.rail');
    rail.style.setProperty('--lo', pctBetween(p.low, min, max) + '%');
    rail.style.setProperty('--hi', pctBetween(p.high, min, max) + '%');
    rail.style.setProperty('--point', pctBetween(p.predicted, min, max) + '%');
    rail.style.setProperty('--naive', pctBetween(p.projected_at_crr, min, max) + '%');

    fillAll(panel, {
      /* The caption is written from EXAMPLE rather than typed into the page,
         so editing the example state cannot leave the page describing a match
         that did not produce the number beside it. */
      'ex-teams': EXAMPLE.batting_team + ' v ' + EXAMPLE.bowling_team,
      'ex-state': EXAMPLE.current_score + '/' + EXAMPLE.wickets,
      'ex-overs': 'after ' + p.overs_display + ' overs',
      'ex-where': EXAMPLE.venue + ' · ' + EXAMPLE.event,
      'ex-score': String(p.predicted),
      'ex-low': String(p.low),
      'ex-high': String(p.high),
      'ex-naive': String(p.projected_at_crr),
      'ex-min': String(min),
      'ex-max': String(Math.round(max)),
      'ex-crr': fmt.dec(p.crr, 2),
      'ex-par': String(p.venue_par),
      'ex-balls': String(p.balls_left)
    });
    panel.hidden = false;
  }

  Promise.all([
    loadReport().catch(function (e) { showFailure(document, e); }),
    loadExample().catch(function () {
      /* The example is illustrative. If it cannot be produced, say so plainly
         rather than leaving an empty frame or inventing a number. */
      const panel = document.querySelector('[data-example]');
      const fallback = document.querySelector('[data-example-failed]');
      if (panel) panel.remove();
      if (fallback) fallback.hidden = false;
    })
  ]);
})();
