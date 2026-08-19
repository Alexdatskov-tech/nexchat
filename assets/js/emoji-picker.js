/* Shared emoji picker.

   Usage:  EmojiPicker.open(anchorEl, (emoji) => { ... })

   Renders the full catalogue from emoji-data.js with a search box and
   category rail, in CLDR order -- the same order Android and Windows use.
   The grid is built once and cached; filtering only toggles visibility,
   so searching ~1900 nodes stays instant.  */
(function () {
  const RECENT_KEY = 'nx.emoji.recent';
  const RECENT_MAX = 36;
  let el = null;         // the panel
  let built = false;     // grid has been rendered once
  let onPick = null;
  let anchor = null;

  const recents = () => {
    try { return JSON.parse(localStorage.getItem(RECENT_KEY)) || []; } catch { return []; }
  };
  const remember = (e) => {
    const list = [e, ...recents().filter((x) => x !== e)].slice(0, RECENT_MAX);
    try { localStorage.setItem(RECENT_KEY, JSON.stringify(list)); } catch { /* private mode */ }
  };

  function build() {
    const E = window.EMOJI;
    if (!E) { console.error('EmojiPicker: emoji-data.js not loaded'); return; }

    el = document.createElement('div');
    el.className = 'emoji-pick';
    el.innerHTML = `
      <div class="ep-search">
        <i class="fa-solid fa-magnifying-glass"></i>
        <input type="text" placeholder="Search emoji" spellcheck="false" autocomplete="off">
        <button class="ep-clear" title="Clear" hidden><i class="fa-solid fa-xmark"></i></button>
      </div>
      <div class="ep-rail"></div>
      <div class="ep-body"><div class="ep-grid"></div><div class="ep-none" hidden>No emoji found</div></div>
      <div class="ep-foot"><span class="ep-prev"></span><span class="ep-name">Pick an emoji</span></div>`;

    const rail = el.querySelector('.ep-rail');
    const grid = el.querySelector('.ep-grid');

    // Category rail: recents first, then the nine standard groups.
    const cats = [{ key: 'recent', name: 'Frequently used', icon: 'fa-clock-rotate-left' }, ...E.groups];
    rail.innerHTML = cats.map((g, i) =>
      `<button class="ep-cat${i === 0 ? ' on' : ''}" data-g="${i - 1}" title="${g.name}"><i class="fa-solid ${g.icon}"></i></button>`
    ).join('');

    // One buffer for the whole grid -- innerHTML per group would reflow 10x.
    const parts = [];
    parts.push('<div class="ep-sec" data-g="-1"><div class="ep-h">Frequently used</div><div class="ep-row" id="ep-recent"></div></div>');
    E.groups.forEach((g, gi) => {
      const items = E.list.filter((x) => x[2] === gi);
      parts.push(`<div class="ep-sec" data-g="${gi}"><div class="ep-h">${g.name}</div><div class="ep-row">` +
        items.map((x) => `<button class="ep-e" data-e="${x[0]}" data-n="${x[1]}" data-k="${x[3]}" title="${x[1]}">${x[0]}</button>`).join('') +
        '</div></div>');
    });
    grid.innerHTML = parts.join('');

    const input = el.querySelector('input');
    const clear = el.querySelector('.ep-clear');
    const none = el.querySelector('.ep-none');
    const nameOut = el.querySelector('.ep-name');
    const prevOut = el.querySelector('.ep-prev');

    function filter(qRaw) {
      const q = qRaw.trim().toLowerCase();
      clear.hidden = !q;
      let shown = 0;
      if (!q) {
        const res = el.querySelector('.ep-results');
        if (res) res.remove();
        el.querySelectorAll('.ep-e').forEach((b) => { b.hidden = false; });
        el.querySelectorAll('.ep-sec').forEach((s) => { s.hidden = false; });
        paintRecent();
        none.hidden = true;
        return;
      }
      // Ranked results, best first, in a single flat list. Without ranking
      // "fire" surfaces "heart on fire" above plain 🔥 purely because it
      // sorts earlier in the catalogue.
      //   0 exact name        1 name starts with q
      //   2 a name word starts with q   3 name contains q
      //   4 a keyword starts with q     5 keyword contains q
      const hits = [];
      el.querySelectorAll('.ep-e').forEach((b) => {
        const n = b.dataset.n;
        const k = b.dataset.k;
        let r = -1;
        if (n === q) r = 0;
        else if (n.startsWith(q)) r = 1;
        else if (n.includes(' ' + q)) r = 2;
        else if (n.includes(q)) r = 3;
        else if (k) {
          if (k.startsWith(q) || k.includes(' ' + q)) r = 4;
          else if (k.includes(q)) r = 5;
        }
        b.hidden = true;
        if (r >= 0) hits.push([r, b]);
      });
      hits.sort((a, b2) => a[0] - b2[0]);
      shown = hits.length;

      // Collapse the category sections and show one "Results" strip.
      el.querySelectorAll('.ep-sec').forEach((s) => { s.hidden = true; });
      let res = el.querySelector('.ep-results');
      if (!res) {
        res = document.createElement('div');
        res.className = 'ep-sec ep-results';
        res.innerHTML = '<div class="ep-h">Results</div><div class="ep-row"></div>';
        el.querySelector('.ep-grid').prepend(res);
      }
      const rrow = res.querySelector('.ep-row');
      rrow.innerHTML = '';
      // Cap the DOM work; nobody scrolls past 200 search hits.
      hits.slice(0, 200).forEach(([, b]) => {
        const c = b.cloneNode(true);
        c.hidden = false;
        rrow.appendChild(c);
      });
      res.hidden = !shown;
      none.hidden = shown > 0;
    }

    function paintRecent() {
      const box = el.querySelector('#ep-recent');
      const list = recents();
      const sec = box.closest('.ep-sec');
      if (!list.length) { sec.hidden = true; return; }
      sec.hidden = false;
      box.innerHTML = list.map((e) => {
        const meta = window.EMOJI.list.find((x) => x[0] === e);
        return `<button class="ep-e" data-e="${e}" data-n="${meta ? meta[1] : ''}" data-k="" title="${meta ? meta[1] : ''}">${e}</button>`;
      }).join('');
    }

    input.addEventListener('input', () => filter(input.value));
    clear.onclick = () => { input.value = ''; filter(''); input.focus(); };

    // Enter picks the first visible match -- type "joy", hit enter, done.
    input.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape') { ev.stopPropagation(); close(); return; }
      if (ev.key !== 'Enter') return;
      const first = [...el.querySelectorAll('.ep-e')].find((b) => !b.hidden && b.offsetParent !== null);
      if (first) { ev.preventDefault(); choose(first.dataset.e); }
    });

    grid.addEventListener('click', (ev) => {
      const b = ev.target.closest('.ep-e');
      if (b) { ev.stopPropagation(); choose(b.dataset.e); }
    });
    grid.addEventListener('mouseover', (ev) => {
      const b = ev.target.closest('.ep-e');
      if (!b) return;
      prevOut.textContent = b.dataset.e;
      nameOut.textContent = b.dataset.n || '';
    });

    rail.addEventListener('click', (ev) => {
      const b = ev.target.closest('.ep-cat');
      if (!b) return;
      const sec = grid.querySelector(`.ep-sec[data-g="${b.dataset.g}"]`);
      if (sec) sec.scrollIntoView({ block: 'start' });
    });

    // Highlight the rail button for whatever section is at the top.
    el.querySelector('.ep-body').addEventListener('scroll', () => {
      const top = el.querySelector('.ep-body').getBoundingClientRect().top;
      let cur = null;
      el.querySelectorAll('.ep-sec').forEach((s) => {
        if (!s.hidden && s.getBoundingClientRect().top - top <= 8) cur = s.dataset.g;
      });
      if (cur === null) return;
      rail.querySelectorAll('.ep-cat').forEach((b) => b.classList.toggle('on', b.dataset.g === cur));
    }, { passive: true });

    built = true;
    paintRecent();
  }

  function choose(e) {
    remember(e);
    const cb = onPick;
    close();
    if (cb) cb(e);
  }

  function place() {
    if (!el || !anchor) return;
    const r = anchor.getBoundingClientRect();
    const w = el.offsetWidth || 340, h = el.offsetHeight || 400;
    const pad = 8;
    // Prefer above the anchor, flip below when there is no room.
    let top = r.top - h - pad;
    if (top < pad) top = Math.min(r.bottom + pad, window.innerHeight - h - pad);
    let left = r.left + r.width / 2 - w / 2;
    left = Math.max(pad, Math.min(left, window.innerWidth - w - pad));
    el.style.top = `${Math.max(pad, top)}px`;
    el.style.left = `${left}px`;
  }

  function onDocDown(ev) {
    if (!el) return;
    if (el.contains(ev.target) || (anchor && anchor.contains(ev.target))) return;
    close();
  }
  function onKey(ev) { if (ev.key === 'Escape') close(); }

  function open(anchorEl, cb) {
    // Second click on the same button closes it.
    if (el && el.isConnected && anchor === anchorEl) { close(); return; }
    close();
    if (!built) build();
    if (!el) return;
    anchor = anchorEl;
    onPick = cb;
    document.body.appendChild(el);
    el.querySelector('input').value = '';
    el.querySelector('.ep-clear').hidden = true;
    el.querySelector('.ep-results')?.remove();   // stale hits from last time
    el.querySelectorAll('.ep-e').forEach((b) => { b.hidden = false; });
    el.querySelectorAll('.ep-sec').forEach((s) => { s.hidden = false; });
    el.querySelector('.ep-none').hidden = true;
    el.querySelector('#ep-recent').closest('.ep-sec').hidden = !recents().length;
    if (built) {
      const box = el.querySelector('#ep-recent');
      const list = recents();
      box.innerHTML = list.map((e) => {
        const meta = window.EMOJI.list.find((x) => x[0] === e);
        return `<button class="ep-e" data-e="${e}" data-n="${meta ? meta[1] : ''}" data-k="" title="${meta ? meta[1] : ''}">${e}</button>`;
      }).join('');
    }
    el.querySelector('.ep-body').scrollTop = 0;
    place();
    // Only focus the search on pointer devices; on touch it would slam a
    // keyboard over the grid the moment the picker opens.
    if (!window.matchMedia('(hover: none)').matches) el.querySelector('input').focus();
    setTimeout(() => {
      document.addEventListener('mousedown', onDocDown);
      document.addEventListener('keydown', onKey);
      window.addEventListener('resize', place);
    }, 0);
  }

  function close() {
    document.removeEventListener('mousedown', onDocDown);
    document.removeEventListener('keydown', onKey);
    window.removeEventListener('resize', place);
    if (el && el.isConnected) el.remove();
    anchor = null; onPick = null;
  }

  window.EmojiPicker = { open, close };
})();
