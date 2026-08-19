(function () {
  const $ = (id) => document.getElementById(id);
  const S3 = () => window.__nx_tp;
  let me = null, srv = null, serverId = null;
  let channels = [], active = null, sub = null, canManage = false;
  let voiceChan = null, voicePoll = null;
  const profiles = {}, rx = {}, attCache = {};
  const painting = new Set();   // in-flight appendMessage ids (dedupe guard)
  let pending = [];   // files staged in the composer

  const QUICK = ['👍', '🔥', '😂', '❤️', '😮', '🎉'];

  async function profileOf(id) {
    if (profiles[id]) return profiles[id];
    const { data } = await window.db.from('profiles')
      .select('id,username,display_name,avatar_url,accent_color,is_nitro').eq('id', id).single();
    profiles[id] = data || { username: 'unknown', display_name: 'Unknown' };
    return profiles[id];
  }

  /* ================= channels ================= */
  const chanIcon = (t) => t === 'voice' ? 'fa-volume-high' : t === 'stage' ? 'fa-tower-broadcast'
    : t === 'announcement' ? 'fa-bullhorn' : 'fa-hashtag';

  function renderChannels() {
    const cats = channels.filter((c) => c.type === 'category').sort((a, b) => a.position - b.position);
    const loose = channels.filter((c) => c.type !== 'category' && !c.parent_id).sort((a, b) => a.position - b.position);
    const vs = Voice.state();

    const item = (c) => {
      const isVoice = c.type === 'voice' || c.type === 'stage';
      const inHere = vs.active && vs.channel?.id === c.id;
      let occupants = '';
      if (isVoice && inHere) {
        occupants = `<div class="vc-users">${[...vs.members.values()].map((p) => `
          <div class="vc-user" data-u="${p.id}">
            ${UI.avatar(p, 21, { halo: false })}
            <span>${MD.esc(p.display_name || p.username)}</span>
            <span class="vflags">
              ${p.muted ? '<i class="fa-solid fa-microphone-slash off"></i>' : ''}
              ${p.deaf ? '<i class="fa-solid fa-headphones-simple off"></i>' : ''}
              ${p.cam ? '<i class="fa-solid fa-video"></i>' : ''}
              ${p.sharing ? '<i class="fa-solid fa-display"></i>' : ''}
            </span>
          </div>`).join('')}</div>`;
      }
      const cls = [c.id === active?.id ? 'on' : '', inHere ? 'connected' : ''].filter(Boolean).join(' ');
      return `<div class="chan ${cls}" data-id="${c.id}" data-voice="${isVoice}">
          <i class="fa-solid ${chanIcon(c.type)}"></i><span>${MD.esc(c.name)}</span>${inHere ? '<span class="live-dot"></span>' : ''}
        </div>${occupants}`;
    };

    let html = loose.map(item).join('');
    cats.forEach((cat) => {
      const kids = channels.filter((c) => c.parent_id === cat.id).sort((a, b) => a.position - b.position);
      html += `<div class="cat"><i class="fa-solid fa-chevron-down"></i>${MD.esc(cat.name)}</div>
               <div class="cat-kids">${kids.map(item).join('')}</div>`;
    });
    $('chanList').innerHTML = html || '<div style="padding:14px 8px;font-size:12.5px;color:var(--txt-3);">No channels yet.</div>';

    $('chanList').querySelectorAll('.cat').forEach((el) => { el.onclick = () => el.classList.toggle('shut'); });
    $('chanList').querySelectorAll('.chan').forEach((el) => {
      el.onclick = () => {
        const c = channels.find((x) => x.id === el.dataset.id);
        if (!c) return;
        if (el.dataset.voice === 'true') return joinVoice(c);
        open(c);
        $('rail').classList.remove('open');
        document.querySelector('.rail-scrim')?.remove();
      };
    });
  }

  async function loadChannels(selectId) {
    const { data, error } = await window.db.from('channels').select('*').eq('server_id', serverId).order('position');
    if (error) return UI.toast('Could not load channels.', true);
    channels = data;
    renderChannels();
    const pick = (selectId && channels.find((c) => c.id === selectId))
      || channels.find((c) => c.type === 'text' || c.type === 'announcement');
    if (pick) open(pick); else { $('composer').classList.add('hidden'); $('msgs').innerHTML = ''; }
  }

  async function open(ch) {
    if (!ch || ch.type === 'voice' || ch.type === 'stage') return;
    active = ch;
    renderChannels();
    $('chIco').innerHTML = `<i class="fa-solid ${chanIcon(ch.type)}"></i>`;
    $('chName').textContent = ch.name;
    $('chTopic').textContent = ch.topic || '';
    $('chTopic').classList.toggle('hidden', !ch.topic);
    $('input').placeholder = `Message #${ch.name}`;
    if (vrOpen) showVoiceRoom(false);
    $('composer').classList.remove('hidden');
    await loadMessages(ch.id);
    listen(ch.id);
  }

  /* ================= messages ================= */
  const intro = () => `<div class="msgs-top">
      <div class="big-ico"><i class="fa-solid ${chanIcon(active.type)}"></i></div>
      <h2>Welcome to #${MD.esc(active.name)}</h2>
      <p>${active.topic ? MD.esc(active.topic) : 'This is the start of the channel.'}</p>
    </div>`;

  function rxHtml(id) {
    const m = rx[id];
    if (!m || !Object.keys(m).length) return '';
    return `<div class="rx-row">${Object.entries(m).map(([e, v]) =>
      `<button class="rx ${v.mine ? 'mine' : ''}" data-m="${id}" data-e="${MD.esc(e)}">${e}<b>${v.n}</b></button>`).join('')}</div>`;
  }

  function row(m, grouped) {
    const p = profiles[m.author_id] || { username: 'unknown' };
    const name = p.display_name || p.username;
    const mine = m.author_id === me.id;
    const left = grouped
      ? `<div class="m-gutter"><span class="hovertime">${new Date(m.created_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</span></div>`
      : `<div class="m-av" data-u="${m.author_id}" style="cursor:pointer">${UI.avatar(p, 38, { presence: true })}</div>`;
    const head = grouped ? '' :
      `<div class="m-head"><span class="m-name" data-u="${m.author_id}" style="cursor:pointer;color:${p.accent_color || 'var(--txt-1)'}">${MD.esc(name)}</span>
       ${p.is_nitro ? '<span class="badge badge-nitro"><i class="fa-solid fa-bolt"></i></span>' : ''}
       <span class="m-time">${UI.timeLabel(m.created_at)}</span></div>`;

    return `<div class="m ${grouped ? 'grp' : ''}" data-id="${m.id}" data-au="${m.author_id}" data-ts="${m.created_at}">
      ${left}
      <div class="m-main">
        ${head}
        <div class="m-text" data-raw="${MD.esc(m.content || '')}">${MD.render(m.content)}${m.edited_at ? '<span class="m-edited">(edited)</span>' : ''}</div>
        <div class="atts" data-atts="${m.id}"></div>
        <div class="rx-slot">${rxHtml(m.id)}</div>
      </div>
      <div class="m-acts">
        <button class="a-rx" title="React"><i class="fa-regular fa-face-smile"></i></button>
        ${mine ? '<button class="a-ed" title="Edit"><i class="fa-solid fa-pen"></i></button>' : ''}
        ${mine || canManage ? '<button class="a-del del" title="Delete"><i class="fa-solid fa-trash-can"></i></button>' : ''}
      </div>
    </div>`;
  }

  function paintAtts(mid) {
    const host = document.querySelector(`[data-atts="${mid}"]`);
    if (!host) return;
    host.innerHTML = '';
    const msgAuthor = document.querySelector(`.m[data-id="${mid}"]`)?.dataset.au;
    const canRemove = msgAuthor === me.id || canManage;
    (attCache[mid] || []).forEach((a) => {
      host.appendChild(Viewer.renderWithControls({ ...a, _dm: false }, canRemove, () => {
        attCache[mid] = (attCache[mid] || []).filter((x) => x.id !== a.id);
      }));
    });
  }

  const grouped = (pa, pt, m) => pa === m.author_id && (new Date(m.created_at) - new Date(pt)) < 5 * 60 * 1000;

  /* Flip a rendered row between full (avatar + name) and compact form. */
  function setGrouped(el, grp) {
    if (el.classList.contains('grp') === grp) return;
    const uid = el.dataset.au, ts = el.dataset.ts;
    const p = profiles[uid] || { username: 'unknown' };
    const name = p.display_name || p.username;
    const first = el.firstElementChild;

    if (grp) {
      first.outerHTML = `<div class="m-gutter"><span class="hovertime">${new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</span></div>`;
      el.querySelector('.m-head')?.remove();
      el.classList.add('grp');
    } else {
      first.outerHTML = `<div class="m-av" data-u="${uid}" style="cursor:pointer">${UI.avatar(p, 38)}</div>`;
      if (!el.querySelector('.m-head')) {
        el.querySelector('.m-main').insertAdjacentHTML('afterbegin',
          `<div class="m-head"><span class="m-name" data-u="${uid}" style="cursor:pointer;color:${p.accent_color || 'var(--txt-1)'}">${MD.esc(name)}</span>
           ${p.is_nitro ? '<span class="badge badge-nitro"><i class="fa-solid fa-bolt"></i></span>' : ''}
           <span class="m-time">${UI.timeLabel(ts)}</span></div>`);
      }
      el.classList.remove('grp');
    }
    wire(el);
  }

  /* Re-derive grouping across the whole list. Called after any removal so a
     deleted header message doesn't leave the ones below it nameless. */
  function regroup() {
    let pa = null, pt = 0;
    $('msgs').querySelectorAll('.m').forEach((el) => {
      const grp = pa === el.dataset.au && (new Date(el.dataset.ts) - new Date(pt)) < 5 * 60 * 1000;
      setGrouped(el, grp);
      pa = el.dataset.au; pt = el.dataset.ts;
    });
  }

  /* Remove the attachment objects from storage too, so deleting a message
     doesn't leave orphaned files sitting in the bucket forever. */
  async function purgeAttachments(mid) {
    const list = attCache[mid] || [];
    for (const a of list) {
      try {
        const key = decodeURIComponent(new URL(a.url).pathname.replace(/^\/[^/]+\//, ''));
        if (key) await window.__nx_tp.del(key);
      } catch {}
    }
    delete attCache[mid];
  }

  async function loadMessages(cid) {
    const box = $('msgs');
    box.innerHTML = `<div style="padding:16px;display:flex;flex-direction:column;gap:14px;">
      ${'<div class="skel" style="height:38px;"></div>'.repeat(4)}</div>`;

    const { data: msgs, error } = await window.db.from('messages')
      .select('*, profiles!author_id(id,username,display_name,avatar_url,accent_color,is_nitro)')
      .eq('channel_id', cid).order('created_at', { ascending: true }).limit(100);
    if (error) { box.innerHTML = ''; return UI.toast('Could not load messages: ' + error.message, true); }
    msgs.forEach((m) => { if (m.profiles) profiles[m.author_id] = m.profiles; });

    Object.keys(rx).forEach((k) => delete rx[k]);
    if (msgs.length) {
      const ids = msgs.map((m) => m.id);
      const [{ data: rr }, attRes] = await Promise.all([
        window.db.from('message_reactions').select('*').in('message_id', ids),
        window.db.from('message_attachments').select('*').in('message_id', ids).order('position', { ascending: true }),
      ]);
      let aa = attRes.data;
      if (attRes.error) {
        ({ data: aa } = await window.db.from('message_attachments')
          .select('*').in('message_id', ids).order('created_at', { ascending: true }));
      }
      (rr || []).forEach((r) => addRx(r.message_id, r.emoji, r.user_id));
      (aa || []).forEach((a) => { (attCache[a.message_id] = attCache[a.message_id] || []).push(a); });
    }

    let html = intro(), pa = null, pt = 0;
    msgs.forEach((m) => { html += row(m, grouped(pa, pt, m)); pa = m.author_id; pt = m.created_at; });
    box.innerHTML = html;
    msgs.forEach((m) => paintAtts(m.id));
    wire(box);
    box.scrollTop = box.scrollHeight;
  }

  function addRx(mid, e, uid) {
    rx[mid] = rx[mid] || {};
    rx[mid][e] = rx[mid][e] || { n: 0, mine: false, users: [] };
    const b = rx[mid][e];
    if (b.users.includes(uid)) return;
    b.users.push(uid); b.n = b.users.length;
    if (uid === me.id) b.mine = true;
  }
  function dropRx(mid, e, uid) {
    const b = rx[mid]?.[e]; if (!b) return;
    b.users = b.users.filter((u) => u !== uid); b.n = b.users.length;
    if (uid === me.id) b.mine = false;
    if (!b.n) delete rx[mid][e];
  }
  function repaintRx(mid) {
    const slot = document.querySelector(`.m[data-id="${mid}"] .rx-slot`);
    if (!slot) return;
    slot.innerHTML = rxHtml(mid);
    slot.querySelectorAll('.rx').forEach((b) => { b.onclick = () => toggleRx(b.dataset.m, b.dataset.e); });
  }

  // Accepts either a container OR a single .m element, so realtime inserts wire up too.
  function wire(scope) {
    const rows = scope.classList?.contains('m') ? [scope] : [...scope.querySelectorAll('.m')];
    scope.querySelectorAll?.('.rx').forEach((b) => { b.onclick = () => toggleRx(b.dataset.m, b.dataset.e); });
    scope.querySelectorAll?.('.spoil').forEach((s) => { s.onclick = () => s.classList.add('shown'); });
    rows.forEach((el) => {
      const id = el.dataset.id;
      el.querySelectorAll('.rx').forEach((b) => { b.onclick = () => toggleRx(b.dataset.m, b.dataset.e); });
      el.querySelectorAll('.spoil').forEach((s) => { s.onclick = () => s.classList.add('shown'); });
      el.querySelectorAll('[data-u]').forEach((x) => {
        x.onclick = (ev) => { ev.stopPropagation(); UI.userCard(x.dataset.u, { serverId }); };
      });
      if (window.matchMedia('(hover: none)').matches) {
        el.addEventListener('click', (ev) => {
          if (ev.target.closest('.m-acts, a, .rx, .spoil, button, video, audio, input, [data-u]')) return;
          const was = el.classList.contains('tapped');
          document.querySelectorAll('.m.tapped').forEach((x) => x.classList.remove('tapped'));
          el.classList.toggle('tapped', !was);
        });
      }
      const rxb = el.querySelector('.a-rx');
      if (rxb) rxb.onclick = (ev) => { ev.stopPropagation(); picker(ev.currentTarget, el, id); };
      const edb = el.querySelector('.a-ed');
      if (edb) edb.onclick = (ev) => { ev.stopPropagation(); edit(el, id); };
      const dlb = el.querySelector('.a-del');
      if (dlb) dlb.onclick = async (ev) => {
        ev.stopPropagation();
        const n = (attCache[id] || []).length;
        const body = n ? `This removes the message and its ${n} file${n === 1 ? '' : 's'} for everyone.`
                       : 'This removes it for everyone.';
        if (!await UI.confirmDialog('Delete message', body, true)) return;
        const { error } = await window.db.from('messages').delete().eq('id', id);
        if (error) {
          UI.toast(/policy|permission|row-level/i.test(error.message)
            ? 'You don\u2019t have permission to delete that message.'
            : error.message, true);
          return;
        }
        purgeAttachments(id);
        document.querySelector(`.m[data-id="${id}"]`)?.remove();
        regroup();
      };
    });
  }

  function picker(btn, rowEl, mid) {
    document.querySelectorAll('.picker').forEach((p) => p.remove());
    const p = document.createElement('div');
    p.className = 'picker';
    p.innerHTML = QUICK.map((e) => `<button data-e="${e}">${e}</button>`).join('')
      + '<span class="pk-sep"></span>'
      + '<button class="pk-more" title="More emoji"><i class="fa-solid fa-plus"></i></button>';
    rowEl.appendChild(p);
    p.querySelectorAll('button[data-e]').forEach((b) => {
      b.onclick = (ev) => { ev.stopPropagation(); toggleRx(mid, b.dataset.e); p.remove(); };
    });
    // "+" hands off to the full searchable catalogue.
    p.querySelector('.pk-more').onclick = (ev) => {
      ev.stopPropagation();
      p.remove();
      // Anchor on the message's react button: `p` is gone by now, so a
      // child of it would measure as a zero-size rect at 0,0.
      window.EmojiPicker?.open(btn, (emoji) => toggleRx(mid, emoji));
    };
    setTimeout(() => document.addEventListener('click', function off(ev) {
      if (!p.contains(ev.target) && !btn.contains(ev.target)) { p.remove(); document.removeEventListener('click', off); }
    }), 0);
  }

  async function toggleRx(mid, emoji) {
    const mine = rx[mid]?.[emoji]?.mine;
    if (mine) {
      dropRx(mid, emoji, me.id); repaintRx(mid);
      const { error } = await window.db.from('message_reactions')
        .delete().eq('message_id', mid).eq('user_id', me.id).eq('emoji', emoji);
      if (error) { addRx(mid, emoji, me.id); repaintRx(mid); UI.toast(error.message, true); }
    } else {
      addRx(mid, emoji, me.id); repaintRx(mid);
      const { error } = await window.db.from('message_reactions')
        .insert({ message_id: mid, user_id: me.id, emoji });
      if (error) { dropRx(mid, emoji, me.id); repaintRx(mid); UI.toast(error.message, true); }
    }
  }

  function edit(el, id) {
    if (el.querySelector('.editbox')) return;
    const textEl = el.querySelector('.m-text');
    if (!textEl) return;
    const ta = document.createElement('textarea');
    const box = document.createElement('div');
    box.className = 'editbox';
    const small = document.createElement('small');
    small.textContent = 'Enter to save · Esc to cancel';
    box.append(ta, small);
    ta.rows = 2;
    ta.value = new DOMParser().parseFromString(textEl.dataset.raw, 'text/html').documentElement.textContent;
    textEl.replaceWith(box);
    ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length);
    ta.style.height = Math.min(ta.scrollHeight, 200) + 'px';

    ta.onkeydown = async (e) => {
      if (e.key === 'Escape') return box.replaceWith(textEl);
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        const v = ta.value.trim();
        if (!v) return;
        const { error } = await window.db.from('messages')
          .update({ content: v, edited_at: new Date().toISOString() }).eq('id', id);
        if (error) { UI.toast(error.message, true); return; }
        textEl.dataset.raw = MD.esc(v);
        textEl.innerHTML = MD.render(v) + '<span class="m-edited">(edited)</span>';
        box.replaceWith(textEl);
        wire(el);
      }
    };
  }

  /* ================= message painting + catch-up =================
     Rendering a message must never depend on the realtime echo coming back.
     Everything below (realtime, the catch-up poller, and your own send) funnels
     through appendMessage, so a message shows up even if the socket is down. */

  async function appendMessage(m) {
    const box = $('msgs');
    if (!box || !active) return null;
    if (m.channel_id && m.channel_id !== active.id) return null;
    if (document.querySelector(`.m[data-id="${m.id}"]`) || painting.has(m.id)) return null;
    painting.add(m.id);
    try {
    await profileOf(m.author_id);
    if (document.querySelector(`.m[data-id="${m.id}"]`)) return null;
    const stick = box.scrollHeight - box.scrollTop - box.clientHeight < 180;
    const last = box.querySelector('.m:last-of-type');
    box.insertAdjacentHTML('beforeend', row(m, last ? grouped(last.dataset.au, last.dataset.ts, m) : false));
    const el = box.lastElementChild;
    wire(el);
    if (stick || m.author_id === me.id) box.scrollTop = box.scrollHeight;
    return el;
    } finally { painting.delete(m.id); }
  }

  async function hydrateAtts(mid, watch) {
    let { data: aa, error } = await window.db.from('message_attachments')
      .select('*').eq('message_id', mid).order('position', { ascending: true });
    if (error) ({ data: aa } = await window.db.from('message_attachments').select('*').eq('message_id', mid));
    if (aa?.length) { attCache[mid] = aa; paintAtts(mid); }
    if (!watch) return;
    // Re-check briefly: uploads finish after the message row is written.
    [600, 1800, 4000].forEach((d) => setTimeout(async () => {
      if (!document.querySelector(`.m[data-id="${mid}"]`)) return;
      const { data: later } = await window.db.from('message_attachments')
        .select('*').eq('message_id', mid).order('position', { ascending: true });
      if (later && later.length !== (attCache[mid] || []).length) {
        attCache[mid] = later; paintAtts(mid);
      }
    }, d));
  }

  const newestTs = () => {
    const rows = $('msgs')?.querySelectorAll('.m');
    return rows?.length ? rows[rows.length - 1].dataset.ts : null;
  };

  /* Pulls anything posted since the newest row we already show. This is what
     keeps the channel live when the websocket can't connect. */
  let catching = false;
  async function catchUp() {
    if (catching || !active || document.hidden) return;
    catching = true;
    const cid = active.id, since = newestTs();
    try {
      let q = window.db.from('messages')
        .select('*, profiles!author_id(id,username,display_name,avatar_url,accent_color,is_nitro)')
        .eq('channel_id', cid).order('created_at', { ascending: true }).limit(50);
      if (since) q = q.gt('created_at', since);
      const { data, error } = await q;
      if (!error && data?.length) {
        for (const m of data) {
          if (!active || active.id !== cid) return;
          if (m.profiles) profiles[m.author_id] = m.profiles;
          if (await appendMessage(m)) await hydrateAtts(m.id, false);
        }
      }
      await catchUpEdits(cid);
      await catchUpRx(cid);
    } finally { catching = false; }
  }

  /* Reconciles edits and deletes for the messages currently on screen.

     The watermark query above only ever looks for rows *newer* than the
     last one shown, so a message that was edited or removed after we
     rendered it is invisible to it -- which is why those still needed a
     refresh. Here we re-read the visible ids: whatever comes back gets its
     text refreshed if the content changed, and any id that does NOT come
     back has been deleted, so its row goes. */
  async function catchUpEdits(cid) {
    const els = [...document.querySelectorAll('#msgs .m[data-id]')];
    if (!els.length) return;
    const ids = els.slice(-60).map((el) => el.dataset.id);
    const { data, error } = await window.db.from('messages')
      .select('id,content,edited_at').in('id', ids);
    if (error || !data || !active || active.id !== cid) return;

    const live = new Map(data.map((m) => [m.id, m]));
    let removed = false;

    for (const id of ids) {
      const el = document.querySelector(`.m[data-id="${id}"]`);
      if (!el) continue;
      const m = live.get(id);

      if (!m) {
        // Gone from the server -> gone from the screen.
        el.remove();
        delete attCache[id];
        delete rx[id];
        removed = true;
        continue;
      }

      // Don't clobber a message the user is actively editing.
      if (el.querySelector('.editbox')) continue;
      const cur = el.querySelector('.m-text');
      if (!cur) continue;

      // data-raw holds the escaped source, so comparing against it detects
      // a real content change without re-rendering markdown every poll.
      const nextRaw = MD.esc(m.content || '');
      const nextEdited = !!m.edited_at;
      const wasEdited = !!cur.querySelector('.m-edited');
      if (cur.dataset.raw === nextRaw && wasEdited === nextEdited) continue;

      cur.dataset.raw = nextRaw;
      cur.innerHTML = MD.render(m.content) + (nextEdited ? '<span class="m-edited">(edited)</span>' : '');
      wire(el);
    }

    if (removed) regroup();
  }

  /* Reconciles reactions for the messages currently on screen.

     Reactions can't be caught by a `created_at` watermark like messages:
     they are also *removed*, and an un-react leaves no row to find. So we
     re-read the full set for the visible messages and diff it against what
     we're showing, which picks up adds and removes in one pass. */
  async function catchUpRx(cid) {
    const ids = [...document.querySelectorAll('#msgs .m[data-id]')].map((el) => el.dataset.id);
    if (!ids.length) return;
    const { data, error } = await window.db.from('message_reactions')
      .select('message_id,emoji,user_id').in('message_id', ids.slice(-60));
    if (error || !data || !active || active.id !== cid) return;

    const fresh = {};
    data.forEach((r) => {
      ((fresh[r.message_id] = fresh[r.message_id] || {})[r.emoji] =
        fresh[r.message_id][r.emoji] || []).push(r.user_id);
    });

    for (const mid of ids) {
      const now = fresh[mid] || {};
      const had = rx[mid] || {};
      // Compare as a stable signature so we only touch the DOM on a change;
      // repainting every row every few seconds would kill hover states.
      const sig = (o) => Object.keys(o).sort()
        .map((e) => e + ':' + [...(o[e].users || o[e])].sort().join(',')).join('|');
      if (sig(now) === sig(had)) continue;
      if (!Object.keys(now).length) delete rx[mid];
      else {
        rx[mid] = {};
        for (const [e, users] of Object.entries(now)) {
          rx[mid][e] = { n: users.length, mine: users.includes(me.id), users: [...users] };
        }
      }
      repaintRx(mid);
    }
  }

  /* ================= realtime ================= */
  let rtHealthy = false, rtProven = false, pollTimer = null, pollRate = 0, retryTimer = null, retries = 0;

  /* Polling is never fully switched off.

     A channel can report SUBSCRIBED and still deliver nothing -- e.g.
     when the table is not in the `supabase_realtime` publication, or
     the socket is half-open behind a proxy. In that case an
     error-triggered fallback never fires and messages stop appearing
     until a refresh. So we always keep a reconcile loop running and
     merely slow it down while realtime looks healthy. appendMessage()
     dedupes by message id, so the overlap is free. */
  const POLL_FAST = 800;    // realtime is down / unproven -- sub-second so it feels live
  const POLL_IDLE = 8000;   // realtime has actually delivered, this is a safety net

  function setPolling(on) {
    const want = on ? POLL_FAST : POLL_IDLE;
    if (pollTimer && pollRate === want) return;
    if (pollTimer) clearInterval(pollTimer);
    pollRate = want;
    pollTimer = setInterval(catchUp, want);
  }

  function scheduleRetry(cid) {
    clearTimeout(retryTimer);
    const wait = Math.min(30000, 1000 * Math.pow(2, retries++));
    retryTimer = setTimeout(() => { if (active?.id === cid) listen(cid); }, wait);
  }

  function listen(cid) {
    if (sub) window.db.removeChannel(sub);
    clearTimeout(retryTimer);
    rtHealthy = false;
    sub = window.db.channel('ch:' + cid)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages', filter: `channel_id=eq.${cid}` }, async (p) => {
        // A delivered event is the only real proof realtime works.
        if (!rtProven) { rtProven = true; setPolling(false); }
        if (await appendMessage(p.new)) await hydrateAtts(p.new.id, true);
      })
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'messages', filter: `channel_id=eq.${cid}` }, (p) => {
        const m = p.new;
        const el = document.querySelector(`.m[data-id="${m.id}"]`);
        if (!el || el.querySelector('.editbox')) return;
        const cur = el.querySelector('.m-text');
        if (!cur) return;
        cur.dataset.raw = MD.esc(m.content || '');
        cur.innerHTML = MD.render(m.content) + (m.edited_at ? '<span class="m-edited">(edited)</span>' : '');
        wire(el);
      })
      .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'messages', filter: `channel_id=eq.${cid}` }, (p) => {
        document.querySelector(`.m[data-id="${p.old.id}"]`)?.remove();
        delete attCache[p.old.id];
        regroup();
      })
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'message_reactions' }, (p) => {
        if (!document.querySelector(`.m[data-id="${p.new.message_id}"]`)) return;
        addRx(p.new.message_id, p.new.emoji, p.new.user_id); repaintRx(p.new.message_id);
      })
      .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'message_reactions' }, (p) => {
        if (!document.querySelector(`.m[data-id="${p.old.message_id}"]`)) return;
        dropRx(p.old.message_id, p.old.emoji, p.old.user_id); repaintRx(p.old.message_id);
      })
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'message_attachments' }, async (p) => {
        const a = p.new;
        // Attachments are written after their message, so the message's own
        // INSERT event fires before any file rows exist. Listen for them too.
        if (!document.querySelector(`.m[data-id="${a.message_id}"]`)) return;
        const list = attCache[a.message_id] || [];
        if (list.some((x) => x.id === a.id)) return;
        list.push(a);
        list.sort((x, y) => (x.position ?? 0) - (y.position ?? 0)
          || new Date(x.created_at) - new Date(y.created_at));
        attCache[a.message_id] = list;
        paintAtts(a.message_id);
      })
      .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'message_attachments' }, (p) => {
        const mid = Object.keys(attCache).find((k) => (attCache[k] || []).some((x) => x.id === p.old.id));
        if (!mid) return;
        attCache[mid] = attCache[mid].filter((x) => x.id !== p.old.id);
        paintAtts(mid);
      })
      .subscribe((status) => {
        if (status === 'SUBSCRIBED') {
          // Socket is live. Poll slowly as a safety net and reconcile once now,
          // since anything posted while we were connecting was missed.
          rtHealthy = true; retries = 0;
          // Only trust it enough to back off once it has really delivered.
          setPolling(!rtProven);
          catchUp();
        } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
          // Realtime is unavailable (bad socket, RLS on the publication, project
          // paused, blocked WS). Keep the chat working by polling instead.
          rtHealthy = false;
          setPolling(true);
          catchUp();
          scheduleRetry(cid);
        }
      });

    // If the socket never reports SUBSCRIBED at all, start polling anyway.
    setTimeout(() => { if (!rtHealthy && active?.id === cid) { setPolling(true); catchUp(); } }, 4000);
  }

  // Coming back to the tab should immediately reconcile, not wait for a tick.
  document.addEventListener('visibilitychange', () => { if (!document.hidden) catchUp(); });
  window.addEventListener('online', () => { if (active) { catchUp(); listen(active.id); } });

  /* ================= composer + uploads ================= */
  function paintTray() {
    const t = $('tray');
    t.innerHTML = pending.map((f, i) => {
      const thumb = f._prev ? `<img src="${f._prev}">` : '<i class="fa-solid fa-file" style="color:var(--txt-3)"></i>';
      return `<div class="tray-item">${thumb}<span class="tn">${MD.esc(f.name)}</span>
        <span style="color:var(--txt-3);font-size:11px;">${Viewer.human(f.size)}</span>
        <button class="tx" data-i="${i}"><i class="fa-solid fa-xmark"></i></button></div>`;
    }).join('');
    t.classList.toggle('hidden', !pending.length);
    t.querySelectorAll('.tx').forEach((b) => {
      b.onclick = () => { pending.splice(+b.dataset.i, 1); paintTray(); };
    });
  }

  function stage(files) {
    [...files].forEach((f) => {
      if (f.size > 100 * 1024 * 1024) return UI.toast(`${f.name} is over 100 MB.`, true);
      if (/^image\//.test(f.type)) {
        const r = new FileReader();
        r.onload = (e) => { f._prev = e.target.result; paintTray(); };
        r.readAsDataURL(f);
      }
      pending.push(f);
    });
    paintTray();
  }

  function composer() {
    const ta = $('input');

    const send = async () => {
      const v = ta.value.trim();
      const files = pending.slice();
      if (!v && !files.length) return;
      if (!active) return;

      ta.value = ''; ta.style.height = 'auto';
      pending = []; paintTray();

      const { data: msg, error } = await window.db.from('messages')
        .insert({ channel_id: active.id, author_id: me.id, content: v || null }).select().single();
      if (error) { UI.toast(error.message, true); return; }

      // Paint our own message right away. Waiting on the realtime echo meant
      // that whenever the socket was down you couldn't even see what you sent.
      await appendMessage(msg);

      if (files.length) {
        const bar = $('upbar'); bar.classList.remove('hidden');
        const fill = bar.querySelector('i');
        let done = 0, ok = 0;
        for (const f of files) {
          try {
            const key = `nexchat/${serverId}/${active.id}/${Date.now()}-${f.name.replace(/[^\w.\-]/g, '_')}`;
            const up = await S3().put(key, f, (p) => {
              fill.style.width = Math.round(((done + p / 100) / files.length) * 100) + '%';
            });
            // position preserves the order files were attached, so an
            // image/pdf/image sequence stays image, pdf, image.
            const rowBase = {
              message_id: msg.id, url: up.url, file_name: f.name,
              file_size: f.size, mime_type: up.type,
            };
            // `position` keeps the exact send order. It only exists once
            // patch 3 has been applied, so fall back gracefully without it.
            let { error: aErr } = await window.db.from('message_attachments')
              .insert({ ...rowBase, position: files.indexOf(f) });
            if (aErr && /position/i.test(aErr.message || '')) {
              ({ error: aErr } = await window.db.from('message_attachments').insert(rowBase));
            }
            if (aErr) throw new Error(aErr.message);
            ok++;
          } catch (err) { UI.toast(`${f.name}: ${err.message}`, true); }
          done++;
          fill.style.width = Math.round((done / files.length) * 100) + '%';
        }
        setTimeout(() => { bar.classList.add('hidden'); fill.style.width = '0'; }, 400);

        // Nothing attached and nothing typed leaves an empty bubble — clean it up.
        if (!ok && !v) {
          await window.db.from('messages').delete().eq('id', msg.id);
          document.querySelector(`.m[data-id="${msg.id}"]`)?.remove();
          regroup();
          return;
        }

        let { data: aa } = await window.db.from('message_attachments')
          .select('*').eq('message_id', msg.id).order('position', { ascending: true });
        if (!aa) ({ data: aa } = await window.db.from('message_attachments').select('*').eq('message_id', msg.id));
        attCache[msg.id] = aa || [];
        paintAtts(msg.id);
      }
    };

    ta.oninput = () => { ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, 168) + 'px'; };
    ta.onkeydown = (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } };
    $('send').onclick = send;
    $('attachBtn').onclick = () => $('fileIn').click();
    $('fileIn').onchange = (e) => { stage(e.target.files); e.target.value = ''; };

    ta.addEventListener('paste', (e) => {
      const fs = [...(e.clipboardData?.files || [])];
      if (fs.length) { e.preventDefault(); stage(fs); }
    });
    const chat = document.querySelector('.chat');
    chat.addEventListener('dragover', (e) => { e.preventDefault(); });
    chat.addEventListener('drop', (e) => { e.preventDefault(); if (e.dataTransfer.files.length) stage(e.dataTransfer.files); });
  }

  /* ================= voice ================= */
  let vrOpen = false, speakSet = new Set();
  // Connection readouts are a developer-mode feature, off for everyone else.
  let devStats = false;

  function showVoiceRoom(on) {
    vrOpen = on;
    $('vroom').classList.toggle('hidden', !on);
    $('vstats').classList.toggle('hidden', !on || !devStats);
    $('msgs').classList.toggle('hidden', on);
    $('chatHead').classList.toggle('hidden', on);
    $('composer').classList.toggle('hidden', on || !active);
    $('stage').classList.add('hidden');
    if (on) paintRoom(Voice.state());
    else if (!active) {
      // Nothing was open behind the room — fall back to the first text channel.
      const first = channels.find((c) => c.type === 'text' || c.type === 'announcement');
      if (first) open(first);
    }
    renderChannels();
  }

  // Every participant can contribute two feeds: their camera and their screen.
  function feedsFor(p) {
    const isMe = p.id === me.id;
    const st = Voice.state();
    // Gate on what the peer says it is sending. Track-level `muted` isn't
    // dependable in Chrome, so an idle transceiver could still slip through as
    // an empty black tile — the broadcast flags are authoritative.
    const wantsCam = isMe ? st.cam : !!p.cam;
    const wantsScreen = isMe ? st.sharing : !!p.sharing;
    const hasLive = (s) => !!s && s.getVideoTracks().some((t) => t.readyState === 'live');
    const camS = wantsCam ? (isMe ? Voice.localCam() : Voice.peerCam(p.id)) : null;
    const scrS = wantsScreen ? (isMe ? Voice.localScreen() : Voice.peerScreen(p.id)) : null;

    const out = [];
    if (wantsScreen && hasLive(scrS)) out.push({ p, isMe, key: p.id + ':screen', stream: scrS, screen: true });
    if (wantsCam && hasLive(camS)) out.push({ p, isMe, key: p.id + ':cam', stream: camS, screen: false });
    if (!out.length) out.push({ p, isMe, key: p.id + ':av', stream: null, screen: false });
    return out;
  }

  function paintRoom(st) {
    if (!st.active) return;
    $('vrName').textContent = st.channel.name;
    $('vrSub').textContent = `${st.members.size} connected · ${srv.name}`;

    const set = (id, cls, cond, icon) => {
      const b = $(id);
      b.classList.remove('live', 'off');
      if (cond) b.classList.add(cls);
      if (icon) b.innerHTML = icon;
    };
    set('vrMute', 'off', st.muted, `<i class="fa-solid fa-microphone${st.muted ? '-slash' : ''}"></i>`);
    set('vrDeaf', 'off', st.deaf, `<i class="fa-solid fa-headphones-simple${st.deaf ? '' : ''}"></i>`);
    set('vrCam', 'live', st.cam);
    set('vrShare', 'live', st.sharing);
    $('vcMute').classList.toggle('on', st.muted);
    $('vcMute').innerHTML = `<i class="fa-solid fa-microphone${st.muted ? '-slash' : ''}"></i>`;
    $('vcDeaf').classList.toggle('on', st.deaf);
    $('vcCam').classList.toggle('on', st.cam);
    $('vcShare').classList.toggle('on', st.sharing);

    const grid = $('vrStage');
    const feeds = [...st.members.values()].flatMap(feedsFor);
    grid.classList.toggle('solo', feeds.length === 1);

    const seen = new Set();
    feeds.forEach((f) => {
      seen.add(f.key);
      let t = grid.querySelector(`[data-t="${f.key}"]`);
      if (!t) {
        t = document.createElement('div');
        t.className = 'vtile';
        t.dataset.t = f.key;
        t.innerHTML = `<video autoplay playsinline ${f.isMe ? 'muted' : ''}></video>
          <div class="vt-av"></div><div class="vt-name"></div>`;
        t.querySelector('.vt-av').onclick = () => UI.userCard(f.p.id, { serverId });
        grid.appendChild(t);
      }
      const v = t.querySelector('video');
      if (f.stream && v.srcObject !== f.stream) { v.srcObject = f.stream; v.play?.().catch(() => {}); }
      if (!f.stream) v.srcObject = null;
      v.style.display = f.stream ? '' : 'none';
      const avBox = t.querySelector('.vt-av');
      avBox.style.display = f.stream ? 'none' : '';
      if (!f.stream) avBox.innerHTML = UI.avatar(f.p, 76, { halo: false });
      t.querySelector('.vt-name').innerHTML =
        `${f.p.muted ? '<i class="fa-solid fa-microphone-slash off"></i>' : ''}<span>${MD.esc(f.p.display_name || f.p.username)}${f.isMe ? ' (you)' : ''}</span>`;
      t.querySelector('.vt-flag')?.remove();
      if (f.screen) t.insertAdjacentHTML('beforeend', '<span class="vt-flag">Screen</span>');
      t.classList.toggle('speaking', speakSet.has(f.p.id) && !f.p.muted);
    });
    [...grid.children].forEach((t) => { if (!seen.has(t.dataset.t)) t.remove(); });
  }

  function paintStats(st) {
    const bar = $('vstats');
    if (!vrOpen || !devStats) { bar.classList.add('hidden'); return; }
    bar.classList.remove('hidden');
    const rttCls = st.rtt === 0 ? '' : st.rtt < 60 ? 'good' : st.rtt < 160 ? 'warn' : 'bad';
    bar.innerHTML = `
      <span class="st ${st.res ? 'good' : ''}"><i class="fa-solid fa-display"></i> Video <b>${st.res || 'off'}</b></span>
      <span class="st"><i class="fa-solid fa-film"></i> <b>${st.fps || 0}</b> fps</span>
      <span class="st"><i class="fa-solid fa-video"></i> <b>${st.vkbps || 0}</b> kbps</span>
      <span class="st good"><i class="fa-solid fa-waveform-lines"></i> Audio <b>${st.akbps || 0}</b> kbps</span>
      <span class="st"><i class="fa-solid fa-music"></i> <b>${MD.esc(st.codec || 'Opus stereo 48kHz')}</b></span>
      <span class="spacer"></span>
      <span class="st ${rttCls}"><i class="fa-solid fa-tower-broadcast"></i> <b>${st.rtt || 0}</b> ms</span>`;
  }

  function paintVoice(st) {
    renderChannels();
    const dock = $('vcDock');
    if (!st.active) {
      dock.classList.add('hidden');
      $('stage').classList.add('hidden');
      if (vrOpen) showVoiceRoom(false);
      return;
    }
    dock.classList.remove('hidden');
    $('vcName').textContent = st.channel.name;
    $('vcCount').textContent = `${st.members.size} connected · ${srv.name}`;
    if (vrOpen) paintRoom(st);
    else {
      $('vcMute').classList.toggle('on', st.muted);
      $('vcMute').innerHTML = `<i class="fa-solid fa-microphone${st.muted ? '-slash' : ''}"></i>`;
      $('vcDeaf').classList.toggle('on', st.deaf);
      $('vcCam').classList.toggle('on', st.cam);
      $('vcShare').classList.toggle('on', st.sharing);
    }
  }

  function onSpeaking(set) {
    speakSet = set;
    if (vrOpen) {
      document.querySelectorAll('.vtile').forEach((t) => {
        const p = Voice.state().members.get(t.dataset.t);
        t.classList.toggle('speaking', set.has(t.dataset.t) && !p?.muted);
      });
    }
    document.querySelectorAll('.vc-user').forEach((u) => u.classList.toggle('speaking', set.has(u.dataset.u)));
  }

  async function joinVoice(ch) {
    const st = Voice.state();
    // Already in this room — just bring the room view back up.
    if (st.active && st.channel.id === ch.id) { showVoiceRoom(true); return; }
    if (st.active) await Voice.leave();
    try {
      await Voice.join(ch, serverId, { ...me, muted: false, deaf: false, cam: false, sharing: false },
                       paintVoice, onSpeaking, paintStats);
      showVoiceRoom(true);
    } catch { /* mic denied — Voice already surfaced the reason */ }
  }

  /* Asks what to share before handing off to the browser's own picker. */
  function openSharePicker() {
    if (Voice.state().sharing) { Voice.stopShare(); UI.toast('Stopped sharing.'); return; }
    if (!Voice.screenSupported()) {
      UI.toast('Screen sharing needs a desktop browser — this device doesn\u2019t support it.', true);
      return;
    }
    const m = $('mShare');
    $('shareErr').textContent = '';
    m.classList.remove('hidden');
  }

  function shareModal() {
    const m = $('mShare');
    m.querySelectorAll('[data-close]').forEach((b) => { b.onclick = () => m.classList.add('hidden'); });
    m.onclick = (e) => { if (e.target === m) m.classList.add('hidden'); };

    $('shareOpts').querySelectorAll('.share-opt').forEach((b) => {
      b.onclick = () => {
        $('shareOpts').querySelectorAll('.share-opt').forEach((x) => x.classList.remove('on'));
        b.classList.add('on');
      };
    });
    $('shareQ').querySelectorAll('button').forEach((b) => {
      b.onclick = () => {
        $('shareQ').querySelectorAll('button').forEach((x) => x.classList.remove('on'));
        b.classList.add('on');
      };
    });

    $('shareGo').onclick = async () => {
      const surface = $('shareOpts').querySelector('.share-opt.on')?.dataset.s || 'monitor';
      const quality = $('shareQ').querySelector('button.on')?.dataset.q || '1080';
      const audio = $('shareAudio').checked;
      m.classList.add('hidden');
      await Voice.startShare({ surface, quality, audio });
      if (Voice.state().sharing) UI.toast('You\u2019re sharing your screen.');
    };
  }

  function voiceButtons() {
    shareModal();
    $('vrMute').onclick = () => Voice.setMute();
    $('vrDeaf').onclick = () => Voice.setDeaf();
    $('vrCam').onclick = () => Voice.toggleCam();
    $('vrShare').onclick = () => openSharePicker();
    $('vrLeave').onclick = async () => { await Voice.leave(); showVoiceRoom(false); UI.toast('Disconnected.'); };
    $('vrChat').onclick = () => showVoiceRoom(false);
    $('vcDock').addEventListener('click', (e) => {
      // Tapping the dock status area re-opens the full room view.
      if (e.target.closest('.vc-status') && Voice.state().active) showVoiceRoom(true);
    });
    $('vcMute').onclick = () => Voice.setMute();
    $('vcDeaf').onclick = () => Voice.setDeaf();
    $('vcCam').onclick = () => Voice.toggleCam();
    $('vcShare').onclick = () => openSharePicker();
    $('vcLeave').onclick = async () => { await Voice.leave(); showVoiceRoom(false); UI.toast('Disconnected.'); };
    window.addEventListener('beforeunload', () => { if (Voice.state().active) Voice.leave(); });
  }

  /* ================= menu / modals ================= */
  function modal(id) {
    const m = $(id);
    m.querySelectorAll('[data-close]').forEach((b) => { b.onclick = () => m.classList.add('hidden'); });
    m.onclick = (e) => { if (e.target === m) m.classList.add('hidden'); };
    return m;
  }

  function menus() {
    const menu = $('srvMenu');
    $('srvMenuBtn').onclick = (e) => { e.stopPropagation(); menu.classList.toggle('hidden'); };
    document.addEventListener('click', () => menu.classList.add('hidden'));
    menu.onclick = (e) => e.stopPropagation();

    const mInv = modal('mInvite'), mCh = modal('mChan');

    $('miInvite').onclick = () => {
      menu.classList.add('hidden');
      $('invResult').classList.add('hidden');
      $('invCode').value = ''; $('invOut').value = '';
      mInv.classList.remove('hidden');
    };
    $('invGo').onclick = async () => {
      const hrs = +$('invExpiry').value;
      const rowIn = { server_id: serverId, created_by: me.id };
      if (hrs) rowIn.expires_at = new Date(Date.now() + hrs * 3600e3).toISOString();
      const { data, error } = await window.db.from('invites').insert(rowIn).select().single();
      if (error) return UI.toast(error.message, true);
      $('invCode').value = data.code;
      $('invOut').value = `${location.origin}${location.pathname.replace(/server\.html$/, 'portal.html')}?invite=${data.code}`;
      $('invResult').classList.remove('hidden');
      $('invCode').select();
    };
    $('invCopyCode').onclick = () => {
      const v = $('invCode').value; if (!v) return;
      navigator.clipboard.writeText(v).then(() => UI.toast('Invite code copied.'));
    };
    $('invCopy').onclick = () => {
      const v = $('invOut').value; if (!v) return;
      navigator.clipboard.writeText(v).then(() => UI.toast('Invite link copied.'));
    };

    $('miChannel').onclick = () => {
      menu.classList.add('hidden');
      if (!canManage) return UI.toast('You don\u2019t have permission to add channels.', true);
      $('chNameIn').value = ''; $('chErr').textContent = '';
      $('chType').value = 'text';
      fillCategories();
      mCh.classList.remove('hidden');
      setTimeout(() => $('chNameIn').focus(), 60);
    };
    // Picks the category that already holds channels of the chosen type, so a
    // new voice channel lands under "Voice Channels" instead of the text group.
    function fillCategories() {
      const type = $('chType').value;
      const cats = channels.filter((c) => c.type === 'category');
      $('chParent').innerHTML = '<option value="">No category</option>' +
        cats.map((c) => `<option value="${c.id}">${MD.esc(c.name)}</option>`).join('');
      const wantVoice = type === 'voice' || type === 'stage';
      let best = cats.find((cat) => {
        const kids = channels.filter((c) => c.parent_id === cat.id && c.type !== 'category');
        return kids.length && kids.every((k) => (k.type === 'voice' || k.type === 'stage') === wantVoice);
      });
      if (!best) best = cats.find((c) => wantVoice ? /voice|vc|talk/i.test(c.name) : /text|chat|general/i.test(c.name));
      if (best) $('chParent').value = best.id;
    }
    $('chType').onchange = fillCategories;

    $('chGo').onclick = async () => {
      const name = $('chNameIn').value.trim();
      if (!name) return ($('chErr').textContent = 'Give the channel a name.');
      const type = $('chType').value, parent = $('chParent').value || null;
      const pos = channels.filter((c) => c.parent_id === parent).length;
      const { data, error } = await window.db.from('channels')
        .insert({ server_id: serverId, name, type, parent_id: parent, position: pos }).select().single();
      if (error) return ($('chErr').textContent = error.message);
      mCh.classList.add('hidden');
      UI.toast(`${name} created.`);
      loadChannels((type === 'voice' || type === 'stage') ? null : data.id);
    };

    $('miSettings').onclick = () => {
      if (!canManage) return UI.toast('Only people who can manage this server can open settings.', true);
      window.location.href = `server-settings.html?id=${serverId}`;
    };

    $('miLeave').onclick = async () => {
      menu.classList.add('hidden');
      if (srv.owner_id === me.id) return UI.toast('Owners can\u2019t leave — delete the server in settings instead.', true);
      if (!await UI.confirmDialog('Leave server', `You'll lose access to ${srv.name}.`, true)) return;
      await Voice.leave();
      const { error } = await window.db.from('server_members').delete().eq('server_id', serverId).eq('user_id', me.id);
      if (error) return UI.toast(error.message, true);
      window.location.href = 'portal.html';
    };

    $('burger').onclick = () => {
      $('rail').classList.add('open');
      const s = document.createElement('div');
      s.className = 'rail-scrim';
      s.onclick = () => { $('rail').classList.remove('open'); s.remove(); };
      document.body.appendChild(s);
    };
    $('btnOut').onclick = async () => { await Voice.leave(); await window.db.auth.signOut(); window.location.href = 'index.html'; };
  }

  /* ================= boot ================= */
  (async () => {
    const s = await UI.requireSession(); if (!s) return;
    me = await UI.myProfile(s.user.id);
    profiles[me.id] = me;

    serverId = new URLSearchParams(location.search).get('id');
    if (!serverId) return (window.location.href = 'portal.html');

    const { data, error } = await window.db.from('servers')
      .select('*, server_members(count)').eq('id', serverId).single();
    if (error || !data) { $('gone').classList.remove('hidden'); return; }
    srv = data;

    $('shell').classList.remove('hidden');
    $('srvName').textContent = srv.name;
    const n = srv.server_members?.[0]?.count ?? 0;
    $('srvMembers').textContent = `${n} member${n === 1 ? '' : 's'}`;
    if (srv.theme?.accent) document.documentElement.style.setProperty('--accent', srv.theme.accent);
    UI.applyServerName(srv.theme);

    $('meAv').innerHTML = UI.avatar(me, 28, { presence: true });
    $('meName').textContent = me.display_name || me.username;
    $('meHandle').textContent = '@' + me.username;

    window.Notify?.start(me);
    window.Presence?.start(me);
    window.Presence?.onChange(() => window.Presence.refreshDots());

    devStats = !!(me.theme && me.theme.dev_mode);

    canManage = srv.owner_id === me.id || me.is_platform_admin;
    if (!canManage) {
      const { data: ok } = await window.db.rpc('has_permission', { p_server_id: serverId, p_user_id: me.id, p_bit: 8 });
      canManage = !!ok;
    }

    menus(); composer(); voiceButtons();
    await loadChannels();
  })();
})();
