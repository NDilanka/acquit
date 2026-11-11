/* Fields: a plain two-column sheet. The field list is the tab list; the card beside it names the
 * field, what the client gets, when it pays, and how the work is checked. Fields that are not live
 * show their checks as planned, with no tick.
 * ?field=f02 and localStorage wf:field remember the field. */
(function () {
  'use strict';

  var PRINT_NOTE = 'Print score card in CI: caught 11 of 12 known frauds (known gap: replay of the same file) '
    + 'and passed 22 of 22 honest prints with the real PrusaSlicer. Printer telemetry and layer photos are simulated in CI.';
  var LASER_NOTE = 'Paid laser jobs run through the API today. The web product opens code jobs only. '
    + 'Acquit checks the file; no machine cuts it.';

  var FIELDS = [
    { id: 'f01', num: '01', name: 'Code fixes', status: 'LIVE', line: 'A GitHub issue, fixed and proven.',
      get: 'A pull request that fixes your issue', paid: 'Verified, then a 72-hour review',
      c: [
        { t: 'Frozen tests pass', s: 'Run in a Docker sandbox' },
        { t: 'Hidden cases pass', s: 'The agent never sees them' },
        { t: 'Protected paths untouched', s: 'A tampered test is rejected' },
      ] },
    { id: 'laser', num: '02', name: 'Laser files', status: 'LIVE VIA API', line: 'A cut file that fits the drawing.',
      get: 'A cut file checked against your drawing', paid: 'Verified, then you approve through the API', note: LASER_NOTE,
      c: [
        { t: 'Public rules pass', s: 'The agent can read them' },
        { t: 'Sealed checks pass', s: 'The agent never receives them' },
      ] },
    { id: 'f02', num: '03', name: '3D prints', status: 'SIMULATED', line: 'A part that matches the spec.',
      get: 'A printed part that matches your approved model', paid: 'Verified, then review', note: PRINT_NOTE,
      c: [
        { t: 'G-code conformance', s: 'Sliced at hidden layers against your part' },
        { t: 'Witness coupon', s: 'A seeded coupon printed on the plate' },
        { t: 'Signed telemetry', s: 'Signed by the printer' },
        { t: 'Layer photos', s: 'Checked against earlier jobs for reuse' },
      ] },
    { id: 'f03', num: '04', name: '3D renders', status: 'ROADMAP', line: 'Frames that match the scene.',
      get: 'Rendered frames of your scene', paid: 'Hashes match',
      c: [{ t: 'Frame hashes' }, { t: 'Resolution' }, { t: 'A hidden frame re-rendered' }] },
    { id: 'f04', num: '05', name: 'Motion and video', status: 'ROADMAP', line: 'Cuts that match the brief.',
      get: 'An edit cut to your brief', paid: 'Probes pass, then sign-off',
      c: [{ t: 'Duration and format' }, { t: 'Hidden caption-sync probes' }] },
    { id: 'f05', num: '06', name: 'Writing', status: 'ROADMAP', line: 'Copy that meets the rubric.',
      get: 'Copy written to your rubric', paid: 'Rubric pass, then sign-off',
      c: [{ t: 'Plagiarism check' }, { t: 'Rubric' }] },
    { id: 'f06', num: '07', name: 'Translation', status: 'ROADMAP', line: 'Text that keeps its meaning.',
      get: 'Your text in another language', paid: 'Checks pass, then sign-off',
      c: [{ t: 'Hidden reference passages' }, { t: 'Terminology' }] },
    { id: 'open', num: '··', name: 'Your field', status: 'OPEN', line: 'Any outcome a machine can check.',
      get: 'The outcome you need', paid: 'When the check passes',
      link: { href: 'https://github.com/NDilanka/acquit/issues', text: 'Propose a field →' },
      c: [{ t: 'A check you propose' }] },
  ];
  var IDS = FIELDS.map(function (f) { return f.id; });
  var FKEY = 'wf:field';

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
  function isPlanned(f) { return f.status === 'ROADMAP' || f.status === 'OPEN'; }
  function isLive(f) { return f.status === 'LIVE' || f.status === 'LIVE VIA API'; }

  var TICK = '<svg class="fx-tick" viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 8.4l2.9 2.9 6-6.6"/></svg>';
  var RING = '<span class="fx-ring" aria-hidden="true"></span>';

  function cardHtml(f) {
    var planned = isPlanned(f);
    return '<div class="fx-card-top"><span class="fx-no mono">Field ' + esc(f.num) + '</span>'
      + '<span class="fx-status" data-status="' + statusKey(f.status) + '">' + esc(f.status) + '</span></div>'
      + '<h3 class="fx-name">' + esc(f.name) + '</h3>'
      + '<p class="fx-line">' + esc(f.line) + '</p>'
      + '<dl class="fx-spec"><div><dt class="mono">You get</dt><dd>' + esc(f.get) + '</dd></div>'
      + '<div><dt class="mono">Paid when</dt><dd>' + esc(f.paid) + '</dd></div></dl>'
      + '<p class="fx-list-k mono">' + (planned ? 'Planned checks' : isLive(f) ? 'How it is checked' : 'Checks, simulated today') + '</p>'
      + '<ul class="fx-list">' + f.c.map(function (c) {
        return '<li>' + (isLive(f) ? TICK : RING) + '<span class="fx-list-t">' + esc(c.t) + '</span>'
          + (c.s ? '<span class="fx-list-s">' + esc(c.s) + '</span>' : '') + '</li>';
      }).join('') + '</ul>'
      + (f.note ? '<p class="fx-note">' + esc(f.note) + '</p>' : '')
      + (f.status === 'ROADMAP' ? '<p class="fx-note">Roadmap: not live yet. Nothing in this field is verified today.</p>' : '')
      + (f.link ? '<a class="fx-link" href="' + esc(f.link.href) + '">' + esc(f.link.text) + '</a>' : '');
  }

  function build(root) {
    var tabs = FIELDS.map(function (f) {
      return '<button type="button" class="fx-tab" role="tab" id="fx-tab-' + f.id + '" aria-controls="fx-panel" data-id="' + f.id + '" aria-selected="false" tabindex="-1">'
        + '<span class="fx-tn mono" aria-hidden="true">' + esc(f.num) + '</span>'
        + '<span class="fx-tname">' + esc(f.name) + '</span>'
        + '<span class="fx-tag mono" data-status="' + statusKey(f.status) + '">' + esc(f.status) + '</span>'
        + '</button>';
    }).join('');
    root.innerHTML = ''
      + '<div class="fx wrap">'
      + '<div class="fx-head"><p class="fx-kicker mono">Fields · one task per agent</p>'
      + '<h2 class="fx-title" id="fields-title"><span class="fx-t1">If a machine can check it,</span><span class="fx-t2">Acquit can pay for it.</span></h2>'
      + '<p class="fx-sandbox mono">PayPal sandbox. No real money moves.</p></div>'
      + '<div class="fx-body">'
      + '<div class="fx-tabs" role="tablist" aria-label="Fields" aria-orientation="vertical">' + tabs + '</div>'
      + '<div class="fx-card" id="fx-panel" role="tabpanel" tabindex="0" aria-live="polite"></div>'
      + '</div>'
      + '</div>';
  }

  function init() {
    var root = document.getElementById('fields-root');
    if (!root) return;
    build(root);

    var card = $('.fx-card', root);
    var tabs = $$('.fx-tab', root);

    function setField(id, opts) {
      opts = opts || {};
      var f = fieldOf(id);
      tabs.forEach(function (t) {
        var on = t.getAttribute('data-id') === id;
        t.setAttribute('aria-selected', String(on));
        t.tabIndex = on ? 0 : -1;
      });
      card.innerHTML = cardHtml(f);
      card.setAttribute('aria-labelledby', 'fx-tab-' + f.id);
      if (!opts.instant) {
        card.classList.remove('is-in');
        void card.offsetWidth;
        card.classList.add('is-in');
      }
      if (opts.save) store(FKEY, id, 'field');
      if (opts.focus) $('#fx-tab-' + id, root).focus();
    }

    tabs.forEach(function (t, i) {
      t.addEventListener('click', function () { setField(t.getAttribute('data-id'), { save: true }); });
      t.addEventListener('keydown', function (e) {
        var n = null;
        if (e.key === 'ArrowDown' || e.key === 'ArrowRight') n = (i + 1) % tabs.length;
        else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') n = (i - 1 + tabs.length) % tabs.length;
        else if (e.key === 'Home') n = 0;
        else if (e.key === 'End') n = tabs.length - 1;
        if (n === null) return;
        e.preventDefault();
        setField(IDS[n], { save: true, focus: true });
      });
    });

    setField(validField(param('field')) || validField(stored(FKEY)) || 'f01', { instant: true });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
