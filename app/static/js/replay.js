/* replay.js — the match replay: picker, ball-by-ball chart, readout panel,
   playback and the key-moments table.

   The chart is hand-drawn SVG at real pixel size rather than a scaled
   viewBox, so strokes and type stay the size they were designed at instead of
   stretching with the container. It is redrawn on resize. */
(function () {
  'use strict';

  const SVG_NS = 'http://www.w3.org/2000/svg';
  const chartEl = document.getElementById('chart');
  if (!chartEl) return;

  const svg = chartEl.querySelector('[data-svg]');
  const scrub = document.querySelector('[data-scrub]');
  const playBtn = document.querySelector('[data-play]');

  const state = {
    matches: [],       // every innings available
    filtered: [],      // after the format and competition filters
    innings: null,     // the loaded innings
    cursor: 0,         // the ball everything is currently describing
    playing: false,
    timer: null,
    geom: null
  };

  const combos = {};
  function makeCombo(id, opts) {
    return new Combobox(document.getElementById(id).closest('.combobox'), opts);
  }

  /* ------------------------------------------------------------ formatting */
  function overOf(balls) { return Math.floor(balls / 6) + '.' + (balls % 6); }

  /* The innings number is part of the label, not decoration: a Test gives
     four innings on one date, and without it the picker shows what look like
     four identical rows. */
  function matchLabel(m) {
    return m.batting_team + ' v ' + m.bowling_team
      + ' · inns ' + m.innings + ' — ' + fmt.date(m.date);
  }

  function matchMeta(m) {
    return fmt.family(m.family) + ' · ' + (m.city || m.venue);
  }

  /* --------------------------------------------------------------- picker */
  function applyFilters() {
    const fam = combos.family.getValue();
    const ev = combos.event.getValue();
    state.filtered = state.matches.filter(function (m) {
      return (!fam || m.family === fam) && (!ev || m.event === ev);
    });

    /* Competitions are re-derived from whatever the format filter left, so
       the list can never offer a competition with nothing behind it. */
    const events = Array.from(new Set(
      state.matches
        .filter(function (m) { return !fam || m.family === fam; })
        .map(function (m) { return m.event; })
        .filter(Boolean)
    )).sort();
    combos.event.setItems(events.map(function (e) {
      return { value: e, label: e, meta: '' };
    }), { keepValue: true });

    combos.match.setItems(state.filtered.map(function (m) {
      return {
        value: m.id,
        label: matchLabel(m),
        /* Searched as well as shown, so typing a ground, a city or a
           competition finds the innings, not just a team name. */
        meta: matchMeta(m),
        search: [m.venue, m.city, m.event, m.match_type].join(' ')
      };
    }), { keepValue: true });

    const note = document.querySelector('[data-match-count]');
    note.textContent = state.filtered.length === state.matches.length
      ? state.matches.length + ' innings available'
      : state.filtered.length + ' of ' + state.matches.length + ' innings match';

    if (!state.filtered.length) return;
    const stillThere = state.filtered.some(function (m) {
      return m.id === combos.match.getValue();
    });
    if (!stillThere) load(state.filtered[0].id);
  }

  /* ----------------------------------------------------------------- load */
  async function load(id) {
    combos.match.setValue(id, { silent: true });
    stopPlaying();
    try {
      const data = await api.replay(id);
      state.innings = data;
      state.cursor = data.balls.length - 1;
      scrub.max = String(data.balls.length - 1);
      scrub.value = String(state.cursor);

      document.querySelector('[data-summary]').hidden = false;
      document.querySelector('[data-main]').hidden = false;
      document.querySelector('[data-moments]').hidden = false;

      fillAll(document, {
        teams: data.batting_team + ' v ' + data.bowling_team
          + ' · innings ' + data.innings,
        /* Many Cricsheet venue names already carry their town - "Svanholm
           Park, Brondby" with city "Brondby". Appending unconditionally
           printed it twice. */
        venue: data.venue + (data.city
          && data.venue.toLowerCase().indexOf(data.city.toLowerCase()) < 0
          ? ', ' + data.city : ''),
        date: fmt.date(data.date),
        format: data.match_type,
        competition: data.event || 'Not recorded',
        final: String(data.final_score),
        mae: fmt.dec(data.mae, 1)
      });

      chartEl.setAttribute('aria-label',
        'Ball-by-ball chart. ' + data.batting_team + ' scored ' + data.final_score
        + '. The model projected the final score at every ball, with an average '
        + 'error of ' + data.mae + ' runs.');

      buildMoments();
      draw();
      updateReadout();
    } catch (err) {
      showFailure(document, err);
    }
  }

  /* ------------------------------------------------------------- geometry */
  function computeGeometry() {
    const d = state.innings;
    const w = chartEl.clientWidth;
    // Below ~30rem the y labels need less room than the plot does.
    const pad = { l: w < 420 ? 34 : 46, r: 10, t: 12, b: 26 };
    const h = Math.max(240, Math.min(400, Math.round(w * 0.46)));

    const xMin = 0;
    const xMax = d.total_balls || d.balls[d.balls.length - 1];
    let yMax = Math.max(d.final_score, Math.max.apply(null, d.high));
    yMax = Math.ceil((yMax * 1.04) / 10) * 10;

    const x = function (balls) {
      return pad.l + (balls - xMin) / (xMax - xMin) * (w - pad.l - pad.r);
    };
    const y = function (runs) {
      return pad.t + (1 - runs / yMax) * (h - pad.t - pad.b);
    };
    return { w: w, h: h, pad: pad, x: x, y: y, xMax: xMax, yMax: yMax };
  }

  function node(name, attrs) {
    const n = document.createElementNS(SVG_NS, name);
    Object.keys(attrs).forEach(function (k) { n.setAttribute(k, attrs[k]); });
    return n;
  }

  function path(points) {
    return points.map(function (p, i) {
      return (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1);
    }).join(' ');
  }

  function draw() {
    const d = state.innings;
    if (!d) return;
    const g = state.geom = computeGeometry();
    svg.setAttribute('width', g.w);
    svg.setAttribute('height', g.h);
    svg.setAttribute('viewBox', '0 0 ' + g.w + ' ' + g.h);
    svg.replaceChildren();

    const plotBottom = g.h - g.pad.b;

    // ---- y grid, labelled in runs
    const steps = 4;
    for (let i = 0; i <= steps; i++) {
      const runs = Math.round(g.yMax / steps * i);
      const yy = g.y(runs);
      svg.appendChild(node('line', {
        class: 'ch-grid', x1: g.pad.l, x2: g.w - g.pad.r, y1: yy, y2: yy
      }));
      const t = node('text', {
        class: 'ch-tick', x: g.pad.l - 8, y: yy + 4, 'text-anchor': 'end'
      });
      t.textContent = String(runs);
      svg.appendChild(t);
    }

    // ---- x labels, in overs
    const overStep = g.xMax > 600 ? 60 : (g.xMax > 200 ? 30 : 24);
    for (let b = 0; b <= g.xMax; b += overStep) {
      const xx = g.x(b);
      svg.appendChild(node('line', {
        class: 'ch-grid', x1: xx, x2: xx, y1: g.pad.t, y2: plotBottom
      }));
      const t = node('text', {
        class: 'ch-tick', x: xx, y: plotBottom + 16, 'text-anchor': 'middle'
      });
      t.textContent = String(b / 6);
      svg.appendChild(t);
    }

    // ---- the 80% band, drawn first so the lines sit on top of it
    const up = d.balls.map(function (b, i) { return [g.x(b), g.y(d.high[i])]; });
    const dn = d.balls.map(function (b, i) { return [g.x(b), g.y(d.low[i])]; }).reverse();
    svg.appendChild(node('path', {
      class: 'ch-band',
      d: path(up) + ' ' + path(dn).replace(/^M/, 'L') + ' Z'
    }));

    // ---- the score the innings actually finished on
    svg.appendChild(node('line', {
      class: 'ch-final', x1: g.pad.l, x2: g.w - g.pad.r,
      y1: g.y(d.final_score), y2: g.y(d.final_score)
    }));

    // ---- wickets: a tick wherever one fell
    d.wickets.forEach(function (w, i) {
      if (i === 0 || w === d.wickets[i - 1]) return;
      const xx = g.x(d.balls[i]);
      svg.appendChild(node('line', {
        class: 'ch-wicket', x1: xx, x2: xx, y1: plotBottom - 14, y2: plotBottom
      }));
    });

    // ---- the two series
    svg.appendChild(node('path', {
      class: 'ch-line ch-pred',
      d: path(d.balls.map(function (b, i) { return [g.x(b), g.y(d.pred[i])]; }))
    }));
    svg.appendChild(node('path', {
      class: 'ch-line ch-score',
      d: path(d.balls.map(function (b, i) { return [g.x(b), g.y(d.score[i])]; }))
    }));

    // ---- cursor, kept in its own group so moving it does not redraw the rest
    const cur = node('g', { 'data-cursor': '' });
    cur.appendChild(node('line', {
      class: 'ch-cursor-line', 'data-cursor-line': '',
      x1: 0, x2: 0, y1: g.pad.t, y2: plotBottom
    }));
    cur.appendChild(node('circle', {
      class: 'ch-dot ch-dot--pred', 'data-cursor-pred': '', r: 5
    }));
    cur.appendChild(node('circle', {
      class: 'ch-dot ch-dot--score', 'data-cursor-score': '', r: 5
    }));
    svg.appendChild(cur);

    moveCursor();
  }

  function moveCursor() {
    const d = state.innings, g = state.geom;
    if (!d || !g) return;
    const i = state.cursor;
    const xx = g.x(d.balls[i]);
    const line = svg.querySelector('[data-cursor-line]');
    const cp = svg.querySelector('[data-cursor-pred]');
    const cs = svg.querySelector('[data-cursor-score]');
    if (!line) return;
    line.setAttribute('x1', xx);
    line.setAttribute('x2', xx);
    cp.setAttribute('cx', xx);
    cp.setAttribute('cy', g.y(d.pred[i]));
    cs.setAttribute('cx', xx);
    cs.setAttribute('cy', g.y(d.score[i]));
  }

  /* -------------------------------------------------------------- readout */
  function sentence(i) {
    const d = state.innings;
    const gap = d.pred[i] - d.final_score;
    const overs = overOf(d.balls[i]);
    const left = d.total_balls ? d.total_balls - d.balls[i] : null;
    const bits = [];

    bits.push('After ' + overs + ' overs the model saw ' + d.score[i] + ' for '
      + d.wickets[i] + (left !== null ? ' with ' + left + ' balls left' : '')
      + ', and projected ' + Math.round(d.pred[i]) + '.');

    if (Math.abs(gap) <= 5) {
      bits.push('That is within five runs of the eventual ' + d.final_score + '.');
    } else {
      bits.push('The innings finished on ' + d.final_score + ', so it was '
        + Math.abs(Math.round(gap)) + ' runs '
        + (gap > 0 ? 'too high' : 'too low') + ' here.');
    }

    const inBand = d.final_score >= d.low[i] && d.final_score <= d.high[i];
    bits.push(inBand
      ? 'The final score was inside the 80% band.'
      : 'The final score fell outside the 80% band — one of the one-in-five it is expected to miss.');

    if (i > 0 && d.wickets[i] > d.wickets[i - 1]) {
      const drop = d.pred[i] - d.pred[i - 1];
      bits.push('A wicket had just fallen, and the projection '
        + (drop < 0 ? 'dropped ' + Math.abs(Math.round(drop))
          : 'moved ' + Math.round(drop)) + ' runs on that ball.');
    } else if (i > 0 && d.sixes[i] > d.sixes[i - 1]) {
      bits.push('That ball went for six.');
    } else if (i > 0 && d.fours[i] > d.fours[i - 1]) {
      bits.push('That ball went for four.');
    }

    return bits.join(' ');
  }

  function updateReadout() {
    const d = state.innings;
    if (!d) return;
    const i = state.cursor;
    const gap = Math.round(d.pred[i] - d.final_score);

    fillAll(document, {
      'ro-over': overOf(d.balls[i]) + ' overs',
      'ro-state': d.score[i] + '/' + d.wickets[i],
      'ro-pred': String(Math.round(d.pred[i])),
      'ro-low': String(Math.round(d.low[i])),
      'ro-high': String(Math.round(d.high[i])),
      'ro-gap': gap === 0 ? 'exactly right'
        : Math.abs(gap) + ' runs ' + (gap > 0 ? 'too high' : 'too low')
    });

    const gapEl = document.querySelector('[data-gap]');
    gapEl.className = 'readout__gap ' + (Math.abs(gap) <= 5 ? 'is-close'
      : (gap > 0 ? 'is-over' : 'is-under'));

    const flags = document.querySelector('[data-flags]');
    flags.replaceChildren();
    function flag(text, kind) {
      const s = document.createElement('span');
      s.className = 'badge' + (kind ? ' badge--' + kind : '');
      s.textContent = text;
      flags.appendChild(s);
    }
    if (i > 0 && d.wickets[i] > d.wickets[i - 1]) flag('Wicket', 'warn');
    if (i > 0 && d.sixes[i] > d.sixes[i - 1]) flag('Six', 'actual');
    if (i > 0 && d.fours[i] > d.fours[i - 1]) flag('Four', 'actual');
    if (d.final_score >= d.low[i] && d.final_score <= d.high[i]) flag('Inside the band', 'predict');

    document.querySelector('[data-note]').textContent = sentence(i);
    document.querySelector('[data-ball-count]').textContent =
      'Ball ' + d.balls[i] + ' of ' + d.balls[d.balls.length - 1];

    // Keep the key-moments table pointing at the same ball as the chart.
    Array.prototype.forEach.call(
      document.querySelectorAll('[data-moments-rows] tr'),
      function (tr) {
        tr.setAttribute('data-current', String(Number(tr.dataset.index) === i));
      }
    );
  }

  function setCursor(i, opts) {
    const d = state.innings;
    if (!d) return;
    state.cursor = Math.max(0, Math.min(d.balls.length - 1, i));
    if (!opts || opts.syncScrub !== false) scrub.value = String(state.cursor);
    moveCursor();
    updateReadout();
  }

  /* ------------------------------------------------------------- moments */
  function buildMoments() {
    const d = state.innings;
    const picked = new Map();
    function add(i, kind, rank) {
      const prev = picked.get(i);
      if (!prev || rank < prev.rank) picked.set(i, { kind: kind, rank: rank });
    }

    for (let i = 1; i < d.balls.length; i++) {
      if (d.wickets[i] > d.wickets[i - 1]) add(i, 'Wicket', 0);
      else if (d.sixes[i] > d.sixes[i - 1]) add(i, 'Six', 1);
      else if (d.fours[i] > d.fours[i - 1]) add(i, 'Four', 2);
    }

    // The balls where the projection moved most, whatever happened on them.
    const moves = [];
    for (let i = 1; i < d.balls.length; i++) {
      moves.push({ i: i, delta: Math.abs(d.pred[i] - d.pred[i - 1]) });
    }
    moves.sort(function (a, b) { return b.delta - a.delta; });
    moves.slice(0, 8).forEach(function (m) { add(m.i, 'Big move', 3); });

    const rows = Array.from(picked.entries())
      .map(function (e) { return { i: Number(e[0]), kind: e[1].kind }; })
      .sort(function (a, b) { return a.i - b.i; });

    const LIMIT = 60;
    const shown = rows.slice(0, LIMIT);
    const tbody = document.querySelector('[data-moments-rows]');
    tbody.replaceChildren();

    shown.forEach(function (r) {
      const before = Math.round(d.pred[r.i - 1]);
      const after = Math.round(d.pred[r.i]);
      const delta = after - before;
      const tr = tableRow([
        overOf(d.balls[r.i]),
        { text: r.kind, cls: 'moment' },
        { text: d.score[r.i] + '/' + d.wickets[r.i], cls: 'n' },
        { text: String(before), cls: 'n' },
        { text: String(after), cls: 'n' },
        { text: (delta > 0 ? '+' : '') + delta, cls: 'n delta-cell' }
      ]);
      tr.dataset.index = String(r.i);
      tr.style.cursor = 'pointer';

      // Re-render the two cells that need markup rather than plain text.
      const kindCell = tr.children[1];
      kindCell.replaceChildren();
      const kindSpan = document.createElement('span');
      kindSpan.className = 'moments__type';
      kindSpan.dataset.kind = r.kind;
      kindSpan.textContent = r.kind;
      kindCell.appendChild(kindSpan);

      const deltaCell = tr.children[5];
      deltaCell.replaceChildren();
      const deltaSpan = document.createElement('span');
      deltaSpan.className = 'delta';
      deltaSpan.dataset.dir = delta > 0 ? 'up' : (delta < 0 ? 'down' : 'flat');
      deltaSpan.textContent = (delta > 0 ? '+' : '') + delta;
      deltaCell.appendChild(deltaSpan);

      tbody.appendChild(tr);
    });

    document.querySelector('[data-moments-caption]').textContent =
      rows.length > LIMIT
        ? 'The first ' + LIMIT + ' of ' + rows.length
          + ' notable balls. Projection before and after each one.'
        : shown.length + ' notable balls. Projection before and after each one.';
  }

  /* ------------------------------------------------------------- playback */
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

  /* Swap the icon by rebuilding its paths. innerHTML on an SVG element is
     inconsistent across engines, and every other node here is built the
     same way. */
  function setPlayIcon(paths) {
    const icon = document.querySelector('[data-play-icon]');
    icon.replaceChildren();
    paths.forEach(function (dAttr) {
      icon.appendChild(node('path', { d: dAttr }));
    });
  }

  const ICON_PLAY = ['M4 2.5v11l9-5.5z'];
  const ICON_PAUSE = ['M4 2.5h3v11H4z', 'M9 2.5h3v11H9z'];

  function stopPlaying() {
    state.playing = false;
    if (state.timer) { clearInterval(state.timer); state.timer = null; }
    document.querySelector('[data-play-text]').textContent = 'Play';
    playBtn.setAttribute('aria-label', 'Play the innings ball by ball');
    setPlayIcon(ICON_PLAY);
  }

  function startPlaying() {
    const d = state.innings;
    if (!d) return;
    // Starting from the end would finish immediately; go back to the top.
    if (state.cursor >= d.balls.length - 1) setCursor(0);
    state.playing = true;
    document.querySelector('[data-play-text]').textContent = 'Pause';
    playBtn.setAttribute('aria-label', 'Pause');
    setPlayIcon(ICON_PAUSE);

    // Long innings would take minutes at one ball a tick, so the step scales
    // with the length rather than the frame rate.
    const step = Math.max(1, Math.round(d.balls.length / 120));
    const ms = reduceMotion.matches ? 120 : 45;
    state.timer = setInterval(function () {
      if (state.cursor >= d.balls.length - 1) { stopPlaying(); return; }
      setCursor(state.cursor + step);
    }, ms);
  }

  playBtn.addEventListener('click', function () {
    if (state.playing) stopPlaying(); else startPlaying();
  });

  scrub.addEventListener('input', function () {
    stopPlaying();
    setCursor(Number(scrub.value), { syncScrub: false });
  });

  /* --------------------------------------------------------- chart input */
  function indexFromClientX(clientX) {
    const d = state.innings, g = state.geom;
    if (!d || !g) return 0;
    const rect = svg.getBoundingClientRect();
    const px = clientX - rect.left;
    // Invert the x scale, then snap to the nearest ball actually recorded -
    // multi-day innings are thinned, so not every ball number exists.
    const balls = (px - g.pad.l) / (g.w - g.pad.l - g.pad.r) * g.xMax;
    let best = 0, bestD = Infinity;
    for (let i = 0; i < d.balls.length; i++) {
      const dd = Math.abs(d.balls[i] - balls);
      if (dd < bestD) { bestD = dd; best = i; }
    }
    return best;
  }

  chartEl.addEventListener('mousemove', function (e) {
    if (state.playing) return;   // do not fight the animation
    setCursor(indexFromClientX(e.clientX));
  });

  chartEl.addEventListener('touchmove', function (e) {
    if (!e.touches.length) return;
    stopPlaying();
    setCursor(indexFromClientX(e.touches[0].clientX));
  }, { passive: true });

  chartEl.addEventListener('keydown', function (e) {
    const d = state.innings;
    if (!d) return;
    const big = Math.max(1, Math.round(d.balls.length / 20));
    let next = null;
    if (e.key === 'ArrowRight') next = state.cursor + 1;
    else if (e.key === 'ArrowLeft') next = state.cursor - 1;
    else if (e.key === 'PageUp') next = state.cursor + big;
    else if (e.key === 'PageDown') next = state.cursor - big;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = d.balls.length - 1;
    else if (e.key === ' ' || e.key === 'Enter') {
      e.preventDefault();
      if (state.playing) stopPlaying(); else startPlaying();
      return;
    }
    if (next === null) return;
    e.preventDefault();
    stopPlaying();
    setCursor(next);
  });

  document.querySelector('[data-moments-rows]').addEventListener('click', function (e) {
    const tr = e.target.closest('tr[data-index]');
    if (!tr) return;
    stopPlaying();
    setCursor(Number(tr.dataset.index));
    chartEl.scrollIntoView({ block: 'nearest' });
  });

  // Redraw on resize; the chart is drawn at pixel size, not scaled.
  let resizeTimer = null;
  new ResizeObserver(function () {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function () { if (state.innings) draw(); }, 80);
  }).observe(chartEl);

  /* ----------------------------------------------------------------- boot */
  (async function boot() {
    try {
      state.matches = await api.matches();
      if (!state.matches.length) {
        showFailure(document, { message: 'No replay innings are bundled with this build.' });
        return;
      }

      combos.family = makeCombo('r-family', {
        emptyLabel: 'Any format',
        onChange: applyFilters
      });
      combos.event = makeCombo('r-event', {
        emptyLabel: 'Any competition',
        onChange: applyFilters
      });
      combos.match = makeCombo('r-match', {
        onChange: function (id) { if (id) load(id); }
      });

      const families = Array.from(new Set(state.matches.map(function (m) { return m.family; })));
      combos.family.setItems(families.map(function (f) {
        return { value: f, label: fmt.family(f), meta: '' };
      }));

      applyFilters();
      await load(state.filtered[0].id);
    } catch (err) {
      showFailure(document, err);
    }
  })();
})();
