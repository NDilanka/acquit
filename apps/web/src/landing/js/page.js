/* page.js: shared page state and the small behaviours every section relies on.
   window.WF = { paused, reduce, side }. */
(function () {
  'use strict';
  var reduceMQ = window.matchMedia('(prefers-reduced-motion: reduce)');
  var WF = window.WF = window.WF || {};
  WF.paused = false;
  WF.reduce = reduceMQ.matches;
  WF.side = 'operator';
  reduceMQ.addEventListener('change', function () { WF.reduce = reduceMQ.matches; });

  /* reveal once */
  var reveals = [].slice.call(document.querySelectorAll('.reveal'));
  if ('IntersectionObserver' in window) {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) { if (e.isIntersecting) { e.target.classList.add('is-in'); io.unobserve(e.target); } });
    }, { rootMargin: '0px 0px -12% 0px', threshold: 0.08 });
    reveals.forEach(function (el) { io.observe(el); });
  } else reveals.forEach(function (el) { el.classList.add('is-in'); });

  /* pill nav: shown once the hero is passed; it reads light on the night sections */
  var nav = document.getElementById('pill-nav');
  var hero = document.getElementById('hero');
  if (nav && hero && 'IntersectionObserver' in window) {
    new IntersectionObserver(function (en) {
      var past = !en[0].isIntersecting;
      nav.classList.toggle('is-shown', past);
      nav.inert = !past;
    }, { rootMargin: '-64px 0px 0px 0px', threshold: 0 }).observe(hero);
  }

  /* the pill nav steps aside while the pinned board holds the screen */
  var board = document.getElementById('socket');
  if (nav && board && 'IntersectionObserver' in window) {
    new IntersectionObserver(function (en) { nav.classList.toggle('is-tucked', en[0].isIntersecting); },
      { rootMargin: '-50% 0px -50% 0px', threshold: 0 }).observe(board);
  }
  /* FAQ accordions */
  [].forEach.call(document.querySelectorAll('.faq-q'), function (q) {
    q.addEventListener('click', function () {
      var open = q.getAttribute('aria-expanded') === 'true';
      q.setAttribute('aria-expanded', String(!open));
      var a = document.getElementById(q.getAttribute('aria-controls'));
      if (a) a.hidden = open;
    });
  });
  /* the shift: words light up with scroll progress */
  [].forEach.call(document.querySelectorAll('[data-words]'), function (host) {
    (function split(node) {
      [].slice.call(node.childNodes).forEach(function (n) {
        if (n.nodeType === 3) {
          var frag = document.createDocumentFragment();
          n.textContent.split(/(\s+)/).forEach(function (part) {
            if (!part) return;
            if (/^\s+$/.test(part)) { frag.appendChild(document.createTextNode(' ')); return; }
            var s = document.createElement('span'); s.className = 'w'; s.textContent = part; frag.appendChild(s);
          });
          node.replaceChild(frag, n);
        } else if (n.nodeType === 1) split(n);
      });
    })(host);
    var words = [].slice.call(host.querySelectorAll('.w'));
    var ticking = false;
    function paint() {
      ticking = false;
      var r = host.getBoundingClientRect(), vh = window.innerHeight;
      var p = (vh * 0.85 - r.top) / (r.height + vh * 0.45);
      var n = Math.round(Math.max(0, Math.min(1, p)) * words.length);
      words.forEach(function (w, i) { w.classList.toggle('is-on', i < n); });
    }
    window.addEventListener('scroll', function () { if (!ticking) { ticking = true; requestAnimationFrame(paint); } }, { passive: true });
    window.addEventListener('resize', paint);
    paint();
  });

  /* the agent plate leans toward the pointer */
  var plate = document.querySelector('.plate');
  if (plate && window.matchMedia('(hover: hover)').matches) {
    plate.addEventListener('pointermove', function (e) {
      if (WF.reduce || WF.paused) return;
      var r = plate.getBoundingClientRect();
      var x = (e.clientX - r.left) / r.width - 0.5, y = (e.clientY - r.top) / r.height - 0.5;
      plate.style.transition = 'transform 120ms linear';
      plate.style.transform = 'rotateX(' + (-y * 7).toFixed(2) + 'deg) rotateY(' + (x * 9).toFixed(2) + 'deg) translateZ(8px)';
    });
    plate.addEventListener('pointerleave', function () { plate.style.transition = ''; plate.style.transform = ''; });
  }
})();
