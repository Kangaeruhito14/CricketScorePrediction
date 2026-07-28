/* combobox.js — a searchable select, built to the ARIA 1.2 combobox pattern.
   No dependency: a picker is a text input, a list, and a set of key handlers,
   and pulling in a library for that would cost more than it saved.

   Markup it enhances (predict.html supplies it; this file never invents it):

     <div class="combobox" data-combobox>
       <input class="input combobox__input" role="combobox" ...>
       <button class="combobox__toggle" type="button" tabindex="-1">
       <ul class="combobox__listbox" role="listbox">

   Items are {value, label, meta}. `meta` is searched as well as shown, which
   is what lets a venue be found by its city: typing "sydney" surfaces
   Stadium Australia, whose name does not contain the word.  */
(function (global) {
  'use strict';

  /* Enough to scroll through, few enough that filtering stays instant on a
     phone. Venue lists run to ~600 entries. */
  const MAX_RENDER = 200;

  function normalise(s) {
    return String(s == null ? '' : s).toLowerCase().trim();
  }

  function Combobox(root, opts) {
    opts = opts || {};
    this.root = root;
    this.input = root.querySelector('.combobox__input');
    this.list = root.querySelector('.combobox__listbox');
    this.toggle = root.querySelector('.combobox__toggle');
    this.onChange = opts.onChange || function () {};
    this.allowEmpty = opts.allowEmpty !== false;
    this.emptyLabel = opts.emptyLabel || null;

    this.items = [];
    this.filtered = [];
    this.value = '';
    this.activeIndex = -1;
    this.open = false;

    if (!this.list.id) {
      this.list.id = (this.input.id || 'combobox') + '-listbox';
    }
    this.input.setAttribute('role', 'combobox');
    this.input.setAttribute('aria-expanded', 'false');
    this.input.setAttribute('aria-controls', this.list.id);
    this.input.setAttribute('aria-autocomplete', 'list');
    this.input.setAttribute('autocomplete', 'off');
    this.input.setAttribute('spellcheck', 'false');

    this._bind();
  }

  Combobox.prototype._bind = function () {
    const self = this;

    this.input.addEventListener('input', function () {
      self.setOpen(true);
      self.render(self.input.value);
      self.setActive(self.filtered.length ? 0 : -1);
    });

    /* Clicking the field shows everything available rather than filtering by
       whatever happens to be in the box - the user is asking "what are my
       options", not "narrow what I typed". */
    this.input.addEventListener('mousedown', function () {
      if (!self.open) {
        self.render('');
        self.setOpen(true);
        self.syncActiveToValue();
      }
    });

    this.input.addEventListener('focus', function () {
      self.input.select();
    });

    this.input.addEventListener('keydown', function (e) {
      self._onKeyDown(e);
    });

    /* Leaving the field without choosing must not leave stray text behind
       that looks like a selection. Put back the label of whatever is
       actually selected. */
    this.input.addEventListener('blur', function () {
      window.setTimeout(function () {
        if (self.root.contains(document.activeElement)) return;
        self.setOpen(false);
        self.input.value = self.labelFor(self.value);
      }, 120);
    });

    if (this.toggle) {
      this.toggle.addEventListener('click', function (e) {
        e.preventDefault();
        if (self.open) {
          self.setOpen(false);
        } else {
          self.render('');
          self.setOpen(true);
          self.syncActiveToValue();
        }
        self.input.focus();
      });
    }

    /* Pointer selection is delegated, so re-rendering the list on every
       keystroke does not orphan a listener. */
    this.list.addEventListener('mousedown', function (e) {
      const li = e.target.closest('.combobox__option');
      if (!li || li.dataset.index === undefined) return;
      e.preventDefault();   // keep focus on the input
      self.choose(self.filtered[Number(li.dataset.index)]);
    });
  };

  Combobox.prototype._onKeyDown = function (e) {
    const key = e.key;

    if (key === 'ArrowDown' || key === 'ArrowUp') {
      e.preventDefault();
      if (!this.open) {
        this.render('');
        this.setOpen(true);
        this.syncActiveToValue();
        return;
      }
      const step = key === 'ArrowDown' ? 1 : -1;
      const n = this.filtered.length;
      if (!n) return;
      let next = this.activeIndex + step;
      if (next < 0) next = n - 1;
      if (next >= n) next = 0;
      this.setActive(next);
      return;
    }

    if (key === 'Home' && this.open) { e.preventDefault(); this.setActive(0); return; }
    if (key === 'End' && this.open) {
      e.preventDefault(); this.setActive(this.filtered.length - 1); return;
    }

    if (key === 'Enter') {
      if (this.open && this.activeIndex >= 0) {
        // Only swallow the key when it is actually choosing something,
        // so Enter still submits the form from a closed combobox.
        e.preventDefault();
        this.choose(this.filtered[this.activeIndex]);
      }
      return;
    }

    if (key === 'Escape') {
      if (this.open) {
        e.stopPropagation();      // do not also close a dialog behind it
        this.setOpen(false);
        this.input.value = this.labelFor(this.value);
      }
      return;
    }

    if (key === 'Tab' && this.open) {
      this.setOpen(false);
      this.input.value = this.labelFor(this.value);
    }
  };

  Combobox.prototype.setOpen = function (open) {
    this.open = open;
    this.root.setAttribute('data-open', String(open));
    this.input.setAttribute('aria-expanded', String(open));
    if (!open) {
      this.input.removeAttribute('aria-activedescendant');
      this.activeIndex = -1;
    }
  };

  Combobox.prototype.labelFor = function (value) {
    const hit = this.items.find(function (i) { return i.value === value; });
    if (hit) return hit.label;
    return value ? value : (this.emptyLabel || '');
  };

  Combobox.prototype.setItems = function (items, opts) {
    opts = opts || {};
    this.items = (items || []).slice();
    if (this.emptyLabel) {
      this.items.unshift({ value: '', label: this.emptyLabel, meta: '' });
    }
    /* A cascade can remove the current selection - picking the IPL while a
       BPL side is chosen. Dropping it silently would leave the field showing
       a team that is no longer on the list, so it is cleared and the caller
       is told. */
    const stillValid = this.items.some(function (i) { return i.value === this.value; }, this);
    if (!stillValid && opts.keepValue !== true) {
      this.value = '';
    }
    if (this.value === '' && opts.selectFirst && this.items.length) {
      const first = this.items.find(function (i) { return i.value !== ''; });
      if (first) this.value = first.value;
    }
    this.input.value = this.labelFor(this.value);
    if (this.open) this.render(this.input.value);
    return stillValid;
  };

  Combobox.prototype.getValue = function () { return this.value; };

  Combobox.prototype.setValue = function (value, opts) {
    opts = opts || {};
    this.value = value == null ? '' : value;
    this.input.value = this.labelFor(this.value);
    if (opts.silent !== true) this.onChange(this.value);
  };

  Combobox.prototype.choose = function (item) {
    if (!item) return;
    this.value = item.value;
    this.input.value = item.label;
    this.setOpen(false);
    this.onChange(this.value);
  };

  Combobox.prototype.syncActiveToValue = function () {
    const self = this;
    const i = this.filtered.findIndex(function (it) { return it.value === self.value; });
    this.setActive(i >= 0 ? i : (this.filtered.length ? 0 : -1));
  };

  Combobox.prototype.setActive = function (index) {
    this.activeIndex = index;
    const nodes = this.list.querySelectorAll('.combobox__option');
    Array.prototype.forEach.call(nodes, function (li) {
      li.setAttribute('data-active', 'false');
    });
    if (index < 0 || index >= nodes.length) {
      this.input.removeAttribute('aria-activedescendant');
      return;
    }
    const li = nodes[index];
    li.setAttribute('data-active', 'true');
    this.input.setAttribute('aria-activedescendant', li.id);
    // Keep the active row in view without scrolling the page behind it.
    const box = this.list.getBoundingClientRect();
    const row = li.getBoundingClientRect();
    if (row.top < box.top) this.list.scrollTop -= (box.top - row.top);
    else if (row.bottom > box.bottom) this.list.scrollTop += (row.bottom - box.bottom);
  };

  /* Build a fragment with the matched run wrapped in <mark>, using text nodes
     throughout - venue and team names come from the data and are never
     treated as markup. */
  function markMatch(text, query) {
    const frag = document.createDocumentFragment();
    if (!query) {
      frag.appendChild(document.createTextNode(text));
      return frag;
    }
    const at = normalise(text).indexOf(query);
    if (at < 0) {
      frag.appendChild(document.createTextNode(text));
      return frag;
    }
    frag.appendChild(document.createTextNode(text.slice(0, at)));
    const m = document.createElement('mark');
    m.textContent = text.slice(at, at + query.length);
    frag.appendChild(m);
    frag.appendChild(document.createTextNode(text.slice(at + query.length)));
    return frag;
  }

  Combobox.prototype.render = function (query) {
    const q = normalise(query);
    /* A query equal to the current selection means the field was opened, not
       searched - show everything rather than the one row already chosen. */
    const searching = q && q !== normalise(this.labelFor(this.value));

    this.filtered = !searching ? this.items.slice() : this.items.filter(function (i) {
      return normalise(i.label).indexOf(q) >= 0 || normalise(i.meta).indexOf(q) >= 0;
    });

    const shown = this.filtered.slice(0, MAX_RENDER);
    const listId = this.list.id;
    this.list.replaceChildren();

    if (!shown.length) {
      const li = document.createElement('li');
      li.className = 'combobox__empty';
      li.textContent = 'No match for “' + query + '”';
      this.list.appendChild(li);
      return;
    }

    shown.forEach(function (item, i) {
      const li = document.createElement('li');
      li.className = 'combobox__option';
      li.id = listId + '-opt-' + i;
      li.setAttribute('role', 'option');
      li.setAttribute('aria-selected', String(item.value === this.value));
      li.setAttribute('data-active', 'false');
      li.dataset.index = String(i);

      const name = document.createElement('span');
      name.appendChild(markMatch(item.label, searching ? q : ''));
      li.appendChild(name);

      if (item.meta) {
        const meta = document.createElement('span');
        meta.className = 'combobox__meta';
        meta.appendChild(markMatch(item.meta, searching ? q : ''));
        li.appendChild(meta);
      }
      this.list.appendChild(li);
    }, this);

    if (this.filtered.length > MAX_RENDER) {
      const li = document.createElement('li');
      li.className = 'combobox__empty';
      li.textContent = 'Showing the first ' + MAX_RENDER + ' of '
        + this.filtered.length + ' — keep typing to narrow it down';
      this.list.appendChild(li);
    }
  };

  global.Combobox = Combobox;
})(window);
