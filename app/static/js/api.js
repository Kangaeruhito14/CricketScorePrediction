/* api.js — every call to the backend, and the formatting helpers that go with
   the figures it returns. Exposes window.api; no dependencies, no modules. */
(function (global) {
  'use strict';

  /* A failed request carries the server's own sentence. main.py flattens
     pydantic's error list into `detail` and keeps the per-field breakdown in
     `errors`, so a form can both show a message and mark the right input. */
  function ApiError(message, status, fields) {
    this.name = 'ApiError';
    this.message = message;
    this.status = status || 0;
    this.fields = fields || [];
  }
  ApiError.prototype = Object.create(Error.prototype);

  async function request(url, init) {
    let res;
    try {
      res = await fetch(url, init);
    } catch (e) {
      throw new ApiError('Could not reach the server.', 0);
    }
    const text = await res.text();
    let body = null;
    if (text) {
      try { body = JSON.parse(text); } catch (e) { body = null; }
    }
    if (!res.ok) {
      const detail = body && body.detail;
      throw new ApiError(
        typeof detail === 'string' ? detail : 'Request failed (' + res.status + ').',
        res.status,
        (body && body.errors) || []
      );
    }
    return body;
  }

  function qs(params) {
    const p = new URLSearchParams();
    Object.keys(params).forEach(function (k) {
      if (params[k] !== undefined && params[k] !== null) p.set(k, params[k]);
    });
    const s = p.toString();
    return s ? '?' + s : '';
  }

  /* /api/report is read by three pages and never changes between them, so it
     is fetched once per page load and shared. */
  let reportPromise = null;

  const api = {
    ApiError: ApiError,

    report: function () {
      if (!reportPromise) {
        reportPromise = request('/api/report').catch(function (e) {
          reportPromise = null;   // let a later caller retry
          throw e;
        });
      }
      return reportPromise;
    },

    options: function (family, event) {
      return request('/api/options' + qs({ family: family, event: event || '' }));
    },

    predict: function (state) {
      return request('/api/predict', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(state)
      });
    },

    matches: function () { return request('/api/matches'); },

    replay: function (id) { return request('/api/replay/' + encodeURIComponent(id)); },

    meta: function () { return request('/api/meta'); }
  };

  /* ---- formatting -------------------------------------------------------
     Shared so a figure looks the same on every page it appears on. */
  const fmt = {
    int: function (n) {
      return n === null || n === undefined || isNaN(n)
        ? '—' : Math.round(n).toLocaleString('en-GB');
    },

    dec: function (n, places) {
      return n === null || n === undefined || isNaN(n)
        ? '—' : Number(n).toFixed(places === undefined ? 2 : places);
    },

    pct: function (n, places) {
      return n === null || n === undefined || isNaN(n)
        ? '—' : (n * 100).toFixed(places === undefined ? 0 : places) + '%';
    },

    /* 11,348,329 -> "11.3 million". Used where the exact figure is noise and
       the order of magnitude is the point. */
    big: function (n) {
      if (n === null || n === undefined || isNaN(n)) return '—';
      if (n >= 1e6) return (n / 1e6).toFixed(1) + ' million';
      if (n >= 1e3) return Math.round(n / 1e3) + ',000';
      return String(n);
    },

    /* The internal family keys are not words anyone says out loud. */
    family: function (f) {
      return { t20: 'T20', odi: 'ODI', multiday: 'Multi-day',
               long_limited: 'Long limited-overs' }[f] || f;
    },

    /* "odi | final quarter" -> "Final quarter" */
    phase: function (group) {
      const part = String(group).split('|').pop().trim();
      return part.charAt(0).toUpperCase() + part.slice(1);
    },

    date: function (iso) {
      if (!iso) return '—';
      const d = new Date(iso + 'T00:00:00Z');
      if (isNaN(d)) return iso;
      return d.toLocaleDateString('en-GB',
        { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
    },

    /* 70 balls -> "11.4 overs" */
    overs: function (balls) {
      if (balls === null || balls === undefined || isNaN(balls)) return '—';
      return Math.floor(balls / 6) + '.' + (balls % 6);
    }
  };

  /* Replace a skeleton placeholder with its real value. Keeps the shimmer
     class removal and the text write in one place so no element is left
     pulsing after its number has arrived. */
  function fill(el, text) {
    if (!el) return;
    el.classList.remove('skeleton');
    el.textContent = text;
  }

  /* Every matching element, not just the first: a figure often appears twice
     on a page - once large and once inside a caption - and both must update. */
  function fillAll(root, values) {
    Object.keys(values).forEach(function (key) {
      Array.prototype.forEach.call(
        (root || document).querySelectorAll('[data-fill="' + key + '"]'),
        function (el) { fill(el, values[key]); }
      );
    });
  }

  /* Build a table row from plain values. Everything on this site ultimately
     comes from a parquet file of team, venue and competition names, so rows
     are assembled with textContent rather than innerHTML - a ground called
     `<script>` would otherwise be executable markup.
     Each cell is a string, or {text, cls, title}. */
  function tableRow(cells) {
    const tr = document.createElement('tr');
    cells.forEach(function (c) {
      const td = document.createElement('td');
      const spec = typeof c === 'object' && c !== null ? c : { text: c };
      td.textContent = spec.text === undefined || spec.text === null ? '—' : spec.text;
      if (spec.cls) td.className = spec.cls;
      if (spec.title) td.title = spec.title;
      tr.appendChild(td);
    });
    return tr;
  }

  /* One place to say "this did not load", so a failure never leaves a page
     shimmering forever with no explanation. */
  function showFailure(root, err) {
    const box = (root || document).querySelector('[data-error]');
    if (box) {
      box.textContent = err && err.message
        ? err.message : 'Could not load these figures.';
      box.hidden = false;
    }
    Array.prototype.forEach.call(
      (root || document).querySelectorAll('.skeleton'),
      function (el) { el.classList.remove('skeleton'); el.textContent = '—'; }
    );
  }

  global.api = api;
  global.fmt = fmt;
  global.fill = fill;
  global.fillAll = fillAll;
  global.tableRow = tableRow;
  global.showFailure = showFailure;
})(window);
