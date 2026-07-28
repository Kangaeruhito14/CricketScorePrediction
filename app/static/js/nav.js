/* nav.js — the mobile menu, and marking the current page in the header.
   Loaded by every page. No dependencies. */
(function () {
  'use strict';

  var toggle = document.querySelector('.nav-toggle');
  var nav = document.getElementById('site-nav');

  /* ---- current page ------------------------------------------------------
     Set here rather than by hand in five files, so a copied header can never
     claim to be on the wrong page. */
  var here = window.location.pathname.replace(/\/index\.html$/, '/') || '/';
  Array.prototype.forEach.call(
    document.querySelectorAll('.site-nav__link'),
    function (link) {
      var target = new URL(link.getAttribute('href'), window.location.origin).pathname;
      if (target.replace(/\/index\.html$/, '/') === here) {
        link.setAttribute('aria-current', 'page');
      } else {
        link.removeAttribute('aria-current');
      }
    }
  );

  if (!toggle || !nav) return;

  function isOpen() {
    return toggle.getAttribute('aria-expanded') === 'true';
  }

  function setOpen(open) {
    toggle.setAttribute('aria-expanded', String(open));
    nav.setAttribute('data-open', String(open));
    toggle.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
  }

  setOpen(false);

  toggle.addEventListener('click', function () {
    var next = !isOpen();
    setOpen(next);
    if (next) {
      var first = nav.querySelector('.site-nav__link');
      if (first) first.focus();
    }
  });

  // Escape closes and returns focus to the button that opened it, so a
  // keyboard user is not dropped at the top of the document.
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && isOpen()) {
      setOpen(false);
      toggle.focus();
    }
  });

  // A click outside the panel closes it. Checked against the header so
  // clicking the toggle itself does not close-then-reopen.
  document.addEventListener('click', function (e) {
    if (!isOpen()) return;
    if (nav.contains(e.target) || toggle.contains(e.target)) return;
    setOpen(false);
  });

  // Following a link inside the panel closes it, which matters when the link
  // is a same-page anchor and no navigation follows.
  nav.addEventListener('click', function (e) {
    if (e.target.closest('a')) setOpen(false);
  });

  // Crossing the breakpoint while the panel is open would otherwise leave
  // aria-expanded="true" on a button that is no longer displayed.
  var wide = window.matchMedia('(min-width: 50rem)');
  var onChange = function (e) { if (e.matches) setOpen(false); };
  if (wide.addEventListener) wide.addEventListener('change', onChange);
  else wide.addListener(onChange);
})();
