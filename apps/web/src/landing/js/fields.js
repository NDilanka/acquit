/* Fields host (orchestrator, round 5: concept 4 "inspect", evidence/inspo/concepts/f-4-inspect.png).
 * The shown field's graded stock clip fills the whole section. The field's checks are pinned on the
 * work as inspection callouts (bracket on the spot, hairline leader, label box): LIVE fields carry the
 * real checks with a tick, roadmap fields carry dashed "Planned check" boxes with no tick.
 * A corner card names the field; the 7 field tabs run along the bottom with the auto-advance bar.
 * Callout anchors are in clip-frame units (0..1 of the 4:3 frame), so they stay on the work at any
 * viewport: the frame is cover-fitted with container query units in fields.css.
 * ?field=f02 and localStorage wf:field remember the field. Round 4 host: sections/_archive/fields-r4.*. */
(function () {
  'use strict';

  var base = '/landing/';

  window.WF = window.WF || {
    paused: false,
    reduce: !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches),
    side: 'operator',
  };

  var PRINT_NOTE = 'Print score card in CI: caught 11 of 12 known frauds (known gap: replay of the same file) '
    + 'and passed 22 of 22 honest prints with the real PrusaSlicer. Printer telemetry and layer photos are simulated in CI.';

  // c: callouts. x,y = the spot on the work; lx,ly = where the leader meets the label; side = which way the label opens.
  var FIELDS = [
    { id: 'f01', num: '01', name: 'Code fixes', status: 'LIVE', line: 'A GitHub issue, fixed and proven.',
      get: 'A pull request that fixes your issue', paid: 'Verified, then a 72-hour review',
      alt: 'A developer typing code on a laptop',
      c: [
        { t: 'Frozen tests pass', s: 'Run in a Docker sandbox', x: .32, y: .37, lx: .45, ly: .33, side: 'r' },
        { t: 'Hidden cases pass', s: 'The agent never sees them', x: .30, y: .52, lx: .45, ly: .49, side: 'r' },
        { t: 'Protected paths untouched', s: 'A tampered test is rejected', x: .27, y: .67, lx: .45, ly: .65, side: 'r' },
      ] },
    { id: 'f02', num: '02', name: '3D prints', status: 'SIMULATED', line: 'A part that matches the spec.',
      get: 'A printed part that matches your approved model', paid: 'Verified, then review', note: PRINT_NOTE,
      alt: 'A desktop 3D printer laying down a part',
      c: [
        { t: 'G-code conformance', s: 'Sliced at hidden layers against your part', x: .50, y: .665, lx: .64, ly: .80, side: 'r' },
        { t: 'Witness coupon', s: 'A seeded coupon printed on the plate', x: .42, y: .60, lx: .24, ly: .76, side: 'r' },
        { t: 'Signed telemetry', s: 'Signed by the printer', x: .63, y: .16, lx: .55, ly: .36, side: 'r' },
        { t: 'Layer photos', s: 'Checked against earlier jobs for reuse', x: .27, y: .53, lx: .14, ly: .68, side: 'r' },
      ] },
    { id: 'f03', num: '03', name: '3D renders', status: 'ROADMAP', line: 'Frames that match the scene.',
      get: 'Rendered frames of your scene', paid: 'Hashes match',
      alt: 'A designer working on a 3D scene on a monitor',
      c: [
        { t: 'Frame hashes', x: .58, y: .24, lx: .50, ly: .40, side: 'l' },
        { t: 'Resolution', x: .86, y: .44, lx: .80, ly: .58, side: 'l' },
        { t: 'A hidden frame re-rendered', x: .63, y: .46, lx: .56, ly: .66, side: 'l' },
      ] },
    { id: 'f04', num: '04', name: 'Motion and video', status: 'ROADMAP', line: 'Cuts that match the brief.',
      get: 'An edit cut to your brief', paid: 'Probes pass, then sign-off',
      alt: 'A video edit timeline on a monitor',
      c: [
        { t: 'Duration and format', x: .60, y: .33, lx: .66, ly: .58, side: 'r' },
        { t: 'Hidden caption-sync probes', x: .42, y: .41, lx: .44, ly: .66, side: 'r' },
      ] },
    { id: 'f05', num: '05', name: 'Writing', status: 'ROADMAP', line: 'Copy that meets the rubric.',
      get: 'Copy written to your rubric', paid: 'Rubric pass, then sign-off',
      alt: 'Hands typing on a typewriter',
      c: [
        { t: 'Plagiarism check', x: .58, y: .22, lx: .72, ly: .46, side: 'r' },
        { t: 'Rubric', x: .48, y: .34, lx: .72, ly: .60, side: 'r' },
      ] },
    { id: 'f06', num: '06', name: 'Translation', status: 'ROADMAP', line: 'Text that keeps its meaning.',
      get: 'Your text in another language', paid: 'Checks pass, then sign-off',
      alt: 'Close-up of dictionary pages',
      c: [
        { t: 'Hidden reference passages', x: .66, y: .50, lx: .72, ly: .62, side: 'r' },
        { t: 'Terminology', x: .78, y: .36, lx: .66, ly: .46, side: 'l' },
      ] },
    { id: 'open', num: '··', name: 'Your field', status: 'OPEN', line: 'Any outcome a machine can check.',
      get: 'The outcome you need', paid: 'When the check passes',
      link: { href: 'https://github.com/NDilanka/acquit/issues', text: 'Propose a field →' },
      alt: 'A compass measuring a drawing',
      c: [
        { t: 'A check you propose', x: .73, y: .49, lx: .78, ly: .62, side: 'r' },
      ] },
  ];
  var IDS = FIELDS.map(function (f) { return f.id; });
  var FKEY = 'wf:field';
  var STEP_MS = 650;

  function $(sel, ctx) { return (ctx || document).querySelector(sel); }
  function $$(sel, ctx) { return Array.prototype.slice.call((ctx || document).querySelectorAll(sel)); }
  function fieldOf(id) { for (var i = 0; i < FIELDS.length; i++) if (FIELDS[i].id === id) return FIELDS[i]; return FIELDS[0]; }
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function param(name) { try { return new URLSearchParams(window.location.search).get(name); } catch (e) { return null; } }
  function stored(key) { try { return window.localStorage.getItem(key); } catch (e) { return null; } }
  function store(key, value, urlName) {
    try { window.localStorage.setItem(key, value); } catch (e) { /* storage blocked */ }
    try {
      var url = new URL(window.location.href);
      url.searchParams.set(urlName, value);
      window.history.replaceState(null, '', url.href);
    } catch (e) { /* sandboxed page */ }
  }
  function validField(v) { return IDS.indexOf(v) !== -1 ? v : null; }
  function statusKey(s) { return s.toLowerCase().replace(/\s+/g, '-'); }
  function pct(v) { return (v * 100).toFixed(2) + '%'; }

  var TICK = '<svg class="fx-tick" viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 8.4l2.9 2.9 6-6.6"/></svg>';

  /* ---------------------------------------------------------------- markup */

  function leaderPath(c) {
    // a horizontal-then-diagonal leader reads as a drafting callout; via 'v' goes vertical first
    var x = c.x * 1280, y = c.y * 960, lx = c.lx * 1280, ly = c.ly * 960;
    if (c.via === 'v') return 'M' + x + ' ' + y + 'L' + x + ' ' + ly + 'L' + lx + ' ' + ly;
    var kx = lx + (c.side === 'r' ? -24 : 24);
    return 'M' + x + ' ' + y + 'L' + kx + ' ' + ly + 'L' + lx + ' ' + ly;
  }

  function calloutsHtml(f) {
    var planned = f.status === 'ROADMAP' || f.status === 'OPEN';
    var lines = f.c.map(function (c, i) {
      return '<path class="fx-lead" style="--i:' + i + '" pathLength="1" d="' + leaderPath(c) + '"/>';
    }).join('');
    var pins = f.c.map(function (c, i) {
      return '<span class="fx-pin" style="--i:' + i + ';left:' + pct(c.x) + ';top:' + pct(c.y) + '"><span class="fx-pin-n mono">' + (i + 1) + '</span></span>'
        + '<span class="fx-lbl" data-side="' + c.side + '" style="--i:' + i + ';left:' + pct(c.lx) + ';top:' + pct(c.ly) + '">'
        + (planned ? '<span class="fx-lbl-k mono">Planned check</span>' : TICK)
        + '<span class="fx-lbl-t">' + esc(c.t) + '</span>'
        + (c.s ? '<span class="fx-lbl-s">' + esc(c.s) + '</span>' : '')
        + '</span>';
    }).join('');
    return '<svg class="fx-leads" viewBox="0 0 1280 960" preserveAspectRatio="none" aria-hidden="true">' + lines + '</svg>' + pins;
  }

  function listHtml(f) {
    var planned = f.status === 'ROADMAP' || f.status === 'OPEN';
    return '<p class="fx-list-k mono">' + (planned ? 'Planned checks' : 'We check') + '</p><ol class="fx-list">'
      + f.c.map(function (c, i) {
        return '<li><span class="fx-list-n mono">' + (i + 1) + '</span><span><span class="fx-list-t">' + esc(c.t) + '</span>'
          + (c.s ? '<span class="fx-list-s">' + esc(c.s) + '</span>' : '') + '</span>' + (planned ? '' : TICK) + '</li>';
      }).join('') + '</ol>';
  }

  function cardHtml(f) {
    return '<div class="fx-card-top"><span class="fx-no mono">Field ' + esc(f.num) + '</span>'
      + '<span class="fx-status" data-status="' + statusKey(f.status) + '">' + esc(f.status) + '</span></div>'
      + '<h3 class="fx-name">' + esc(f.name) + '</h3>'
      + '<p class="fx-line">' + esc(f.line) + '</p>'
      + '<dl class="fx-spec"><div><dt>You get</dt><dd>' + esc(f.get) + '</dd></div>'
      + '<div><dt>Paid when</dt><dd>' + esc(f.paid) + '</dd></div></dl>'
      + (f.note ? '<p class="fx-note mono">' + esc(f.note) + '</p>' : '')
      + (f.status === 'ROADMAP' ? '<p class="fx-note mono">Roadmap: not live yet. Nothing in this field is verified today.</p>' : '')
      + (f.link ? '<a class="fx-link" href="' + esc(f.link.href) + '">' + esc(f.link.text) + '</a>' : '');
  }

  function build(root) {
    var tabs = FIELDS.map(function (f) {
      return '<button type="button" class="fx-tab" role="tab" id="fx-tab-' + f.id + '" aria-controls="fx-panel" data-id="' + f.id + '" aria-selected="false" tabindex="-1">'
        + '<span class="fx-prog" aria-hidden="true"></span>'
        + '<span class="fx-tn mono"><span class="fx-dot" data-status="' + statusKey(f.status) + '" aria-hidden="true"></span>' + esc(f.num) + '</span>'
        + '<span class="fx-tname">' + esc(f.name) + '</span>'
        + '<span class="sr-only">, ' + esc(f.status) + '</span>'
        + '</button>';
    }).join('');
    var vids = FIELDS.map(function (f) {
      return '<video data-id="' + f.id + '" muted loop playsinline preload="none" aria-hidden="true" poster="'
        + base + 'fields/video/' + f.id + '.jpg" src="' + base + 'fields/video/' + f.id + '.mp4"></video>';
    }).join('');
    root.innerHTML = ''
      + '<div class="fx">'
      + '<div class="fx-media" role="img"><div class="fx-frame">' + vids + '<div class="fx-marks"></div></div></div>'
      + '<div class="fx-scrim" aria-hidden="true"></div>'
      + '<div class="fx-head"><p class="fx-kicker mono">Fields · one task per agent</p>'
      + '<h2 class="fx-title" id="fields-title"><span class="fx-t1">Pick the one thing it does.</span><span class="fx-t2">Acquit knows how to check it.</span></h2>'
      + '<p class="fx-sandbox mono">PayPal sandbox. No real money moves.</p></div>'
      + '<div class="fx-panel" id="fx-panel" role="tabpanel" tabindex="0">'
      + '<div class="fx-card" aria-live="polite"></div>'
      + '<div class="fx-checks"></div>'
      + '</div>'
      + '<p class="fx-stock mono">Stock footage (Pexels), not a customer job</p>'
      + '<div class="fx-tabs" role="tablist" aria-label="Fields">' + tabs + '</div>'
      + '</div>';
  }

  /* ---------------------------------------------------------------- behaviour */

  function init() {
    var root = document.getElementById('fields-root');
    if (!root) return;
    build(root);

    var fx = $('.fx', root);
    var media = $('.fx-media', root);
    var marks = $('.fx-marks', root);
    var card = $('.fx-card', root);
    var checks = $('.fx-checks', root);
    var panel = $('.fx-panel', root);
    var tabs = $$('.fx-tab', root);
    var vids = {};
    $$('video', root).forEach(function (v) { v.muted = true; vids[v.getAttribute('data-id')] = v; });

    var field = validField(param('field')) || validField(stored(FKEY)) || 'f01';
    var autoOn = true;
    var visible = false;
    var mediaVisible = true;
    var swapTimer = 0;
    var lastT = 0;

    function still() { return window.WF.paused || window.WF.reduce; }
    function canPlay() { return mediaVisible && !document.hidden && !still(); }
    function canRun() { return autoOn && visible && !still() && !document.hidden; }

    function syncVideo() {
      Object.keys(vids).forEach(function (k) {
        var v = vids[k];
        if (k === field && canPlay()) { var p = v.play(); if (p && p.catch) p.catch(function () {}); }
        else v.pause();
      });
      fx.classList.toggle('is-still', still());
    }

    // replay the callouts one by one: on every field change and every time the clip loops
    function replayMarks() {
      if (still()) { fx.classList.remove('is-draw'); return; }
      fx.classList.remove('is-draw');
      void marks.offsetWidth;
      fx.classList.add('is-draw');
    }

    Object.keys(vids).forEach(function (k) {
      vids[k].addEventListener('timeupdate', function () {
        if (k !== field) return;
        var t = vids[k].currentTime;
        if (t + 0.5 < lastT) replayMarks();
        lastT = t;
      });
    });

    function paintText(f) {
      marks.innerHTML = calloutsHtml(f);
      card.innerHTML = cardHtml(f);
      checks.innerHTML = listHtml(f);
      media.setAttribute('aria-label', f.alt);
      fx.setAttribute('data-field', f.id);
      fx.setAttribute('data-status', statusKey(f.status));
      panel.setAttribute('aria-labelledby', 'fx-tab-' + f.id);
      replayMarks();
    }

    function showVideo(id) {
      lastT = 0;
      Object.keys(vids).forEach(function (k) {
        var v = vids[k];
        var on = k === id;
        v.classList.toggle('is-on', on);
        if (on && v.preload === 'none') { v.preload = 'auto'; v.load(); }
        if (on) { try { v.currentTime = 0; } catch (e) { /* not loaded yet */ } }
        else v.pause();
      });
      syncVideo();
    }

    function setField(id, opts) {
      opts = opts || {};
      var f = fieldOf(id);
      var changed = id !== field;
      field = id;
      tabs.forEach(function (t) {
        var on = t.getAttribute('data-id') === id;
        t.setAttribute('aria-selected', String(on));
        t.tabIndex = on ? 0 : -1;
        var bar = $('.fx-prog', t);
        bar.style.animation = 'none';
        void bar.offsetWidth;
        bar.style.animation = '';
      });
      showVideo(id);
      clearTimeout(swapTimer);
      if (!changed || opts.instant || window.WF.reduce) {
        paintText(f);
        fx.classList.remove('is-swapping');
      } else {
        fx.classList.add('is-swapping');
        swapTimer = setTimeout(function () { paintText(f); fx.classList.remove('is-swapping'); }, 200);
      }
      if (opts.save) store(FKEY, id, 'field');
      if (opts.focus) $('#fx-tab-' + id, root).focus();
    }

    function paintRun() { fx.classList.toggle('is-run', canRun()); }
    function stopAuto() { autoOn = false; paintRun(); }

    tabs.forEach(function (t, i) {
      $('.fx-prog', t).addEventListener('animationend', function () {
        if (!canRun() || t.getAttribute('aria-selected') !== 'true') return;
        setField(IDS[(i + 1) % IDS.length]);
      });
      t.addEventListener('click', function () { stopAuto(); setField(t.getAttribute('data-id'), { save: true }); });
      t.addEventListener('keydown', function (e) {
        var n = null;
        if (e.key === 'ArrowRight') n = (i + 1) % tabs.length;
        else if (e.key === 'ArrowLeft') n = (i - 1 + tabs.length) % tabs.length;
        else if (e.key === 'Home') n = 0;
        else if (e.key === 'End') n = tabs.length - 1;
        if (n === null) return;
        e.preventDefault();
        stopAuto();
        setField(IDS[n], { save: true, focus: true });
      });
    });
    panel.addEventListener('pointerdown', stopAuto);

    if ('IntersectionObserver' in window) {
      new IntersectionObserver(function (en) { visible = en[0].isIntersecting; paintRun(); }, { threshold: 0.5 }).observe(fx);
      new IntersectionObserver(function (en) { mediaVisible = en[0].isIntersecting; syncVideo(); }, { threshold: 0.15 }).observe(media);
    } else { visible = true; }
    function onMotion() { syncVideo(); paintRun(); replayMarks(); }
    document.addEventListener('wf:pause', onMotion);
    document.addEventListener('wf:play', onMotion);
    document.addEventListener('visibilitychange', function () { syncVideo(); paintRun(); });

    fx.style.setProperty('--step', STEP_MS + 'ms');
    setField(field, { instant: true });
    paintRun();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
