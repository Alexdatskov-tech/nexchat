(function () {
  const $ = (id) => document.getElementById(id);
  let me = null, srv = null, serverId = null;
  let channels = [], active = null, sub = null, canManage = false;
  const profiles = {};       // user_id -> profile
  const rx = {};             // message_id -> { emoji: {n, mine, users[]} }

  const QUICK = ['👍', '🔥', '😂', '❤️', '😮', '🎉'];

  /* ---- markdown: Discord's subset, escaped first so it can't inject HTML ---- */
  function md(raw) {
    let t = UI.esc(raw || '');
    const blocks = [];
    t = t.replace(/```(?:[a-z]*\n)?([\s\S]*?)```/gi, (_, c) => `\u0000${blocks.push(`<pre><code>${c.replace(/\n$/, '')}</code></pre>`) - 1}\u0000`);
    t = t.replace(/`([^`\n]+)`/g, '<code>$1</code>');
    t = t.replace(/\|\|([\s\S]+?)\|\|/g, '<span class="spoil">$1</span>');
    t = t.replace(/\*\*\*([^\n*]+)\*\*\*/g, '<strong><em>$1</em></strong>');
    t = t.replace(/\*\*([^\n*]+)\*\*/g, '<strong>$1</strong>');
    t = t.replace(/__([^\n_]+)__/g, '<u>$1</u>');
    t = t.replace(/~~([^\n~]+)~~/g, '<del>$1</del>');
    t = t.replace(/\*([^\n*]+)\*/g, '<em>$1</em>');
    t = t.replace(/(^|\s)_([^\n_]+)_(?=\s|$)/g, '$1<em>$2</em>');
    t = t.replace(/^&gt;\s?(.*)$/gm, '<blockquote>$1</blockquote>');
    t = t.replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>');
    return t.replace(/\u0000(\d+)\u0000/g, (_, i) => blocks[+i]);
  }

  async function profileOf(id) {
    if (profiles[id]) return profiles[id];
    const { data } = await window.db.from('profiles')
      .select('id,username,display_name,avatar_url,accent_color,is_nitro').eq('id', id).single();
    profiles[id] = data || { username: 'unknown', display_name: 'Unknown' };
    return profiles[id];
  }

  /* ================= channels ================= */
  function chanIcon(t) {
    return t === 'voice' ? 'fa-volume-high' : t === 'stage' ? 'fa-tower-broadcast'
      : t === 'announcement' ? 'fa-bullhorn' : 'fa-hashtag';
  }

  function renderChannels() {
    const cats = channels.filter((c) => c.type === 'category').sort((a, b) => a.position - b.position);
    const loose = channels.filter((c) => c.type !== 'category' && !c.parent_id).sort((a, b) => a.position - b.position);

    const item = (c) => {
      const soon = c.type === 'voice' || c.type === 'stage';
      return `<div class="chan ${soon ? 'soon' : ''} ${c.id === active?.id ? 'on' : ''}" data-id="${c.id}" data-soon="${soon}">
        <i class="fa-solid ${chanIcon(c.type)}"></i><span>${UI.esc(c.name)}</span>
      </div>`;
    };

    let html = loose.map(item).join('');
    cats.forEach((cat) => {
      const kids = channels.filter((c) => c.parent_id === cat.id).sort((a, b) => a.position - b.position);
      html += `<div class="cat"><i class="fa-solid fa-chevron-down"></i>${UI.esc(cat.name)}</div>
               <div class="cat-kids">${kids.map(item).join('')}</div>`;
    });
    $('chanList').innerHTML = html || '<div style="padding:14px 8px;font-size:12.5px;color:var(--txt-3);">No channels yet.</div>';

    $('chanList').querySelectorAll('.cat').forEach((el) => { el.onclick = () => el.classList.toggle('shut'); });
    $('chanList').querySelectorAll('.chan').forEach((el) => {
      el.onclick = () => {
        if (el.dataset.soon === 'true') return UI.toast('Voice rooms aren\u2019t wired up yet.');
        open(channels.find((c) => c.id === el.dataset.id));
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
    if (pick) open(pick);
    else { $('composer').classList.add('hidden'); $('msgs').innerHTML = ''; }
  }

  async function open(ch) {
    if (!ch) return;
    active = ch;
    renderChannels();
    $('chIco').innerHTML = `<i class="fa-solid ${chanIcon(ch.type)}"></i>`;
    $('chName').textContent = ch.name;
    $('chTopic').textContent = ch.topic || '';
    $('chTopic').classList.toggle('hidden', !ch.topic);
    $('input').placeholder = `Message #${ch.name}`;
    $('composer').classList.remove('hidden');
    await loadMessages(ch.id);
    listen(ch.id);
  }

  /* ================= messages ================= */
  function intro() {
    return `<div class="msgs-top">
      <div class="big-ico"><i class="fa-solid ${chanIcon(active.type)}"></i></div>
      <h2>Welcome to #${UI.esc(active.name)}</h2>
      <p>${active.topic ? UI.esc(active.topic) : 'This is the start of the channel.'}</p>
    </div>`;
  }

  function rxHtml(id) {
    const m = rx[id];
    if (!m || !Object.keys(m).length) return '';
    return `<div class="rx-row">${Object.entries(m).map(([e, v]) =>
      `<button class="rx ${v.mine ? 'mine' : ''}" data-m="${id}" data-e="${UI.esc(e)}">${e}<b>${v.n}</b></button>`).join('')}</div>`;
  }

  function row(m, grouped) {
    const p = profiles[m.author_id] || { username: 'unknown' };
    const name = p.display_name || p.username;
    const mine = m.author_id === me.id;
    const canDelete = mine || canManage;

    const left = grouped
      ? `<div class="m-gutter"><span class="hovertime">${new Date(m.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span></div>`
      : `<div class="m-av">${UI.avatar(p, 38)}</div>`;

    const head = grouped ? '' :
      `<div class="m-head"><span class="m-name" style="color:${p.accent_color || 'var(--txt-1)'}">${UI.esc(name)}</span>
       ${p.is_nitro ? '<span class="badge badge-nitro"><i class="fa-solid fa-bolt"></i></span>' : ''}
       <span class="m-time">${UI.timeLabel(m.created_at)}</span></div>`;

    return `<div class="m ${grouped ? 'grp' : ''}" data-id="${m.id}" data-au="${m.author_id}" data-ts="${m.created_at}">
      ${left}
      <div class="m-main">
        ${head}
        <div class="m-text" data-raw="${UI.esc(m.content || '')}">${md(m.content)}${m.edited_at ? '<span class="m-edited">(edited)</span>' : ''}</div>
        <div class="rx-slot">${rxHtml(m.id)}</div>
      </div>
      <div class="m-acts">
        <button class="a-rx" title="React"><i class="fa-regular fa-face-smile"></i></button>
        ${mine ? '<button class="a-ed" title="Edit"><i class="fa-solid fa-pen"></i></button>' : ''}
        ${canDelete ? '<button class="a-del del" title="Delete"><i class="fa-solid fa-trash-can"></i></button>' : ''}
      </div>
    </div>`;
  }

  function isGrouped(prevAuthor, prevTs, m) {
    return prevAuthor === m.author_id && (new Date(m.created_at) - new Date(prevTs)) < 5 * 60 * 1000;
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
      const { data: rr } = await window.db.from('message_reactions').select('*').in('message_id', msgs.map((m) => m.id));
      (rr || []).forEach((r) => addRx(r.message_id, r.emoji, r.user_id));
    }

    let html = intro(), pa = null, pt = 0;
    msgs.forEach((m) => { html += row(m, isGrouped(pa, pt, m)); pa = m.author_id; pt = m.created_at; });
    box.innerHTML = html;
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
    wire(slot);
  }

  function wire(scope) {
    scope.querySelectorAll('.rx').forEach((b) => { b.onclick = () => toggleRx(b.dataset.m, b.dataset.e); });
    scope.querySelectorAll('.spoil').forEach((s) => { s.onclick = () => s.classList.add('shown'); });
    scope.querySelectorAll('.m').forEach((el) => {
      const id = el.dataset.id;
      el.querySelector('.a-rx') && (el.querySelector('.a-rx').onclick = (ev) => picker(ev.currentTarget, el, id));
      el.querySelector('.a-ed') && (el.querySelector('.a-ed').onclick = () => edit(el, id));
      el.querySelector('.a-del') && (el.querySelector('.a-del').onclick = async () => {
        if (!await UI.confirmDialog('Delete message', 'This removes it for everyone.', true)) return;
        const { error } = await window.db.from('messages').delete().eq('id', id);
        if (error) UI.toast(error.message, true);
      });
    });
  }

  function picker(btn, rowEl, mid) {
    document.querySelectorAll('.picker').forEach((p) => p.remove());
    const p = document.createElement('div');
    p.className = 'picker';
    p.innerHTML = QUICK.map((e) => `<button data-e="${e}">${e}</button>`).join('');
    rowEl.appendChild(p);
    p.querySelectorAll('button').forEach((b) => { b.onclick = () => { toggleRx(mid, b.dataset.e); p.remove(); }; });
    setTimeout(() => document.addEventListener('click', function off(ev) {
      if (!p.contains(ev.target) && !btn.contains(ev.target)) { p.remove(); document.removeEventListener('click', off); }
    }), 0);
  }

  async function toggleRx(mid, emoji) {
    const mine = rx[mid]?.[emoji]?.mine;
    // Paint immediately, then let realtime confirm — reactions should feel instant.
    if (mine) { dropRx(mid, emoji, me.id); repaintRx(mid); await window.db.from('message_reactions').delete().eq('message_id', mid).eq('user_id', me.id).eq('emoji', emoji); }
    else { addRx(mid, emoji, me.id); repaintRx(mid); await window.db.from('message_reactions').insert({ message_id: mid, user_id: me.id, emoji }); }
  }

  function edit(el, id) {
    const textEl = el.querySelector('.m-text');
    if (!textEl) return;
    const raw = new DOMParser().parseFromString(textEl.dataset.raw, 'text/html').documentElement.textContent;
    const box = document.createElement('div');
    box.className = 'editbox';
    box.innerHTML = `<textarea rows="2"></textarea><small>Enter to save · Esc to cancel</small>`;
    box.querySelector('textarea').value = raw;
    textEl.replaceWith(box);
    const ta = box.querySelector('textarea');
    ta.focus(); ta.setSelectionRange(raw.length, raw.length);
    ta.style.height = ta.scrollHeight + 'px';

    ta.onkeydown = async (e) => {
      if (e.key === 'Escape') return box.replaceWith(textEl);
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        const v = ta.value.trim();
        if (!v) return;
        box.replaceWith(textEl);
        const { error } = await window.db.from('messages')
          .update({ content: v, edited_at: new Date().toISOString() }).eq('id', id);
        if (error) UI.toast(error.message, true);
      }
    };
  }

  /* ================= realtime ================= */
  function listen(cid) {
    if (sub) window.db.removeChannel(sub);
    sub = window.db.channel('ch:' + cid)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages', filter: `channel_id=eq.${cid}` }, async (p) => {
        const m = p.new;
        if (document.querySelector(`.m[data-id="${m.id}"]`)) return;
        await profileOf(m.author_id);
        const box = $('msgs');
        const stick = box.scrollHeight - box.scrollTop - box.clientHeight < 180;
        const last = box.querySelector('.m:last-of-type');
        box.insertAdjacentHTML('beforeend', row(m, last ? isGrouped(last.dataset.au, last.dataset.ts, m) : false));
        wire(box.lastElementChild);
        if (stick || m.author_id === me.id) box.scrollTop = box.scrollHeight;
      })
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'messages', filter: `channel_id=eq.${cid}` }, (p) => {
        const m = p.new;
        const el = document.querySelector(`.m[data-id="${m.id}"]`);
        if (!el) return;
        const cur = el.querySelector('.m-text, .editbox');
        const nx = document.createElement('div');
        nx.className = 'm-text';
        nx.dataset.raw = UI.esc(m.content || '');
        nx.innerHTML = md(m.content) + (m.edited_at ? '<span class="m-edited">(edited)</span>' : '');
        cur.replaceWith(nx);
        wire(el);
      })
      .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'messages', filter: `channel_id=eq.${cid}` }, (p) => {
        document.querySelector(`.m[data-id="${p.old.id}"]`)?.remove();
      })
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'message_reactions' }, (p) => {
        if (!document.querySelector(`.m[data-id="${p.new.message_id}"]`)) return;
        addRx(p.new.message_id, p.new.emoji, p.new.user_id); repaintRx(p.new.message_id);
      })
      .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'message_reactions' }, (p) => {
        if (!document.querySelector(`.m[data-id="${p.old.message_id}"]`)) return;
        dropRx(p.old.message_id, p.old.emoji, p.old.user_id); repaintRx(p.old.message_id);
      })
      .subscribe();
  }

  /* ================= composer ================= */
  function composer() {
    const ta = $('input');
    const send = async () => {
      const v = ta.value.trim();
      if (!v || !active) return;
      ta.value = ''; ta.style.height = 'auto';
      const { error } = await window.db.from('messages')
        .insert({ channel_id: active.id, author_id: me.id, content: v });
      if (error) UI.toast(error.message, true);
    };
    ta.oninput = () => { ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, 168) + 'px'; };
    ta.onkeydown = (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } };
    $('send').onclick = send;
  }

  /* ================= menu, invites, channels ================= */
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

    $('miInvite').onclick = () => { menu.classList.add('hidden'); $('invOut').value = ''; mInv.classList.remove('hidden'); };
    $('invGo').onclick = async () => {
      const hrs = +$('invExpiry').value;
      const row = { server_id: serverId, created_by: me.id };
      if (hrs) row.expires_at = new Date(Date.now() + hrs * 3600e3).toISOString();
      const { data, error } = await window.db.from('invites').insert(row).select().single();
      if (error) return UI.toast(error.message, true);
      $('invOut').value = `${location.origin}${location.pathname.replace(/server\.html$/, 'portal.html')}?invite=${data.code}`;
    };
    $('invCopy').onclick = () => {
      const v = $('invOut').value; if (!v) return;
      navigator.clipboard.writeText(v).then(() => UI.toast('Invite link copied.'));
    };

    $('miChannel').onclick = () => {
      menu.classList.add('hidden');
      if (!canManage) return UI.toast('You don\u2019t have permission to add channels.', true);
      $('chNameIn').value = ''; $('chErr').textContent = '';
      $('chParent').innerHTML = '<option value="">No category</option>' +
        channels.filter((c) => c.type === 'category')
          .map((c) => `<option value="${c.id}">${UI.esc(c.name)}</option>`).join('');
      mCh.classList.remove('hidden');
      setTimeout(() => $('chNameIn').focus(), 60);
    };
    $('chGo').onclick = async () => {
      const name = $('chNameIn').value.trim();
      if (!name) return ($('chErr').textContent = 'Give the channel a name.');
      const type = $('chType').value, parent = $('chParent').value || null;
      const pos = channels.filter((c) => c.parent_id === parent).length;
      const { data, error } = await window.db.from('channels')
        .insert({ server_id: serverId, name, type, parent_id: parent, position: pos }).select().single();
      if (error) return ($('chErr').textContent = error.message);
      mCh.classList.add('hidden');
      UI.toast(`#${name} created.`);
      loadChannels(type === 'text' || type === 'announcement' ? data.id : null);
    };

    $('miSettings').onclick = () => {
      if (!canManage) return UI.toast('Only people who can manage this server can open settings.', true);
      window.location.href = `server-settings.html?id=${serverId}`;
    };

    $('miLeave').onclick = async () => {
      menu.classList.add('hidden');
      if (srv.owner_id === me.id) return UI.toast('Owners can\u2019t leave — delete the server in settings instead.', true);
      if (!await UI.confirmDialog('Leave server', `You'll lose access to ${srv.name} until someone invites you back.`, true)) return;
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

    $('btnOut').onclick = async () => { await window.db.auth.signOut(); window.location.href = 'index.html'; };
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

    // A server can override the accent; everything themed off --accent follows.
    if (srv.theme?.accent) document.documentElement.style.setProperty('--accent', srv.theme.accent);

    $('meAv').innerHTML = UI.avatar(me, 28);
    $('meName').textContent = me.display_name || me.username;
    $('meHandle').textContent = '@' + me.username;

    canManage = srv.owner_id === me.id || me.is_platform_admin;
    if (!canManage) {
      const { data: ok } = await window.db.rpc('has_permission', { p_server_id: serverId, p_user_id: me.id, p_bit: 8 });
      canManage = !!ok;
    }

    menus();
    composer();
    await loadChannels();
  })();
})();
