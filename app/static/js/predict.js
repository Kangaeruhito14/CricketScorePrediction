/* predict.js — the prediction page: cascading option lists, inline
   validation, the result, and the saved history. */
(function () {
  'use strict';

  const form = document.getElementById('predict-form');
  if (!form) return;

  const el = function (id) { return document.getElementById(id); };
  const FORMAT_ORDER = ['t20', 'odi', 'multiday'];

  /* Format keys are not words anyone says. The descriptions carry the one
     thing that changes the arithmetic: how long the innings is. */
  const FORMAT_META = {
    t20: 'Twenty over innings',
    odi: 'Fifty over innings',
    multiday: 'Test and first-class — no over limit'
  };

  const state = {
    families: [],
    totalBalls: {},     // family -> balls in an innings, null for multi-day
    venueCity: {},
    lastResult: null
  };

  /* ---------------------------------------------------------------- fields */
  const combos = {};
  function combo(id, key, opts) {
    const root = el(id).closest('.combobox');
    combos[key] = new Combobox(root, opts || {});
    return combos[key];
  }

  const num = {
    overs: el('f-overs'), balls: el('f-balls'), score: el('f-score'),
    wkts: el('f-wkts'), last5: el('f-last5'), fours: el('f-fours'),
    sixes: el('f-sixes'), target: el('f-target'), innings: el('f-innings')
  };

  /* --------------------------------------------------------- error display */
  function fieldOf(name) { return document.querySelector('[data-field="' + name + '"]'); }

  function setError(name, message) {
    const wrap = fieldOf(name);
    if (!wrap) return;
    const box = wrap.querySelector('.field__error');
    const control = wrap.querySelector('.input');
    if (message) {
      wrap.setAttribute('data-invalid', 'true');
      if (box) { box.textContent = message; }
      if (control) {
        control.setAttribute('aria-invalid', 'true');
        if (box && box.id) control.setAttribute('aria-describedby', box.id);
      }
    } else {
      wrap.removeAttribute('data-invalid');
      if (box) box.textContent = '';
      if (control) {
        control.removeAttribute('aria-invalid');
        control.removeAttribute('aria-describedby');
      }
    }
  }

  function clearErrors() {
    Array.prototype.forEach.call(document.querySelectorAll('[data-field]'),
      function (w) { setError(w.dataset.field, ''); });
  }

  /* ------------------------------------------------------------ validation
     Every rule returns a sentence rather than a flag, because the sentence is
     what the user needs. Nothing here silently corrects a value: an over of
     11.7 is rejected, not rounded to something that looks plausible. */
  function intOf(input) {
    const raw = String(input.value).trim();
    if (raw === '') return null;
    if (!/^-?\d+$/.test(raw)) return NaN;
    return parseInt(raw, 10);
  }

  function ballsBowled() {
    const o = intOf(num.overs), b = intOf(num.balls);
    if (o === null || isNaN(o) || b === null || isNaN(b)) return null;
    return o * 6 + b;
  }

  function totalBalls() {
    return state.totalBalls[combos.family.getValue()] || null;
  }

  /* Six off a legal ball is the most anyone can hit; the extra per over
     covers wides and no-balls. Anything above this did not happen. */
  function maxScoreFor(balls) {
    return balls * 6 + Math.ceil(balls / 6) * 6;
  }

  function validate() {
    clearErrors();
    const errs = [];
    function fail(field, msg) { errs.push(field); setError(field, msg); }

    const family = combos.family.getValue();
    if (!family) fail('family', 'Choose a format.');

    const bat = combos.batting_team.getValue();
    const bowl = combos.bowling_team.getValue();
    if (!bat) fail('batting_team', 'Choose the batting team.');
    if (!bowl) fail('bowling_team', 'Choose the bowling team.');
    if (bat && bowl && bat === bowl) {
      fail('bowling_team', 'A side cannot bowl at itself. Pick a different team.');
    }
    if (!combos.venue.getValue()) fail('venue', 'Choose a venue.');

    const o = intOf(num.overs);
    if (o === null || isNaN(o)) fail('overs_completed', 'Enter a whole number of overs.');
    else if (o < 0) fail('overs_completed', 'Overs cannot be negative.');

    const b = intOf(num.balls);
    if (b === null || isNaN(b)) fail('balls_this_over', 'Enter a number from 0 to 5.');
    else if (b < 0 || b > 5) {
      fail('balls_this_over',
        'An over has six legal balls, so this is 0 to 5. After the sixth the over is complete — add one to overs completed.');
    }

    const balls = ballsBowled();
    const total = totalBalls();
    if (balls !== null && total && balls > total) {
      fail('overs_completed',
        fmt.overs(balls) + ' overs is ' + balls + ' balls, but this format allows only '
        + total + ' (' + (total / 6) + ' overs).');
    }

    const score = intOf(num.score);
    if (score === null || isNaN(score)) fail('current_score', 'Enter the current score.');
    else if (score < 0) fail('current_score', 'A score cannot be negative.');
    else if (balls !== null && score > maxScoreFor(balls)) {
      fail('current_score',
        score + ' runs off ' + balls + ' balls is not reachable — the most is about '
        + maxScoreFor(balls) + '.');
    }

    const w = intOf(num.wkts);
    if (w === null || isNaN(w)) fail('wickets', 'Enter the wickets down.');
    else if (w < 0 || w > 10) fail('wickets', 'Wickets down runs from 0 to 10.');

    const f = intOf(num.fours), s = intOf(num.sixes);
    if (f === null || isNaN(f) || f < 0) fail('fours', 'Enter the number of fours, or 0.');
    if (s === null || isNaN(s) || s < 0) fail('sixes', 'Enter the number of sixes, or 0.');
    if (!isNaN(f) && !isNaN(s) && f !== null && s !== null
        && score !== null && !isNaN(score) && f * 4 + s * 6 > score) {
      fail('fours', f + ' fours and ' + s + ' sixes is ' + (f * 4 + s * 6)
        + ' runs in boundaries alone, more than the score of ' + score + '.');
    }

    const raw5 = String(num.last5.value).trim();
    if (raw5 !== '') {
      const l5 = intOf(num.last5);
      if (l5 === null || isNaN(l5) || l5 < 0) fail('last30_runs', 'Enter a number, or leave it blank.');
      else if (score !== null && !isNaN(score) && l5 > score) {
        fail('last30_runs', 'The last five overs cannot have produced more than the whole innings has.');
      }
    }

    const innings = parseInt(num.innings.value, 10);
    const chasing = innings > 1;
    if (chasing) {
      const t = intOf(num.target);
      if (t === null || isNaN(t) || t <= 0) {
        fail('target', 'A side batting second is chasing something — enter the target.');
      } else if (score !== null && !isNaN(score) && t <= score) {
        fail('target', 'The target of ' + t + ' has already been passed. The innings would be over.');
      }
    }

    if (errs.length) {
      const first = fieldOf(errs[0]);
      const control = first && first.querySelector('.input');
      if (control) control.focus();
    }
    return errs.length === 0;
  }

  /* ------------------------------------------------------- overs read-out */
  function updateOvers() {
    const o = intOf(num.overs), b = intOf(num.balls);
    const display = el('overs-display');
    if (o === null || isNaN(o) || b === null || isNaN(b) || o < 0 || b < 0 || b > 5) {
      display.textContent = '—';
    } else {
      display.textContent = o + '.' + b + ' overs';
    }
    const total = totalBalls();
    const balls = ballsBowled();
    const note = el('balls-left-note');
    if (total && balls !== null && balls <= total) {
      note.textContent = (total - balls) + ' balls left of ' + total;
    } else if (!total && combos.family.getValue()) {
      note.textContent = 'No over limit in this format';
    } else {
      note.textContent = '';
    }
  }

  /* ------------------------------------------------------------- cascade */
  let optionsToken = 0;

  async function loadOptions(opts) {
    opts = opts || {};
    const family = combos.family.getValue();
    if (!family) return;
    const token = ++optionsToken;
    const data = await api.options(family, combos.event.getValue());
    // A slower earlier request must not overwrite a newer one.
    if (token !== optionsToken) return;

    state.venueCity = data.venue_city || {};

    if (opts.events !== false) {
      combos.event.setItems(data.events.map(function (e) {
        return { value: e, label: e, meta: '' };
      }), { keepValue: true });
    }

    const teams = data.teams.map(function (t) { return { value: t, label: t, meta: '' }; });
    const hadBat = combos.batting_team.getValue();
    const hadBowl = combos.bowling_team.getValue();
    const hadVenue = combos.venue.getValue();

    const batKept = combos.batting_team.setItems(teams, { keepValue: false });
    const bowlKept = combos.bowling_team.setItems(teams, { keepValue: false });
    const venueKept = combos.venue.setItems(data.venues.map(function (v) {
      return { value: v, label: v, meta: state.venueCity[v] || '' };
    }), { keepValue: false });

    /* Dropping a selection silently would leave someone predicting a fixture
       they did not choose, so every field that was cleared is named. Only
       fields that actually held something count - clearing an already-empty
       field is not news. */
    const dropped = [];
    if (hadBat && !batKept) dropped.push('batting team');
    if (hadBowl && !bowlKept) dropped.push('bowling team');
    if (hadVenue && !venueKept) dropped.push('venue');

    const notice = document.querySelector('[data-cascade-note]');
    if (notice) {
      if (dropped.length && opts.announce !== false) {
        const list = dropped.length === 1 ? 'The ' + dropped[0]
          : 'The ' + dropped.slice(0, -1).join(', the ') + ' and the ' + dropped[dropped.length - 1];
        notice.textContent = list + ' did not appear in this competition, so '
          + (dropped.length === 1 ? 'it has' : 'they have') + ' been cleared. Pick again below.';
        notice.hidden = false;
      } else {
        notice.hidden = true;
      }
    }
    updateOvers();
  }

  /* --------------------------------------------------------- the result */
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

  function countUp(node, to) {
    if (reduceMotion.matches) { node.textContent = String(to); return; }
    const from = 0;
    const ms = 750;
    const start = performance.now();
    function step(now) {
      const t = Math.min(1, (now - start) / ms);
      // Ease out, so it decelerates onto the number instead of stopping dead.
      const eased = 1 - Math.pow(1 - t, 3);
      node.textContent = String(Math.round(from + (to - from) * eased));
      if (t < 1) requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
  }

  function pctBetween(v, min, max) {
    if (max <= min) return 50;
    return Math.max(0, Math.min(100, ((v - min) / (max - min)) * 100));
  }

  function showResult(p, sent) {
    const body = document.querySelector('[data-result-body]');
    const empty = document.querySelector('[data-result-empty]');
    empty.hidden = true;
    body.hidden = false;

    const min = sent.current_score;
    const max = Math.max(p.high, p.projected_at_crr || p.high) + 12;

    const rail = document.querySelector('.result .rail');
    rail.style.setProperty('--lo', pctBetween(p.low, min, max) + '%');
    rail.style.setProperty('--hi', pctBetween(p.high, min, max) + '%');
    rail.style.setProperty('--point', pctBetween(p.predicted, min, max) + '%');
    rail.style.setProperty('--naive',
      pctBetween(p.projected_at_crr === null ? p.predicted : p.projected_at_crr, min, max) + '%');

    document.querySelector('[data-rail-label]').setAttribute('aria-label',
      'Projected ' + p.predicted + ' runs, with an eighty per cent range from '
      + p.low + ' to ' + p.high + '.');

    fillAll(document.querySelector('.result'), {
      low: String(p.low),
      high: String(p.high),
      'rail-min': String(min),
      'rail-max': String(Math.round(max)),
      crr: fmt.dec(p.crr, 2),
      'balls-left': p.balls_left === null ? 'No limit' : String(p.balls_left),
      'venue-par': String(p.venue_par),
      'venue-n': p.venue_n
        ? 'Average of ' + p.venue_n + ' earlier innings here'
        : 'No history at this ground — a format-wide average is standing in',
      naive: p.projected_at_crr === null ? '—' : String(p.projected_at_crr),
      /* Describes the naive figure relative to the projection, because that
         is the number it sits under. Stating it the other way round put "4
         runs above the projection" beneath a number that was below it. */
      'naive-gap': p.projected_at_crr === null ? 'Not defined without an over limit'
        : (p.predicted === p.projected_at_crr ? 'The same as the projection'
          : Math.abs(p.projected_at_crr - p.predicted) + ' runs '
            + (p.projected_at_crr > p.predicted ? 'above' : 'below') + ' the projection')
    });

    // Both the big number and the legend copy of it get the animation target.
    Array.prototype.forEach.call(
      document.querySelectorAll('.result [data-fill="predicted"]'),
      function (node, i) {
        node.classList.remove('skeleton');
        if (i === 0) countUp(node, p.predicted);
        else node.textContent = String(p.predicted);
      }
    );

    const verdict = document.querySelector('[data-verdict]');
    verdict.textContent = phrase(p, sent);
    state.lastResult = p;
  }

  /* A sentence about what the model is actually saying, so the number is not
     left to speak for itself. */
  function phrase(p, sent) {
    const width = p.high - p.low;
    const bits = [];
    if (p.projected_at_crr !== null) {
      const d = p.predicted - p.projected_at_crr;
      if (Math.abs(d) < 4) {
        bits.push('The model lands close to a flat extrapolation of the current rate.');
      } else if (d > 0) {
        bits.push('The model expects ' + d + ' runs more than the current rate alone implies, '
          + 'which is what you would expect with wickets in hand.');
      } else {
        bits.push('The model expects ' + Math.abs(d) + ' runs fewer than the current rate implies.');
      }
    }
    if (10 - sent.wickets <= 3) {
      bits.push('With ' + (10 - sent.wickets) + ' wickets left there is little room to accelerate.');
    }
    bits.push('The range is ' + width + ' runs wide'
      + (p.balls_left !== null && p.balls_left > 0
        ? ', and narrows as the innings goes on.' : '.'));
    return bits.join(' ');
  }

  /* ------------------------------------------------------------- history */
  const historyList = document.querySelector('[data-history-list]');
  const historyEmpty = document.querySelector('[data-history-empty]');
  const historyCount = document.querySelector('[data-history-count]');
  const historyClear = document.querySelector('[data-history-clear]');

  function renderHistory() {
    const entries = History.all();
    historyList.replaceChildren();
    historyCount.textContent = String(entries.length);
    historyEmpty.hidden = entries.length > 0;
    historyClear.hidden = entries.length === 0;

    entries.forEach(function (e) {
      const li = document.createElement('li');
      li.className = 'history__item';

      const load = document.createElement('button');
      load.type = 'button';
      load.className = 'history__load';
      load.dataset.id = e.id;

      const top = document.createElement('span');
      top.className = 'history__score';
      top.textContent = String(e.result.predicted);
      const band = document.createElement('span');
      band.className = 'history__band';
      band.textContent = e.result.low + '–' + e.result.high;
      top.appendChild(band);

      const who = document.createElement('span');
      who.className = 'history__teams';
      who.textContent = e.state.batting_team + ' v ' + e.state.bowling_team;

      const when = document.createElement('span');
      when.className = 'history__meta';
      when.textContent = e.state.current_score + '/' + e.state.wickets + ' after '
        + e.state.overs_completed + '.' + e.state.balls_this_over
        + ' · ' + fmt.family(e.state.family);

      load.append(top, who, when);

      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'history__delete';
      del.dataset.delete = e.id;
      del.setAttribute('aria-label',
        'Delete the prediction of ' + e.result.predicted + ' for '
        + e.state.batting_team);
      del.textContent = '×';

      li.append(load, del);
      historyList.appendChild(li);
    });
  }

  function loadEntry(id) {
    const entry = History.get(id);
    if (!entry) return;
    const s = entry.state;

    // Set the format first, then let the cascade rebuild the dependent lists
    // before restoring the values that live in them.
    combos.family.setValue(s.family, { silent: true });
    combos.event.setItems([{ value: s.event, label: s.event || 'Any competition', meta: '' }],
      { keepValue: true });
    combos.event.setValue(s.event, { silent: true });

    loadOptions({ announce: false }).then(function () {
      [['batting_team', s.batting_team], ['bowling_team', s.bowling_team],
       ['venue', s.venue]].forEach(function (pair) {
        const c = combos[pair[0]];
        const known = c.items.some(function (i) { return i.value === pair[1]; });
        if (!known) c.setItems(c.items.concat([{ value: pair[1], label: pair[1], meta: '' }]),
          { keepValue: true });
        c.setValue(pair[1], { silent: true });
      });
      num.innings.value = String(s.innings);
      num.overs.value = String(s.overs_completed);
      num.balls.value = String(s.balls_this_over);
      num.score.value = String(s.current_score);
      num.wkts.value = String(s.wickets);
      num.last5.value = s.last30_runs === null || s.last30_runs === undefined
        ? '' : String(s.last30_runs);
      num.fours.value = String(s.fours);
      num.sixes.value = String(s.sixes);
      num.target.value = String(s.target);
      onInningsChange();
      updateOvers();
      clearErrors();
      showResult(entry.result, s);
      document.getElementById('result').scrollIntoView({ block: 'nearest' });
    });
  }

  historyList.addEventListener('click', function (e) {
    const del = e.target.closest('[data-delete]');
    if (del) { History.remove(del.dataset.delete); renderHistory(); return; }
    const load = e.target.closest('.history__load');
    if (load) loadEntry(load.dataset.id);
  });

  historyClear.addEventListener('click', function () {
    if (!window.confirm('Delete every saved prediction?')) return;
    History.clear();
    renderHistory();
  });

  /* --------------------------------------------------------------- wiring */
  function onInningsChange() {
    const chasing = parseInt(num.innings.value, 10) > 1;
    el('target-field').hidden = !chasing;
    if (!chasing) { num.target.value = '0'; setError('target', ''); }
  }

  function collect() {
    const raw5 = String(num.last5.value).trim();
    return {
      family: combos.family.getValue(),
      event: combos.event.getValue(),
      batting_team: combos.batting_team.getValue(),
      bowling_team: combos.bowling_team.getValue(),
      venue: combos.venue.getValue(),
      innings: parseInt(num.innings.value, 10),
      overs_completed: intOf(num.overs),
      balls_this_over: intOf(num.balls),
      current_score: intOf(num.score),
      wickets: intOf(num.wkts),
      last30_runs: raw5 === '' ? null : intOf(num.last5),
      fours: intOf(num.fours),
      sixes: intOf(num.sixes),
      target: parseInt(num.innings.value, 10) > 1 ? intOf(num.target) : 0
    };
  }

  form.addEventListener('submit', async function (e) {
    e.preventDefault();
    if (!validate()) return;

    const btn = el('predict-btn');
    btn.disabled = true;
    btn.textContent = 'Predicting…';
    const sent = collect();
    try {
      const p = await api.predict(sent);
      showResult(p, sent);
      // A new prediction always appends. Editing a loaded entry and running it
      // again gives you both, which is the point of keeping a history.
      History.add(sent, p);
      renderHistory();
    } catch (err) {
      /* The server is the last word on validity. If it rejects something the
         form let through, put the message on the field it names. */
      if (err.fields && err.fields.length) {
        err.fields.forEach(function (f) { setError(f.field, f.message); });
      }
      const box = document.querySelector('[data-error]');
      box.textContent = err.message;
      box.hidden = false;
      box.scrollIntoView({ block: 'nearest' });
    } finally {
      btn.disabled = false;
      btn.textContent = 'Predict final score';
    }
  });

  el('swap-teams').addEventListener('click', function () {
    const bat = combos.batting_team.getValue();
    const bowl = combos.bowling_team.getValue();
    combos.batting_team.setValue(bowl, { silent: true });
    combos.bowling_team.setValue(bat, { silent: true });
    setError('batting_team', '');
    setError('bowling_team', '');
  });

  el('reset-btn').addEventListener('click', function () {
    form.reset();
    onInningsChange();
    updateOvers();
    clearErrors();
    document.querySelector('[data-result-body]').hidden = true;
    document.querySelector('[data-result-empty]').hidden = false;
  });

  num.innings.addEventListener('change', onInningsChange);
  [num.overs, num.balls].forEach(function (i) {
    i.addEventListener('input', updateOvers);
  });
  // Clear a field's error as soon as the user starts fixing it.
  Object.keys(num).forEach(function (k) {
    num[k].addEventListener('input', function () {
      const wrap = num[k].closest('[data-field]');
      if (wrap && wrap.hasAttribute('data-invalid')) setError(wrap.dataset.field, '');
    });
  });

  /* ----------------------------------------------------------------- boot */
  (async function boot() {
    try {
      const meta = await api.meta();
      state.families = meta.families;
      state.totalBalls = meta.family_total_balls;

      combo('f-family', 'family', {
        onChange: function () {
          combos.event.setValue('', { silent: true });
          loadOptions();
        }
      });
      combo('f-event', 'event', {
        emptyLabel: 'Any competition',
        onChange: function () { loadOptions({ events: false }); }
      });
      combo('f-bat', 'batting_team', {});
      combo('f-bowl', 'bowling_team', {});
      combo('f-venue', 'venue', {});

      const families = FORMAT_ORDER.filter(function (f) {
        return state.families.indexOf(f) >= 0;
      }).concat(state.families.filter(function (f) {
        return FORMAT_ORDER.indexOf(f) < 0;
      }));

      combos.family.setItems(families.map(function (f) {
        return { value: f, label: fmt.family(f), meta: FORMAT_META[f] || '' };
      }), { selectFirst: true });

      await loadOptions({ announce: false });
      // Sensible starting teams so the form is usable without hunting, but
      // never the same side twice.
      const teams = combos.batting_team.items;
      if (teams.length > 1) {
        combos.batting_team.setValue(teams[0].value, { silent: true });
        combos.bowling_team.setValue(teams[1].value, { silent: true });
      }
      const venues = combos.venue.items;
      if (venues.length) combos.venue.setValue(venues[0].value, { silent: true });

      onInningsChange();
      updateOvers();
      if (!History.available()) {
        document.querySelector('[data-history-unavailable]').hidden = false;
      }
      renderHistory();
    } catch (err) {
      showFailure(document, err);
    }
  })();
})();
