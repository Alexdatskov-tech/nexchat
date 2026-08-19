(function () {
  const $ = (id) => document.getElementById(id);
  const S3 = () => window.__nx_tp;
  let me = null, tab = 'chats', convs = [], friends = [], requests = [];
  let active = null, sub = null, pending = [];
  const profiles = {}, attCache = {};

  async function profileOf(id) {
    if (profiles[id]) return profiles[id];
    const { data } = await window.db.from('profiles')
      .select('id,username,display_name,avatar_url,accent_color,is_nitro').eq('id', id).single();
    profiles[id] = data || { username: 'unknown' };
    return profiles[id];
  }

  /* ================== sidebar ================== */
  document.querySelectorAll('.dm-tabs button').forEach((b) => {
    b.onclick = () => {
      document.querySelectorAll('.dm-tabs button').forEach((x) => x.classList.remove('on'));
      b.classList.add('on');
      tab = b.dataset.tab;
      paintList();
    };
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
    const reqIds = requests.map((r) => r.user_id);

    const need = [...new Set([...friendIds, ...reqIds])].filter((i) => !profiles[i]);
    if (need.length) {
      const { data: ps } = await window.db.from('profiles')
        .select('id,username,display_name,avatar_url,accent_color,is_nitro,custom_status').in('id', need);
      (ps || []).forEach((p) => { profiles[p.id] = p; });
    }
    friends = friendIds.map((i) => profiles[i]).filter(Boolean);

    $('reqPill').textContent = requests.length;
    $('reqPill').classList.toggle('hidden', !requests.length);
    $('dmSub').textContent = `${convs.length} chat${convs.length === 1 ? '' : 's'} · ${friends.length} friend${friends.length === 1 ? '' : 's'}`;
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
    return UI.avatar(c.people[0] || { username: '?' }, size);
  }

  function paintList() {
    const q = $('dmFilter').value.trim().toLowerCase();
    const box = $('dmList');

    if (tab === 'chats') {
      const rows = convs.filter((c) => !q || convTitle(c).toLowerCase().includes(q));
      box.innerHTML = rows.length ? rows.map((c) => `
        <div class="dm-item ${active?.id === c.id ? 'on' : ''}" data-c="${c.id}">
          ${convAvatar(c, 34)}
          <div class="nm"><b>${MD.esc(convTitle(c))}</b>
            <small>${c.is_group ? `${c.people.length + 1} members` : '@' + MD.esc(c.people[0]?.username || '')}</small></div>
        </div>`).join('')
        : '<div class="dm-empty">No conversations yet. Add a friend to get started.</div>';
      box.querySelectorAll('.dm-item').forEach((el) => {
        el.onclick = () => openConv(convs.find((c) => c.id === el.dataset.c));
      });
    }

    else if (tab === 'friends') {
      const rows = friends.filter((f) => !q || (f.display_name || f.username).toLowerCase().includes(q));
      box.innerHTML = rows.length ? rows.map((f) => `
        <div class="dm-item" data-u="${f.id}">
          ${UI.avatar(f, 34)}
          <div class="nm"><b>${MD.esc(f.display_name || f.username)}</b><small>@${MD.esc(f.username)}</small></div>
          <button class="btn btn-quiet btn-sm" data-msg="${f.id}"><i class="fa-solid fa-paper-plane"></i></button>
        </div>`).join('')
        : '<div class="dm-empty">No friends yet.</div>';
      box.querySelectorAll('[data-msg]').forEach((b) => {
        b.onclick = async (e) => {
          e.stopPropagation();
          const { data, error } = await window.db.rpc('open_dm', { p_other: b.dataset.msg });
          if (error) return UI.toast(error.message, true);
          await loadAll();
          openConv(convs.find((c) => c.id === data));
        };
      });
      box.querySelectorAll('.dm-item').forEach((el) => {
        el.onclick = () => UI.userCard(el.dataset.u);
      });
    }

    else {
      box.innerHTML = requests.length ? requests.map((r) => {
        const p = profiles[r.user_id] || { username: '…' };
        return `<div class="dm-item" data-u="${r.user_id}">
          ${UI.avatar(p, 34)}
          <div class="nm"><b>${MD.esc(p.display_name || p.username)}</b><small>wants to be friends</small></div>
          <button class="btn btn-primary btn-sm" data-ok="${r.user_id}">Accept</button>
          <button class="btn btn-quiet btn-sm" data-no="${r.user_id}"><i class="fa-solid fa-xmark"></i></button>
        </div>`;
      }).join('') : '<div class="dm-empty">No pending requests.</div>';
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
    $('convSub').textContent = c.is_group ? `${c.people.length + 1} members` : '@' + (c.people[0]?.username || '');
    $('convSub').classList.remove('hidden');
    $('btnConvInfo').classList.remove('hidden');
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
    (attCache[mid] || []).forEach((a) => host.appendChild(Viewer.render(a)));
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
        if (!await UI.confirmDialog('Delete message', 'This removes it for everyone.', true)) return;
        const { error } = await window.db.from('dm_messages').delete().eq('id', id);
        if (error) UI.toast(error.message, true); else el.remove();
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

  function listen(cid) {
    if (sub) window.db.removeChannel(sub);
    sub = window.db.channel('dm:' + cid)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'dm_messages', filter: `conversation_id=eq.${cid}` }, async (p) => {
        const m = p.new;
        if (document.querySelector(`.m[data-id="${m.id}"]`)) return;
        await profileOf(m.author_id);
        const box = $('msgs');
        const stick = box.scrollHeight - box.scrollTop - box.clientHeight < 180;
        const last = box.querySelector('.m:last-of-type');
        box.insertAdjacentHTML('beforeend', row(m, last ? grouped(last.dataset.au, last.dataset.ts, m) : false));
        wire(box.lastElementChild);
        let { data: aa } = await window.db.from('dm_message_attachments')
          .select('*').eq('message_id', m.id).order('position', { ascending: true });
        if (!aa) ({ data: aa } = await window.db.from('dm_message_attachments').select('*').eq('message_id', m.id));
        if (aa?.length) { attCache[m.id] = aa; paintAtts(m.id); }
        if (stick || m.author_id === me.id) box.scrollTop = box.scrollHeight;
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
      })
      .subscribe();
  }

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
      loadAll();
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
    profiles[me.id] = me;
    $('meAv').innerHTML = UI.avatar(me, 28);
    $('meName').textContent = me.display_name || me.username;
    $('meHandle').textContent = '@' + me.username;
    composer(); newModal();
    await loadAll();
    const want = new URLSearchParams(location.search).get('c');
    if (want) openConv(convs.find((c) => c.id === want));
  })();
})();
