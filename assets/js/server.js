(function () {
  const $ = (id) => document.getElementById(id);
  const S3 = () => window.__nx_tp;
  let me = null, srv = null, serverId = null;
  let channels = [], active = null, sub = null, canManage = false;
  let voiceChan = null, voicePoll = null;
  const profiles = {}, rx = {}, attCache = {};
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
      return `<div class="chan ${c.id === active?.id || inHere ? 'on' : ''}" data-id="${c.id}" data-voice="${isVoice}">
          <i class="fa-solid ${chanIcon(c.type)}"></i><span>${MD.esc(c.name)}</span>
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
      ? `<div class="m-gutter"><span class="hovertime">${new Date(m.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span></div>`
      : `<div class="m-av">${UI.avatar(p, 38)}</div>`;
    const head = grouped ? '' :
      `<div class="m-head"><span class="m-name" style="color:${p.accent_color || 'var(--txt-1)'}">${MD.esc(name)}</span>
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
    const list = attCache[mid] || [];
    host.innerHTML = '';
    list.forEach((a) => host.appendChild(Viewer.render(a)));
  }

  const grouped = (pa, pt, m) => pa === m.author_id && (new Date(m.created_at) - new Date(pt)) < 5 * 60 * 1000;

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
      const [{ data: rr }, { data: aa }] = await Promise.all([
        window.db.from('message_reactions').select('*').in('message_id', ids),
        window.db.from('message_attachments').select('*').in('message_id', ids),
      ]);
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
      const rxb = el.querySelector('.a-rx');
      if (rxb) rxb.onclick = (ev) => { ev.stopPropagation(); picker(ev.currentTarget, el, id); };
      const edb = el.querySelector('.a-ed');
      if (edb) edb.onclick = (ev) => { ev.stopPropagation(); edit(el, id); };
      const dlb = el.querySelector('.a-del');
      if (dlb) dlb.onclick = async (ev) => {
        ev.stopPropagation();
        if (!await UI.confirmDialog('Delete message', 'This removes it for everyone.', true)) return;
        const { error } = await window.db.from('messages').delete().eq('id', id);
        if (error) UI.toast(error.message, true);
        else document.querySelector(`.m[data-id="${id}"]`)?.remove();
      };
    });
  }

  function picker(btn, rowEl, mid) {
    document.querySelectorAll('.picker').forEach((p) => p.remove());
    const p = document.createElement('div');
    p.className = 'picker';
    p.innerHTML = QUICK.map((e) => `<button data-e="${e}">${e}</button>`).join('');
    rowEl.appendChild(p);
    p.querySelectorAll('button').forEach((b) => {
      b.onclick = (ev) => { ev.stopPropagation(); toggleRx(mid, b.dataset.e); p.remove(); };
    });
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
        box.insertAdjacentHTML('beforeend', row(m, last ? grouped(last.dataset.au, last.dataset.ts, m) : false));
        const el = box.lastElementChild;
        wire(el);
        const { data: aa } = await window.db.from('message_attachments').select('*').eq('message_id', m.id);
        if (aa?.length) { attCache[m.id] = aa; paintAtts(m.id); }
        if (stick || m.author_id === me.id) box.scrollTop = box.scrollHeight;
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

      if (files.length) {
        const bar = $('upbar'); bar.classList.remove('hidden');
        const fill = bar.querySelector('i');
        let done = 0;
        for (const f of files) {
          try {
            const key = `nexchat/${serverId}/${active.id}/${Date.now()}-${f.name.replace(/[^\w.\-]/g, '_')}`;
            const up = await S3().put(key, f, (p) => {
              fill.style.width = Math.round(((done + p / 100) / files.length) * 100) + '%';
            });
            await window.db.from('message_attachments').insert({
              message_id: msg.id, url: up.url, file_name: f.name, file_size: f.size, mime_type: up.type,
            });
          } catch (err) { UI.toast(`${f.name}: ${err.message}`, true); }
          done++;
          fill.style.width = Math.round((done / files.length) * 100) + '%';
        }
        setTimeout(() => { bar.classList.add('hidden'); fill.style.width = '0'; }, 400);

        const { data: aa } = await window.db.from('message_attachments').select('*').eq('message_id', msg.id);
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
  function paintVoice(st) {
    renderChannels();
    const dock = $('vcDock'), stageEl = $('stage');
    if (!st.active) {
      dock.classList.add('hidden');
      stageEl.classList.add('hidden');
      return;
    }
    dock.classList.remove('hidden');
    $('vcName').textContent = st.channel.name;
    $('vcCount').textContent = `${st.members.size} connected · ${srv.name}`;
    $('vcMute').classList.toggle('on', st.muted);
    $('vcMute').innerHTML = `<i class="fa-solid fa-microphone${st.muted ? '-slash' : ''}"></i>`;
    $('vcDeaf').classList.toggle('on', st.deaf);
    $('vcCam').classList.toggle('on', st.cam);
    $('vcShare').classList.toggle('on', st.sharing);

    const showStage = st.cam || st.sharing || [...st.members.values()].some((p) => p.cam || p.sharing);
    stageEl.classList.toggle('hidden', !showStage);
    if (!showStage) return;

    const grid = $('stageGrid');
    [...st.members.values()].forEach((p) => {
      const isMe = p.id === me.id;
      let tile = grid.querySelector(`[data-t="${p.id}"]`);
      if (!tile) {
        tile = document.createElement('div');
        tile.className = 'tile';
        tile.dataset.t = p.id;
        tile.innerHTML = `<video autoplay playsinline ${isMe ? 'muted' : ''}></video>
          <div class="tile-av"></div>
          <div class="tile-tag"><span>${MD.esc(p.display_name || p.username)}${isMe ? ' (you)' : ''}</span></div>`;
        grid.appendChild(tile);
      }
      const v = tile.querySelector('video');
      const stream = isMe ? Voice.localStream() : Voice.peerStream(p.id);
      const hasVid = stream && stream.getVideoTracks().some((t) => t.readyState === 'live');
      if (stream && v.srcObject !== stream) v.srcObject = stream;
      v.style.display = hasVid ? '' : 'none';
      tile.querySelector('.tile-av').innerHTML = hasVid ? '' : UI.avatar(p, 52, { halo: false });
      tile.querySelector('.tile-tag').innerHTML =
        `${p.muted ? '<i class="fa-solid fa-microphone-slash muted"></i>' : ''}
         <span>${MD.esc(p.display_name || p.username)}${isMe ? ' (you)' : ''}</span>`;
      tile.querySelector('.tile-share')?.remove();
      if (p.sharing) tile.insertAdjacentHTML('beforeend', '<span class="tile-share">Screen</span>');
    });
    [...grid.children].forEach((t) => { if (!st.members.has(t.dataset.t)) t.remove(); });
  }

  async function joinVoice(ch) {
    const st = Voice.state();
    if (st.active && st.channel.id === ch.id) return;
    if (st.active) await Voice.leave();
    try {
      await Voice.join(ch, serverId, { ...me, muted: false, deaf: false, cam: false, sharing: false }, paintVoice);
      UI.toast(`Connected to ${ch.name}`);
    } catch { /* mic denied — Voice already surfaced the reason */ }
  }

  function voiceButtons() {
    $('vcMute').onclick = () => Voice.setMute();
    $('vcDeaf').onclick = () => Voice.setDeaf();
    $('vcCam').onclick = () => Voice.toggleCam();
    $('vcShare').onclick = () => Voice.toggleShare();
    $('vcLeave').onclick = async () => { await Voice.leave(); UI.toast('Left the voice channel.'); };
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

    $('miInvite').onclick = () => { menu.classList.add('hidden'); $('invOut').value = ''; mInv.classList.remove('hidden'); };
    $('invGo').onclick = async () => {
      const hrs = +$('invExpiry').value;
      const rowIn = { server_id: serverId, created_by: me.id };
      if (hrs) rowIn.expires_at = new Date(Date.now() + hrs * 3600e3).toISOString();
      const { data, error } = await window.db.from('invites').insert(rowIn).select().single();
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
        channels.filter((c) => c.type === 'category').map((c) => `<option value="${c.id}">${MD.esc(c.name)}</option>`).join('');
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
      UI.toast(`${name} created.`);
      loadChannels(type === 'voice' ? null : data.id);
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

    $('meAv').innerHTML = UI.avatar(me, 28);
    $('meName').textContent = me.display_name || me.username;
    $('meHandle').textContent = '@' + me.username;

    canManage = srv.owner_id === me.id || me.is_platform_admin;
    if (!canManage) {
      const { data: ok } = await window.db.rpc('has_permission', { p_server_id: serverId, p_user_id: me.id, p_bit: 8 });
      canManage = !!ok;
    }

    menus(); composer(); voiceButtons();
    await loadChannels();
  })();
})();
