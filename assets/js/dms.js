(function () {
  const $ = (id) => document.getElementById(id);
  const S3 = () => window.__nx_tp;
  let me = null, tab = 'friends', convs = [], friends = [], requests = [], outgoing = [];
  let active = null, sub = null, pending = [];
  const profiles = {}, attCache = {};
  const painting = new Set();   // in-flight appendMessage ids (dedupe guard)

  async function profileOf(id) {
    if (profiles[id]) return profiles[id];
    const { data } = await window.db.from('profiles')
      .select('id,username,display_name,avatar_url,accent_color,is_nitro').eq('id', id).single();
    profiles[id] = data || { username: 'unknown' };
    return profiles[id];
  }

  /* ================== sidebar ================== */
  function syncTabs() {
    document.querySelectorAll('.dm-tabs button').forEach((x) => x.classList.toggle('on', x.dataset.tab === tab));
  }
  document.querySelectorAll('.dm-tabs button').forEach((b) => {
    b.onclick = () => { tab = b.dataset.tab; syncTabs(); paintList(); };
  });
  $('dmFilter').oninput = paintList;

  async function loadAll() {
    const [{ data: parts }, { data: fr }] = await Promise.all([
      window.db.from('dm_participants').select('conversation_id').eq('user_id', me.id),
      window.db.from('friendships').select('*').or(`user_id.eq.${me.id},friend_id.eq.${me.id}`),
    ]);

    const ids = (parts || []).map((p) => p.conversation_id);
    convs = [];
    if (ids.length) {
      const { data: cs } = await window.db.from('dm_conversations').select('*').in('id', ids);
      const { data: allParts } = await window.db.from('dm_participants')
        .select('conversation_id, user_id, profiles(id,username,display_name,avatar_url,accent_color,is_nitro)')
        .in('conversation_id', ids);
      (allParts || []).forEach((p) => { if (p.profiles) profiles[p.user_id] = p.profiles; });
      convs = (cs || []).map((c) => ({
        ...c,
        people: (allParts || []).filter((p) => p.conversation_id === c.id && p.user_id !== me.id).map((p) => p.profiles).filter(Boolean),
      }));
    }

    const accepted = (fr || []).filter((f) => f.status === 'accepted');
    const friendIds = [...new Set(accepted.map((f) => (f.user_id === me.id ? f.friend_id : f.user_id)))];
    requests = (fr || []).filter((f) => f.status === 'pending' && f.friend_id === me.id);
    // Requests you sent belong in your own Requests tab too, marked pending.
    outgoing = (fr || []).filter((f) => f.status === 'pending' && f.user_id === me.id);
    const reqIds = [...requests.map((r) => r.user_id), ...outgoing.map((r) => r.friend_id)];

    const need = [...new Set([...friendIds, ...reqIds])].filter((i) => !profiles[i]);
    if (need.length) {
      const { data: ps } = await window.db.from('profiles')
        .select('id,username,display_name,avatar_url,accent_color,is_nitro,custom_status').in('id', need);
      (ps || []).forEach((p) => { profiles[p.id] = p; });
    }
    friends = friendIds.map((i) => profiles[i]).filter(Boolean);

    $('reqPill').textContent = requests.length;
    $('reqPill').classList.toggle('hidden', !requests.length);

    // Groups tab only exists once there's a group to show.
    const groups = convs.filter((c) => c.is_group);
    $('tabGroups').classList.toggle('hidden', !groups.length);
    if (tab === 'groups' && !groups.length) { tab = 'friends'; syncTabs(); }

    $('dmSub').textContent = `${friends.length} friend${friends.length === 1 ? '' : 's'}`
      + (groups.length ? ` · ${groups.length} group${groups.length === 1 ? '' : 's'}` : '');
    paintList();
  }

  function convTitle(c) {
    if (c.is_group) return c.name || 'Group chat';
    const o = c.people[0];
    return o ? (o.display_name || o.username) : 'Direct message';
  }
  function convAvatar(c, size) {
    if (c.is_group) {
      return `<div class="av" style="width:${size}px;height:${size}px;font-size:${Math.round(size * .4)}px;background:var(--bg-4);color:var(--txt-1)"><i class="fa-solid fa-user-group" style="font-size:${Math.round(size*.36)}px"></i></div>`;
    }
    return UI.avatar(c.people[0] || { username: '?' }, size, { presence: true });
  }

  function paintList() {
    const q = $('dmFilter').value.trim().toLowerCase();
    const box = $('dmList');

    if (tab === 'groups') {
      const rows = convs.filter((c) => c.is_group && (!q || convTitle(c).toLowerCase().includes(q)));
      box.innerHTML = rows.length ? rows.map((c) => `
        <div class="dm-item ${active?.id === c.id ? 'on' : ''}" data-c="${c.id}">
          ${convAvatar(c, 34)}
          <div class="nm"><b>${MD.esc(convTitle(c))}</b>
            <small>${c.is_group ? `${c.people.length + 1} members` : '@' + MD.esc(c.people[0]?.username || '')}</small></div>
        </div>`).join('')
        : '<div class="dm-empty">No group chats yet.</div>';
      box.querySelectorAll('.dm-item').forEach((el) => {
        el.onclick = () => openConv(convs.find((c) => c.id === el.dataset.c));
      });
    }

    else if (tab === 'friends') {
      const rows = friends.filter((f) => !q || (f.display_name || f.username).toLowerCase().includes(q));
      box.innerHTML = rows.length ? rows.map((f) => `
        <div class="dm-item" data-u="${f.id}">
          ${UI.avatar(f, 34, { presence: true })}
          <div class="nm"><b>${MD.esc(f.display_name || f.username)}</b><small>@${MD.esc(f.username)}</small></div>
          <button class="btn btn-quiet btn-sm" data-call="${f.id}" title="Call"><i class="fa-solid fa-phone"></i></button>
          <button class="btn btn-quiet btn-sm" data-msg="${f.id}" title="Message"><i class="fa-solid fa-paper-plane"></i></button>
        </div>`).join('')
        : '<div class="dm-empty">No friends yet. Use the pencil above to add someone.</div>';

      const openWith = async (uid) => {
        const { data, error } = await window.db.rpc('open_dm', { p_other: uid });
        if (error) { UI.toast(error.message, true); return null; }
        await loadAll();
        const c = convs.find((x) => x.id === data);
        openConv(c);
        return c;
      };
      box.querySelectorAll('[data-msg]').forEach((b) => {
        b.onclick = async (e) => { e.stopPropagation(); await openWith(b.dataset.msg); };
      });
      box.querySelectorAll('[data-call]').forEach((b) => {
        b.onclick = async (e) => {
          e.stopPropagation();
          const c = await openWith(b.dataset.call);
          if (c) startCall(false);
        };
      });
      box.querySelectorAll('.dm-item').forEach((el) => {
        el.onclick = () => UI.userCard(el.dataset.u);
      });
    }

    else {
      let html = '';
      if (requests.length) {
        html += '<div class="dm-sect">Incoming</div>' + requests.map((r) => {
          const p = profiles[r.user_id] || { username: '…' };
          return `<div class="dm-item" data-u="${r.user_id}">
            ${UI.avatar(p, 34)}
            <div class="nm"><b>${MD.esc(p.display_name || p.username)}</b><small>wants to be friends</small></div>
            <button class="btn btn-primary btn-sm" data-ok="${r.user_id}">Accept</button>
            <button class="btn btn-quiet btn-sm" data-no="${r.user_id}"><i class="fa-solid fa-xmark"></i></button>
          </div>`;
        }).join('');
      }
      if (outgoing.length) {
        html += '<div class="dm-sect">Sent</div>' + outgoing.map((r) => {
          const p = profiles[r.friend_id] || { username: '…' };
          return `<div class="dm-item" data-u="${r.friend_id}">
            ${UI.avatar(p, 34)}
            <div class="nm"><b>${MD.esc(p.display_name || p.username)}</b><small>Pending</small></div>
            <span class="chip" style="color:var(--txt-3)"><i class="fa-regular fa-clock"></i> Waiting</span>
            <button class="btn btn-quiet btn-sm" data-cancel="${r.friend_id}" title="Cancel"><i class="fa-solid fa-xmark"></i></button>
          </div>`;
        }).join('');
      }
      box.innerHTML = html || '<div class="dm-empty">No pending requests.</div>';
      box.querySelectorAll('[data-cancel]').forEach((b) => {
        b.onclick = async (e) => {
          e.stopPropagation();
          const { error } = await window.db.rpc('remove_friend', { p_other: b.dataset.cancel });
          UI.toast(error ? error.message : 'Request cancelled.', !!error);
          loadAll();
        };
      });
      box.querySelectorAll('[data-ok]').forEach((b) => {
        b.onclick = async (e) => {
          e.stopPropagation();
          const { error } = await window.db.rpc('accept_friend_request', { p_from: b.dataset.ok });
          UI.toast(error ? error.message : 'Friend added.', !!error);
          loadAll();
        };
      });
      box.querySelectorAll('[data-no]').forEach((b) => {
        b.onclick = async (e) => {
          e.stopPropagation();
          const { error } = await window.db.rpc('remove_friend', { p_other: b.dataset.no });
          UI.toast(error ? error.message : 'Request declined.', !!error);
          loadAll();
        };
      });
    }
  }

  /* ================== conversation ================== */
  async function openConv(c) {
    if (!c) return;
    active = c;
    paintList();
    $('convAv').innerHTML = convAvatar(c, 28);
    $('convName').textContent = convTitle(c);
    if (c.is_group) {
      $('convSub').textContent = `${c.people.length + 1} members`;
    } else {
      const o = c.people[0];
      const on = o && window.Presence?.isOnline(o.id);
      $('convSub').innerHTML = `<span class="presence-line" style="color:${on ? 'var(--accent)' : 'var(--txt-3)'}">
        <span class="pdot ${on ? 'on' : 'off'}" data-pd="${o?.id || ''}"></span>${on ? 'Online' : 'Offline'}</span>
        <span style="color:var(--txt-3)"> · @${MD.esc(o?.username || '')}</span>`;
    }
    $('convSub').classList.remove('hidden');
    $('btnConvInfo').classList.remove('hidden');
    $('btnCall').classList.remove('hidden');
    $('btnVideoCall').classList.remove('hidden');
    if (inCall) showCall(false);
    $('input').placeholder = `Message ${convTitle(c)}`;
    $('composer').classList.remove('hidden');
    $('rail').classList.remove('open');
    document.querySelector('.rail-scrim')?.remove();
    await loadMsgs(c.id);
    listen(c.id);
  }

  $('btnConvInfo').onclick = () => {
    if (!active) return;
    if (!active.is_group && active.people[0]) UI.userCard(active.people[0].id);
    else UI.toast(`${active.people.length + 1} people in this group.`);
  };

  const grouped = (pa, pt, m) => pa === m.author_id && (new Date(m.created_at) - new Date(pt)) < 5 * 60 * 1000;

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

  function regroup() {
    let pa = null, pt = 0;
    $('msgs').querySelectorAll('.m').forEach((el) => {
      const grp = pa === el.dataset.au && (new Date(el.dataset.ts) - new Date(pt)) < 5 * 60 * 1000;
      setGrouped(el, grp);
      pa = el.dataset.au; pt = el.dataset.ts;
    });
  }

  async function purgeAttachments(mid) {
    for (const a of attCache[mid] || []) {
      try {
        const key = decodeURIComponent(new URL(a.url).pathname.replace(/^\/[^/]+\//, ''));
        if (key) await window.__nx_tp.del(key);
      } catch {}
    }
    delete attCache[mid];
  }

  function row(m, grp) {
    const p = profiles[m.author_id] || { username: 'unknown' };
    const name = p.display_name || p.username;
    const mine = m.author_id === me.id;
    const left = grp
      ? `<div class="m-gutter"><span class="hovertime">${new Date(m.created_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</span></div>`
      : `<div class="m-av" data-u="${m.author_id}" style="cursor:pointer">${UI.avatar(p, 38)}</div>`;
    const head = grp ? '' :
      `<div class="m-head"><span class="m-name" data-u="${m.author_id}" style="cursor:pointer;color:${p.accent_color || 'var(--txt-1)'}">${MD.esc(name)}</span>
       ${p.is_nitro ? '<span class="badge badge-nitro"><i class="fa-solid fa-bolt"></i></span>' : ''}
       <span class="m-time">${UI.timeLabel(m.created_at)}</span></div>`;
    return `<div class="m ${grp ? 'grp' : ''}" data-id="${m.id}" data-au="${m.author_id}" data-ts="${m.created_at}">
      ${left}
      <div class="m-main">${head}
        <div class="m-text" data-raw="${MD.esc(m.content || '')}">${MD.render(m.content)}${m.edited_at ? '<span class="m-edited">(edited)</span>' : ''}</div>
        <div class="atts" data-atts="${m.id}"></div>
      </div>
      <div class="m-acts">${mine ? '<button class="a-ed" title="Edit"><i class="fa-solid fa-pen"></i></button><button class="a-del del" title="Delete"><i class="fa-solid fa-trash-can"></i></button>' : ''}</div>
    </div>`;
  }

  function paintAtts(mid) {
    const host = document.querySelector(`[data-atts="${mid}"]`);
    if (!host) return;
    host.innerHTML = '';
    const msgAuthor = document.querySelector(`.m[data-id="${mid}"]`)?.dataset.au;
    const canRemove = msgAuthor === me.id;
    (attCache[mid] || []).forEach((a) => {
      host.appendChild(Viewer.renderWithControls({ ...a, _dm: true }, canRemove, () => {
        attCache[mid] = (attCache[mid] || []).filter((x) => x.id !== a.id);
      }));
    });
  }

  async function loadMsgs(cid) {
    const box = $('msgs');
    box.innerHTML = `<div style="padding:16px;display:flex;flex-direction:column;gap:14px;">${'<div class="skel" style="height:38px;"></div>'.repeat(4)}</div>`;
    const { data: msgs, error } = await window.db.from('dm_messages')
      .select('*, profiles!author_id(id,username,display_name,avatar_url,accent_color,is_nitro)')
      .eq('conversation_id', cid).order('created_at', { ascending: true }).limit(100);
    if (error) { box.innerHTML = ''; return UI.toast(error.message, true); }
    msgs.forEach((m) => { if (m.profiles) profiles[m.author_id] = m.profiles; });

    if (msgs.length) {
      let { data: aa } = await window.db.from('dm_message_attachments')
        .select('*').in('message_id', msgs.map((m) => m.id)).order('position', { ascending: true });
      if (!aa) ({ data: aa } = await window.db.from('dm_message_attachments')
        .select('*').in('message_id', msgs.map((m) => m.id)));
      Object.keys(attCache).forEach((k) => delete attCache[k]);
      (aa || []).forEach((a) => { (attCache[a.message_id] = attCache[a.message_id] || []).push(a); });
    }

    let html = `<div class="msgs-top"><div class="big-ico">${convAvatar(active, 52)}</div>
      <h2>${MD.esc(convTitle(active))}</h2>
      <p>${active.is_group ? 'The beginning of this group chat.' : 'This is the beginning of your direct messages.'}</p></div>`;
    let pa = null, pt = 0;
    msgs.forEach((m) => { html += row(m, grouped(pa, pt, m)); pa = m.author_id; pt = m.created_at; });
    box.innerHTML = html;
    msgs.forEach((m) => paintAtts(m.id));
    wire(box);
    box.scrollTop = box.scrollHeight;
  }

  function wire(scope) {
    const rows = scope.classList?.contains('m') ? [scope] : [...scope.querySelectorAll('.m')];
    scope.querySelectorAll?.('.spoil').forEach((s) => { s.onclick = () => s.classList.add('shown'); });
    rows.forEach((el) => {
      const id = el.dataset.id;
      el.querySelectorAll('[data-u]').forEach((x) => { x.onclick = () => UI.userCard(x.dataset.u); });
      el.querySelectorAll('.spoil').forEach((s) => { s.onclick = () => s.classList.add('shown'); });
      if (window.matchMedia('(hover: none)').matches) {
        el.addEventListener('click', (ev) => {
          if (ev.target.closest('.m-acts, a, button, video, audio, input, [data-u]')) return;
          const was = el.classList.contains('tapped');
          document.querySelectorAll('.m.tapped').forEach((x) => x.classList.remove('tapped'));
          el.classList.toggle('tapped', !was);
        });
      }
      el.querySelector('.a-del')?.addEventListener('click', async () => {
        const n = (attCache[id] || []).length;
        const body = n ? `This removes the message and its ${n} file${n === 1 ? '' : 's'} for everyone.`
                       : 'This removes it for everyone.';
        if (!await UI.confirmDialog('Delete message', body, true)) return;
        const { error } = await window.db.from('dm_messages').delete().eq('id', id);
        if (error) return UI.toast(error.message, true);
        purgeAttachments(id);
        el.remove();
        regroup();
      });
      el.querySelector('.a-ed')?.addEventListener('click', () => edit(el, id));
    });
  }

  function edit(el, id) {
    if (el.querySelector('.editbox')) return;
    const textEl = el.querySelector('.m-text');
    const ta = document.createElement('textarea');
    const box = document.createElement('div');
    box.className = 'editbox';
    const s = document.createElement('small');
    s.textContent = 'Enter to save · Esc to cancel';
    box.append(ta, s);
    ta.rows = 2;
    ta.value = new DOMParser().parseFromString(textEl.dataset.raw, 'text/html').documentElement.textContent;
    textEl.replaceWith(box);
    ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length);
    ta.onkeydown = async (e) => {
      if (e.key === 'Escape') return box.replaceWith(textEl);
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        const v = ta.value.trim(); if (!v) return;
        const { error } = await window.db.from('dm_messages')
          .update({ content: v, edited_at: new Date().toISOString() }).eq('id', id);
        if (error) return UI.toast(error.message, true);
        textEl.dataset.raw = MD.esc(v);
        textEl.innerHTML = MD.render(v) + '<span class="m-edited">(edited)</span>';
        box.replaceWith(textEl);
        wire(el);
      }
    };
  }

  /* Rendering must not depend on the realtime echo — see server.js for the
     same pattern. Realtime, polling and your own send all go through here. */
  async function appendMessage(m) {
    const box = $('msgs');
    if (!box || !active) return null;
    if (m.conversation_id && m.conversation_id !== active.id) return null;
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
    let { data: aa, error } = await window.db.from('dm_message_attachments')
      .select('*').eq('message_id', mid).order('position', { ascending: true });
    if (error) ({ data: aa } = await window.db.from('dm_message_attachments').select('*').eq('message_id', mid));
    if (aa?.length) { attCache[mid] = aa; paintAtts(mid); }
    if (!watch) return;
    [600, 1800, 4000].forEach((d) => setTimeout(async () => {
      if (!document.querySelector(`.m[data-id="${mid}"]`)) return;
      const { data: later } = await window.db.from('dm_message_attachments')
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

  let catching = false;
  async function catchUp() {
    if (catching || !active || document.hidden) return;
    catching = true;
    const cid = active.id, since = newestTs();
    try {
      let q = window.db.from('dm_messages')
        .select('*, profiles!author_id(id,username,display_name,avatar_url,accent_color,is_nitro)')
        .eq('conversation_id', cid).order('created_at', { ascending: true }).limit(50);
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
    } finally { catching = false; }
  }

  /* Reconciles edits and deletes for the messages currently on screen.

     The watermark query above only looks for rows *newer* than the last one
     shown, so a message edited or removed after we rendered it is invisible
     to it -- which is why those still needed a refresh. We re-read the
     visible ids: anything returned gets its text refreshed if it changed,
     and any id that does NOT come back has been deleted. */
  async function catchUpEdits(cid) {
    const els = [...document.querySelectorAll('#msgs .m[data-id]')];
    if (!els.length) return;
    const ids = els.slice(-60).map((el) => el.dataset.id);
    const { data, error } = await window.db.from('dm_messages')
      .select('id,content,edited_at').in('id', ids);
    if (error || !data || !active || active.id !== cid) return;

    const live = new Map(data.map((m) => [m.id, m]));
    let removed = false;

    for (const id of ids) {
      const el = document.querySelector(`.m[data-id="${id}"]`);
      if (!el) continue;
      const m = live.get(id);

      if (!m) {
        el.remove();
        delete attCache[id];
        removed = true;
        continue;
      }

      // Don't clobber a message the user is actively editing.
      if (el.querySelector('.editbox')) continue;
      const cur = el.querySelector('.m-text');
      if (!cur) continue;

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

  let rtHealthy = false, rtProven = false, pollTimer = null, pollRate = 0, retryTimer = null, retries = 0;

  /* Polling is never fully switched off.

     A channel can report SUBSCRIBED and still deliver nothing -- e.g.
     when the table is not in the `supabase_realtime` publication, or
     the socket is half-open behind a proxy. In that case an
     error-triggered fallback never fires and messages stop appearing
     until a refresh. So we always keep a reconcile loop running and
     merely slow it down while realtime looks healthy. appendMessage()
     dedupes by message id, so the overlap is free. */
  const POLL_FAST = 3000;   // realtime is down / unproven
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
    sub = window.db.channel('dm:' + cid)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'dm_messages', filter: `conversation_id=eq.${cid}` }, async (p) => {
        // A delivered event is the only real proof realtime works.
        if (!rtProven) { rtProven = true; setPolling(false); }
        if (await appendMessage(p.new)) await hydrateAtts(p.new.id, true);
      })
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'dm_messages', filter: `conversation_id=eq.${cid}` }, (p) => {
        const el = document.querySelector(`.m[data-id="${p.new.id}"]`);
        if (!el || el.querySelector('.editbox')) return;
        const cur = el.querySelector('.m-text');
        cur.dataset.raw = MD.esc(p.new.content || '');
        cur.innerHTML = MD.render(p.new.content) + (p.new.edited_at ? '<span class="m-edited">(edited)</span>' : '');
      })
      .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'dm_messages', filter: `conversation_id=eq.${cid}` }, (p) => {
        document.querySelector(`.m[data-id="${p.old.id}"]`)?.remove();
        delete attCache[p.old.id];
        regroup();
      })
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'dm_message_attachments' }, async (p) => {
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
      .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'dm_message_attachments' }, (p) => {
        const mid = Object.keys(attCache).find((k) => (attCache[k] || []).some((x) => x.id === p.old.id));
        if (!mid) return;
        attCache[mid] = attCache[mid].filter((x) => x.id !== p.old.id);
        paintAtts(mid);
      })
      .subscribe((status) => {
        if (status === 'SUBSCRIBED') {
          rtHealthy = true; retries = 0;
          // Only trust it enough to back off once it has really delivered.
          setPolling(!rtProven);
          catchUp();
        } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
          rtHealthy = false;
          setPolling(true);
          catchUp();
          scheduleRetry(cid);
        }
      });

    setTimeout(() => { if (!rtHealthy && active?.id === cid) { setPolling(true); catchUp(); } }, 4000);
  }

  document.addEventListener('visibilitychange', () => { if (!document.hidden) catchUp(); });
  window.addEventListener('online', () => { if (active) { catchUp(); listen(active.id); } });

  /* ================== composer ================== */
  function paintTray() {
    const t = $('tray');
    t.innerHTML = pending.map((f, i) => `
      <div class="tray-item">${f._prev ? `<img src="${f._prev}">` : '<i class="fa-solid fa-file" style="color:var(--txt-3)"></i>'}
      <span class="tn">${MD.esc(f.name)}</span>
      <span style="color:var(--txt-3);font-size:11px;">${Viewer.human(f.size)}</span>
      <button class="tx" data-i="${i}"><i class="fa-solid fa-xmark"></i></button></div>`).join('');
    t.classList.toggle('hidden', !pending.length);
    t.querySelectorAll('.tx').forEach((b) => { b.onclick = () => { pending.splice(+b.dataset.i, 1); paintTray(); }; });
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
      const v = ta.value.trim(), files = pending.slice();
      if ((!v && !files.length) || !active) return;
      ta.value = ''; ta.style.height = 'auto';
      pending = []; paintTray();

      const { data: msg, error } = await window.db.from('dm_messages')
        .insert({ conversation_id: active.id, author_id: me.id, content: v || null }).select().single();
      if (error) return UI.toast(error.message, true);

      // Show our own message immediately rather than waiting for the echo.
      await appendMessage(msg);

      if (files.length) {
        const bar = $('upbar'); bar.classList.remove('hidden');
        const fill = bar.querySelector('i');
        let ok = 0;
        for (let i = 0; i < files.length; i++) {
          const f = files[i];
          try {
            const key = `nexchat/dm/${active.id}/${Date.now()}-${i}-${f.name.replace(/[^\w.\-]/g, '_')}`;
            const up = await S3().put(key, f);
            const rowBase = {
              message_id: msg.id, url: up.url, file_name: f.name,
              file_size: f.size, mime_type: up.type,
            };
            let { error: aErr } = await window.db.from('dm_message_attachments')
              .insert({ ...rowBase, position: i });
            if (aErr && /position/i.test(aErr.message || '')) {
              ({ error: aErr } = await window.db.from('dm_message_attachments').insert(rowBase));
            }
            if (aErr) throw new Error(aErr.message);
            ok++;
          } catch (err) { UI.toast(`${f.name}: ${err.message}`, true); }
          fill.style.width = Math.round(((i + 1) / files.length) * 100) + '%';
        }
        setTimeout(() => { bar.classList.add('hidden'); fill.style.width = '0'; }, 400);
        if (!ok && !v) {
          await window.db.from('dm_messages').delete().eq('id', msg.id);
          document.querySelector(`.m[data-id="${msg.id}"]`)?.remove();
          regroup();
          return;
        }
        let { data: aa } = await window.db.from('dm_message_attachments')
          .select('*').eq('message_id', msg.id).order('position', { ascending: true });
        if (!aa) ({ data: aa } = await window.db.from('dm_message_attachments').select('*').eq('message_id', msg.id));
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
    chat.addEventListener('dragover', (e) => e.preventDefault());
    chat.addEventListener('drop', (e) => { e.preventDefault(); if (e.dataTransfer.files.length) stage(e.dataTransfer.files); });
  }

  /* ================== new conversation ================== */
  function newModal() {
    const m = $('mNew');
    m.querySelectorAll('[data-close]').forEach((b) => { b.onclick = () => m.classList.add('hidden'); });
    m.onclick = (e) => { if (e.target === m) m.classList.add('hidden'); };
    $('btnNewDm').onclick = () => {
      $('addUser').value = ''; $('groupName').value = ''; $('newErr').textContent = '';
      $('friendPicks').innerHTML = friends.length
        ? friends.map((f) => `<label class="perm"><input type="checkbox" value="${f.id}">${UI.avatar(f, 22)} ${MD.esc(f.display_name || f.username)}</label>`).join('')
        : '<p style="font-size:12.5px;color:var(--txt-3);margin:0;">Add friends first.</p>';
      m.classList.remove('hidden');
    };
    $('addUserGo').onclick = async () => {
      const u = $('addUser').value.trim();
      if (!u) return;
      const { error } = await window.db.rpc('send_friend_request', { p_username: u });
      if (error) return ($('newErr').textContent = error.message);
      $('addUser').value = '';
      UI.toast('Friend request sent.');
      m.classList.add('hidden');
      tab = 'requests'; syncTabs();
      await loadAll();
    };
    $('groupGo').onclick = async () => {
      const picks = [...$('friendPicks').querySelectorAll('input:checked')].map((c) => c.value);
      if (!picks.length) return ($('newErr').textContent = 'Pick at least one friend.');
      const { data, error } = await window.db.rpc('create_group_dm', {
        p_name: $('groupName').value.trim() || 'Group chat', p_members: picks,
      });
      if (error) return ($('newErr').textContent = error.message);
      m.classList.add('hidden');
      await loadAll();
      openConv(convs.find((c) => c.id === data));
    };
  }

  /* ================== calls ================== */
  let inCall = false, speakSet = new Set(), devStats = false;

  function showCall(on) {
    inCall = on;
    $('vroom').classList.toggle('hidden', !on);
    $('msgs').classList.toggle('hidden', on);
    $('composer').classList.toggle('hidden', on || !active);
    if (on) paintRoom(Voice.state());
  }

  function feedsFor(p) {
    const isMe = p.id === me.id;
    const st = Voice.state();
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
    $('vrName').textContent = active ? convTitle(active) : 'Call';
    $('vrSub').textContent = `${st.members.size} on the call`;
    const set = (id, cls, cond, icon) => {
      const b = $(id); b.classList.remove('live', 'off');
      if (cond) b.classList.add(cls);
      if (icon) b.innerHTML = icon;
    };
    set('vrMute', 'off', st.muted, `<i class="fa-solid fa-microphone${st.muted ? '-slash' : ''}"></i>`);
    set('vrDeaf', 'off', st.deaf, '<i class="fa-solid fa-headphones-simple"></i>');
    set('vrCam', 'live', st.cam);
    set('vrShare', 'live', st.sharing);

    const grid = $('vrStage');
    const feeds = [...st.members.values()].flatMap(feedsFor);
    grid.classList.toggle('solo', feeds.length === 1);
    const seenKeys = new Set();
    feeds.forEach((f) => {
      seenKeys.add(f.key);
      let t = grid.querySelector(`[data-t="${f.key}"]`);
      if (!t) {
        t = document.createElement('div');
        t.className = 'vtile';
        t.dataset.t = f.key;
        t.innerHTML = `<video autoplay playsinline ${f.isMe ? 'muted' : ''}></video><div class="vt-av"></div><div class="vt-name"></div>`;
        grid.appendChild(t);
      }
      const v = t.querySelector('video');
      if (f.stream && v.srcObject !== f.stream) { v.srcObject = f.stream; v.play?.().catch(() => {}); }
      if (!f.stream) v.srcObject = null;
      v.style.display = f.stream ? '' : 'none';
      const av = t.querySelector('.vt-av');
      av.style.display = f.stream ? 'none' : '';
      if (!f.stream) av.innerHTML = UI.avatar(f.p, 76, { halo: false });
      t.querySelector('.vt-name').innerHTML =
        `${f.p.muted ? '<i class="fa-solid fa-microphone-slash off"></i>' : ''}<span>${MD.esc(f.p.display_name || f.p.username)}${f.isMe ? ' (you)' : ''}</span>`;
      t.querySelector('.vt-flag')?.remove();
      if (f.screen) t.insertAdjacentHTML('beforeend', '<span class="vt-flag">Screen</span>');
      t.classList.toggle('speaking', speakSet.has(f.p.id) && !f.p.muted);
    });
    [...grid.children].forEach((t) => { if (!seenKeys.has(t.dataset.t)) t.remove(); });
  }

  function paintStats(st) {
    const bar = $('vstats');
    if (!inCall || !devStats) { bar.classList.add('hidden'); return; }
    bar.classList.remove('hidden');
    const rttCls = st.rtt === 0 ? '' : st.rtt < 60 ? 'good' : st.rtt < 160 ? 'warn' : 'bad';
    bar.innerHTML = `
      <span class="st ${st.res ? 'good' : ''}"><i class="fa-solid fa-display"></i> Video <b>${st.res || 'off'}</b></span>
      <span class="st"><i class="fa-solid fa-film"></i> <b>${st.fps || 0}</b> fps</span>
      <span class="st"><i class="fa-solid fa-video"></i> <b>${st.vkbps || 0}</b> kbps</span>
      <span class="st good"><i class="fa-solid fa-waveform-lines"></i> Audio <b>${st.akbps || 0}</b> kbps</span>
      <span class="spacer"></span>
      <span class="st ${rttCls}"><i class="fa-solid fa-tower-broadcast"></i> <b>${st.rtt || 0}</b> ms</span>`;
  }

  function onSpeaking(set) {
    speakSet = set;
    document.querySelectorAll('.vtile').forEach((t) => {
      const uid = t.dataset.t.split(':')[0];
      const p = Voice.state().members.get(uid);
      t.classList.toggle('speaking', set.has(uid) && !p?.muted);
    });
  }

  async function startCall(withVideo) {
    if (!active) return;
    try {
      // A DM call is just a voice room keyed on the conversation id.
      await Voice.join({ id: 'dm-' + active.id, name: convTitle(active) }, null,
        { ...me, muted: false, deaf: false, cam: false, sharing: false },
        paintRoom, onSpeaking, paintStats);
    } catch { return; }
    showCall(true);
    if (withVideo) await Voice.toggleCam();

    // Ring everyone else in the conversation.
    active.people.forEach((p) => {
      window.Notify?.ring(p.id, {
        conversation: active.id,
        name: me.display_name || me.username,
        avatar: UI.avatar(me, 32, { halo: false }),
      });
    });
    UI.toast('Calling…');
  }

  function callUI() {
    $('btnCall').onclick = () => startCall(false);
    $('btnVideoCall').onclick = () => startCall(true);
    $('vrMute').onclick = () => Voice.setMute();
    $('vrDeaf').onclick = () => Voice.setDeaf();
    $('vrCam').onclick = () => Voice.toggleCam();
    $('vrShare').onclick = () => {
      if (Voice.state().sharing) return Voice.stopShare();
      if (!Voice.screenSupported()) return UI.toast('Screen sharing needs a desktop browser.', true);
      Voice.startShare({ surface: 'monitor', quality: '1080', audio: true });
    };
    $('vrChat').onclick = () => showCall(false);
    $('vrLeave').onclick = async () => { await Voice.leave(); showCall(false); UI.toast('Call ended.'); };
    window.addEventListener('beforeunload', () => { if (Voice.state().active) Voice.leave(); });
  }

  $('burger').onclick = () => {
    $('rail').classList.add('open');
    const s = document.createElement('div');
    s.className = 'rail-scrim';
    s.onclick = () => { $('rail').classList.remove('open'); s.remove(); };
    document.body.appendChild(s);
  };
  $('btnOut').onclick = async () => { await window.db.auth.signOut(); window.location.href = 'index.html'; };

  (async () => {
    const s = await UI.requireSession(); if (!s) return;
    me = await UI.myProfile(s.user.id);
    if (me) {
      window.Notify?.start(me);
      window.Guard?.start(me);
      window.Presence?.start(me);
      window.Presence?.onChange(() => { window.Presence.refreshDots(); if (tab === 'friends') paintList(); });
    }
    profiles[me.id] = me;
    $('meAv').innerHTML = UI.avatar(me, 28);
    $('meName').textContent = me.display_name || me.username;
    $('meHandle').textContent = '@' + me.username;
    composer(); newModal(); callUI();

    // Friend state should update without a refresh, on both sides.
    // If the socket is unhealthy we fall back to a slow refresh so the
    // sidebar still catches new conversations and friend requests.
    let friendPoll = null;
    window.db.channel('dm-friends-' + me.id)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'friendships' }, () => loadAll())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'dm_participants' }, () => loadAll())
      .subscribe((status) => {
        if (status === 'SUBSCRIBED') {
          if (friendPoll) { clearInterval(friendPoll); friendPoll = null; }
          return;
        }
        if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
          console.warn('NexChat realtime: dm-friends -> ' + status);
          if (!friendPoll) {
            friendPoll = setInterval(() => { if (!document.hidden) loadAll(); }, 20000);
          }
        }
      });

    await loadAll();
    if (location.hash === '#requests') { tab = 'requests'; syncTabs(); paintList(); }
    devStats = !!(me.theme && me.theme.dev_mode);
    const params = new URLSearchParams(location.search);
    const want = params.get('c');
    if (want) {
      await openConv(convs.find((c) => c.id === want));
      if (params.get('call') === '1') startCall(false);
    }
  })();
})();
