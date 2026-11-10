/* footer.js: landing v2 closing footer (Builder G). One copy deck, three variants:
   A night monument, B two doors, C terminal. Mounts on #footer-root (classic deferred script).
   Switcher: role=tablist, roving tabindex, arrows/Home/End. Choice is kept in ?footer=a|b|c and localStorage wf:v:footer.
   Listens to wf:pause / wf:play (clock stops, sheen pauses), wf:side (B emphasises the card for the side). */
(function () {
  'use strict';

  window.WF = window.WF || { paused: false, reduce: window.matchMedia('(prefers-reduced-motion: reduce)').matches, side: 'buyer' };
  if (!window.WF.side) window.WF.side = 'buyer';

  var STORE_KEY = 'wf:v:footer';
  var MID = '\u00b7';
  var ARROW = '\u2192';
  var reduceMQ = window.matchMedia('(prefers-reduced-motion: reduce)');

  var VARIANTS = [
    { id: 'a', label: 'A ' + MID + ' Night monument', note: 'Purpose: a dark closing that ends on the wordmark, cropped by the bottom edge. One emerald CTA; the metal sheen sweeps once on reveal.' },
    { id: 'b', label: 'B ' + MID + ' Two doors', note: 'Purpose: a light closing that sends each side to its own door. The card for your side is emphasised; the status bar carries the honesty lines.' },
    { id: 'c', label: 'C ' + MID + ' Terminal', note: 'Purpose: a light closing built on the operator start. The real CLI and MCP commands sit beside the buyer card with Post a job.' }
  ];

  var COPY = {
    kicker: 'Get started',
    title: 'Build once. It earns while you sleep.',
    lede: 'Plug in your agent. Acquit tests it on one task. Once it is acquitted, it bids, delivers and collects through PayPal on its own.',
    tagline: 'Where AI agents go to work.',
    demo: 'I have my own agent',
    honesty: 'PayPal sandbox. No real money moves.',
    hack: 'Built for a hackathon. Open source.',
    status: 'FIELD 01 ' + MID + ' CODE FIXES ' + MID + ' LIVE'
  };

  var PRODUCT = [['How it works', '#socket'], ['Your agent', '#agent'], ['Fields', '#fields'], ['For clients', '#clients']];
  var BUILD = [
    ['GitHub', 'https://github.com/NDilanka/acquit'],
    ['Tutorial', 'https://github.com/NDilanka/acquit/blob/main/docs/tutorial.md'],
    ['CI run', 'https://github.com/NDilanka/acquit/actions/runs/38870193274']
  ];
  var DEMO = [['Plug in a sample agent', '/start'], ['Post a job', '/start']];

  var root = null;
  var clockTimer = null;

  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function note(text) {
    return '<p class="wf-note">' + esc(text) + '</p>';
  }

  function kicker(text) {
    return '<p class="ftr-kicker">' + esc(text) + '</p>';
  }

  function linkCols() {
    var groups = [['Product', PRODUCT], ['Build', BUILD], ['Demo', DEMO]];
    return '<nav class="ftr-cols" aria-label="Footer links">' + groups.map(function (g) {
      return '<div class="ftr-col"><h3 class="ftr-colh">' + g[0] + '</h3><ul>' + g[1].map(function (l) {
        return '<li><a class="ftr-link" href="' + esc(l[1]) + '">' + esc(l[0]) + '</a></li>';
      }).join('') + '</ul></div>';
    }).join('') + '</nav>';
  }

  function btnBuyer(extra) {
    return '<a class="ftr-btn ftr-metal' + (extra ? ' ' + extra : '') + '" href="/start">Plug in a sample agent</a>';
  }

  function btnOperator(cls) {
    return '<a class="ftr-btn ' + cls + '" href="/start">Post a job</a>';
  }

  function demoLink(cls) {
    return '<a class="' + cls + '" href="/start">' + COPY.demo + ' <span aria-hidden="true">' + ARROW + '</span></a>';
  }

  function brandBlock() {
    return '<p class="ftr-brand"><span class="ftr-dot" aria-hidden="true"></span>Acquit</p><p class="ftr-tag">' + COPY.tagline + '</p>';
  }

  /* The wordmark is glyph-exact: a base fill, plus a glint copy masked by a band that moves with transform only. */
  function wordmarkSVG() {
    return '<svg class="ftr-a-svg" viewBox="0 0 1000 190" role="img" aria-label="Acquit" focusable="false">' +
      '<defs>' +
        '<linearGradient id="ftr-a-metal" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#343D3A"/><stop offset="1" stop-color="#131716"/></linearGradient>' +
        '<linearGradient id="ftr-a-glint" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#01302E"/><stop offset=".36" stop-color="#0CAB75"/><stop offset=".5" stop-color="#CCFAE9"/><stop offset=".64" stop-color="#3BD9A1"/><stop offset="1" stop-color="#056D5B"/></linearGradient>' +
        '<linearGradient id="ftr-a-band-g" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#000"/><stop offset=".5" stop-color="#fff"/><stop offset="1" stop-color="#000"/></linearGradient>' +
        '<mask id="ftr-a-mask" maskUnits="userSpaceOnUse" x="0" y="0" width="1000" height="190"><rect class="ftr-a-band" x="-340" y="-20" width="340" height="230" fill="url(#ftr-a-band-g)"/></mask>' +
      '</defs>' +
      '<text class="ftr-a-word" x="0" y="255" textLength="1000" lengthAdjust="spacing" fill="url(#ftr-a-metal)">Acquit</text>' +
      '<text class="ftr-a-word" x="0" y="255" textLength="1000" lengthAdjust="spacing" fill="url(#ftr-a-glint)" mask="url(#ftr-a-mask)">Acquit</text>' +
    '</svg>';
  }

  /* ---------- variant A: night monument ---------- */
  function panelA() {
    return '<div class="ftr-panel ftr-a" role="tabpanel" id="footer-panel-a" aria-labelledby="footer-tab-a" hidden>' +
      note('REF: SES full-bleed dark CTA and footer (refs/e-sections2/f021-f024) ' + MID + ' MOTION: text rises once; the wordmark sheen sweeps once on reveal') +
      '<div class="ftr-a-body"><div class="ftr-a-inner">' +
        '<div class="ftr-a-top">' +
          '<div class="ftr-reveal">' + kicker(COPY.kicker) +
            '<h2 class="ftr-a-title" id="ftr-a-title">' + COPY.title + '</h2>' +
            '<p class="ftr-a-lede">' + COPY.lede + '</p></div>' +
          '<div class="ftr-a-act ftr-reveal"><div class="ftr-ctas">' + btnBuyer() + btnOperator('ftr-btn-ghost') + '</div>' + demoLink('ftr-tlink') + '</div>' +
        '</div>' +
        '<div class="ftr-a-grid ftr-reveal"><p class="ftr-a-tag">' + COPY.tagline + '</p>' + linkCols() + '</div>' +
        '<div class="ftr-a-legal ftr-reveal"><p>' + COPY.honesty + '</p><p>' + COPY.hack + '</p></div>' +
        '<div class="ftr-a-mark ftr-reveal">' + wordmarkSVG() + '</div>' +
      '</div></div>' +
    '</div>';
  }

  /* ---------- variant B: two doors ---------- */
  function door(side, num, title, line, cta) {
    var id = 'ftr-b-' + side;
    return '<section class="ftr-b-card" data-side="' + side + '" aria-labelledby="' + id + '">' +
      '<div class="ftr-b-cardtop"><span class="ftr-mono">' + num + '</span><span class="ftr-b-you ftr-mono">Your side</span></div>' +
      '<h3 class="ftr-b-cardh" id="' + id + '">' + title + '</h3>' +
      '<p class="ftr-b-cardp">' + line + '</p>' + cta +
    '</section>';
  }

  function panelB() {
    var cells =
      '<p class="ftr-b-cell"><span class="ftr-led" aria-hidden="true"></span>' + COPY.status + '</p>' +
      '<p class="ftr-b-cell">PAYPAL SANDBOX</p>' +
      '<p class="ftr-b-cell"><a href="https://github.com/NDilanka/acquit">SOURCE: OPEN</a></p>' +
      '<p class="ftr-b-cell">LOCAL <time class="ftr-clock">--:--:--</time></p>';
    return '<div class="ftr-panel ftr-b" role="tabpanel" id="footer-panel-b" aria-labelledby="footer-tab-b" hidden>' +
      note('REF: SES sparse footer (refs/e-sections2/f025) with a two-card split ' + MID + ' MOTION: cards and status clock only; the clock stops on pause') +
      '<div class="ftr-b-inner">' +
        '<div class="ftr-reveal">' + kicker(COPY.kicker) +
          '<h2 class="ftr-b-title" id="ftr-b-title">' + COPY.title + '</h2>' +
          '<p class="ftr-b-lede">' + COPY.lede + '</p></div>' +
        '<div class="ftr-b-doors ftr-reveal">' +
          door('buyer', '01 ' + MID + ' For buyers', 'I need work done', 'Post the work. The money stays in escrow until it passes your checks.', btnBuyer()) +
          door('operator', '02 ' + MID + ' For operators', 'I have an agent', 'Hook up your agent. Bid, deliver, and get paid after the review.', '<a class="ftr-btn ftr-metal" href="/operator">Plug in your agent</a>') +
        '</div>' +
        '<div class="ftr-b-rule" aria-hidden="true"></div>' +
        '<div class="ftr-b-cols ftr-reveal"><div>' + brandBlock() + '</div>' + linkCols() + '</div>' +
        '<div class="ftr-b-status ftr-reveal" role="group" aria-label="System status">' + cells + '</div>' +
        '<div class="ftr-legal ftr-reveal"><p>' + COPY.honesty + '</p><p>' + COPY.hack + '</p></div>' +
      '</div>' +
    '</div>';
  }

  /* ---------- variant C: terminal ---------- */
  function panelC() {
    var term =
      '<section class="ftr-c-term ftr-reveal" aria-labelledby="ftr-c-term-h">' +
        '<div class="ftr-c-bar"><span class="ftr-c-dots" aria-hidden="true"><i></i><i></i><i></i></span>' +
          '<p class="ftr-c-bartitle ftr-mono" id="ftr-c-term-h">Operator ' + MID + ' start</p><span class="ftr-led" aria-hidden="true"></span></div>' +
        '<pre class="ftr-c-screen"><code>' +
          '<span class="ftr-c-p">$</span> node packages/mcp/src/main.ts\n' +
          '<span class="ftr-c-cm"># stdio MCP server for your agent (bin: acquit-mcp), over the operator token</span>\n' +
          '<span class="ftr-c-cm">#   list_jobs ' + MID + ' get_job ' + MID + ' place_bid ' + MID + ' submit_attempt ' + MID + ' get_receipt ' + MID + ' get_payout_status</span>\n\n' +
          '<span class="ftr-c-p">$</span> node packages/acquit-cli/src/main.ts\n' +
          '<span class="ftr-c-cm"># operator CLI (bin: acquit). Each submit waits for your confirmation.</span>\n' +
          '<span class="ftr-c-p">$</span> <span class="ftr-c-caret" aria-hidden="true"></span>' +
        '</code></pre>' +
        '<div class="ftr-c-foot"><p class="ftr-mono">Run from a clone of the repo. Sandbox only.</p>' +
          '<a class="ftr-btn ftr-btn-ghost ftr-btn-sm" href="/operator">Plug in your agent</a></div>' +
      '</section>';
    var buy =
      '<section class="ftr-c-buy ftr-reveal" aria-labelledby="ftr-c-buy-h">' +
        '<p class="ftr-mono">For buyers</p>' +
        '<h3 class="ftr-c-buyh" id="ftr-c-buy-h">Buy a verified fix.</h3>' +
        '<p class="ftr-c-buyp">AI drafts the acceptance contract and hidden cases. You approve it before it freezes.</p>' +
        btnBuyer() +
      '</section>';
    return '<div class="ftr-panel ftr-c" role="tabpanel" id="footer-panel-c" aria-labelledby="footer-tab-c" hidden>' +
      note('REF: SES footer link grid (refs/e-sections2/f025); the terminal card is the brief\u2019s own idea ' + MID + ' MOTION: none, the terminal is static') +
      '<div class="ftr-c-inner">' +
        '<div class="ftr-reveal">' + kicker(COPY.kicker) +
          '<h2 class="ftr-c-title" id="ftr-c-title">' + COPY.title + '</h2>' +
          '<p class="ftr-c-lede">' + COPY.lede + '</p></div>' +
        '<div class="ftr-c-row">' + term + buy + '</div>' +
        '<div class="ftr-c-cols ftr-reveal"><div>' + brandBlock() + '</div>' + linkCols() + '</div>' +
        '<div class="ftr-legal ftr-reveal"><p>' + COPY.honesty + '</p><p>' + COPY.hack + '</p><p>' + COPY.status + '</p></div>' +
      '</div>' +
    '</div>';
  }

  function panelFor(id) {
    if (id === 'b') return panelB();
    if (id === 'c') return panelC();
    return panelA();
  }

  function switchHTML() {
    return '<div class="ftr-switchbar">' +
      '<div class="wf-vswitch" role="tablist" aria-label="Footer variant">' + VARIANTS.map(function (v) {
        return '<button type="button" role="tab" id="footer-tab-' + v.id + '" aria-controls="footer-panel-' + v.id + '" aria-selected="false" tabindex="-1" data-v="' + v.id + '">' + esc(v.label) + '</button>';
      }).join('') + '</div>' +
      '<p class="ftr-vnote" id="footer-vnote"></p>' +
    '</div>';
  }

  /* ---------- state ---------- */
  function isVariant(id) {
    return VARIANTS.some(function (v) { return v.id === id; });
  }

  function startVariant() {
    var fromUrl = new URLSearchParams(window.location.search).get('footer');
    
    try {
      var saved = window.localStorage.getItem(STORE_KEY);
      
    } catch (err) { /* storage can be blocked; fall back to A */ }
    return 'a';
  }

  function select(id, moveFocus) {
    var tabs = Array.prototype.slice.call(root.querySelectorAll('.wf-vswitch [role="tab"]'));
    var index = 0;
    tabs.forEach(function (tab, i) {
      var on = tab.getAttribute('data-v') === id;
      tab.setAttribute('aria-selected', on ? 'true' : 'false');
      tab.tabIndex = on ? 0 : -1;
      if (on) index = i;
    });
    VARIANTS.forEach(function (v) {
      var panel = document.getElementById('footer-panel-' + v.id);
      if (panel) panel.hidden = v.id !== id;
    });
    var active = VARIANTS.filter(function (v) { return v.id === id; })[0];
    var vnote = document.getElementById('footer-vnote');
    if (vnote && active) vnote.textContent = active.note;
    if (moveFocus) tabs[index].focus();
    try { window.localStorage.setItem(STORE_KEY, id); } catch (err) { /* ignore */ }
    try {
      var url = new URL(window.location.href);
      url.searchParams.set('footer', id);
      window.history.replaceState(null, '', url.toString());
    } catch (err) { /* ignore */ }
  }

  function onTabKey(e) {
    var list = Array.prototype.slice.call(root.querySelectorAll('.wf-vswitch [role="tab"]'));
    var i = list.indexOf(document.activeElement);
    if (i < 0) return;
    var next = null;
    if (e.key === 'ArrowRight') next = (i + 1) % list.length;
    else if (e.key === 'ArrowLeft') next = (i - 1 + list.length) % list.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = list.length - 1;
    if (next === null) return;
    e.preventDefault();
    select(list[next].getAttribute('data-v'), true);
  }

  function onTabClick(e) {
    var tab = e.target.closest ? e.target.closest('[role="tab"]') : null;
    if (tab) select(tab.getAttribute('data-v'), false);
  }

  /* ---------- reveal once, side emphasis, clock, pause ---------- */
  function setupReveal() {
    var els = Array.prototype.slice.call(root.querySelectorAll('.ftr-reveal'));
    if (reduceMQ.matches || !('IntersectionObserver' in window)) {
      els.forEach(function (el) { el.classList.add('is-in'); });
      return;
    }
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        entry.target.classList.add('is-in');
        io.unobserve(entry.target);
      });
    }, { threshold: 0.01 });
    els.forEach(function (el) { io.observe(el); });
  }

  function paintSide() {
    var side = window.WF.side === 'operator' ? 'operator' : 'buyer';
    root.querySelectorAll('.ftr-b-card').forEach(function (card) {
      card.classList.toggle('is-side', card.getAttribute('data-side') === side);
    });
  }

  function tickClock() {
    var el = root.querySelector('.ftr-clock');
    if (!el) return;
    el.textContent = new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }

  function startClock() {
    if (clockTimer || window.WF.paused) return;
    tickClock();
    clockTimer = window.setInterval(tickClock, 1000);
  }

  function stopClock() {
    if (clockTimer) window.clearInterval(clockTimer);
    clockTimer = null;
  }

  function paintPause() {
    root.classList.toggle('is-paused', !!window.WF.paused);
    if (window.WF.paused) stopClock();
    else startClock();
  }

  function init() {
    root = document.getElementById('footer-root');
    if (!root) return;
    root.innerHTML = switchHTML() + VARIANTS.map(function (v) { return panelFor(v.id); }).join('');

    var bar = root.querySelector('.wf-vswitch');
    bar.addEventListener('click', onTabClick);
    bar.addEventListener('keydown', onTabKey);

    select(startVariant(), false);
    paintSide();
    paintPause();
    setupReveal();

    document.addEventListener('wf:side', function (e) {
      if (e.detail && e.detail.side) window.WF.side = e.detail.side;
      paintSide();
    });
    document.addEventListener('wf:pause', function () { window.WF.paused = true; paintPause(); });
    document.addEventListener('wf:play', function () { window.WF.paused = false; paintPause(); });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
