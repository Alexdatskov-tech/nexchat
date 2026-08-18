(function () {
  const toast = document.getElementById('toast');
  function showToast(msg, isError) {
    toast.textContent = msg;
    toast.classList.toggle('error', !!isError);
    toast.classList.add('show');
    setTimeout(() => toast.classList.remove('show'), 3200);
  }

  function escapeHtml(str) {
    return (str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function initials(name) { return (name || '?').trim().charAt(0).toUpperCase(); }

  // ---- Minimal, safe Discord-style markdown subset ---------------------------
  function renderMarkdown(raw) {
    let text = escapeHtml(raw || '');
    text = text.replace(/```([\s\S]*?)```/g, (_, code) => `<pre><code>${code.trim()}</code></pre>`);
    text = text.replace(/`([^`\n]+)`/g, '<code>$1</code>');
    text = text.replace(/\*\*([^\*\n]+)\*\*/g, '<strong>$1</strong>');
    text = text.replace(/__([^_\n]+)__/g, '<u>$1</u>');
    text = text.replace(/~~([^~\n]+)~~/g, '<del>$1</del>');
    text = text.replace(/\*([^\*\n]+)\*/g, '<em>$1</em>');
    text = text.replace(/(^|[^\w])_([^_\n]+)_(?!\w)/g, '$1<em>$2</em>');
    text = text.replace(/^&gt; ?(.*)$/gm, '<blockquote>$1</blockquote>');
    text = text.replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>');
    return text;
  }

  function timeLabel(iso) {
    const d = new Date(iso);
    const now = new Date();
    const sameDay = d.toDateString() === now.toDateString();
    const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    return sameDay ? `Today at ${time}` : `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} at ${time}`;
  }

  const REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🔥'];

  let currentUserId = null;
  let serverId = null;
  let activeChannelId = null;
  let activeChannelName = '';
  let channels = [];
  let msgChannel = null;      // current realtime channel subscription
  let profileCache = {};      // user_id -> {username, display_name, avatar_url}
  const messageReactions = {}; // message_id -> {emoji: {count, mine}}

  async function requireSession() {
    const { data } = await window.db.auth.getSession();
    if (!data.session) { window.location.href = 'index.html'; return null; }
    return data.session;
  }

  async function getProfile(userId) {
    if (profileCache[userId]) return profileCache[userId];
    const { data } = await window.db.from('profiles').select('username, display_name, avatar_url').eq('id', userId).single();
    profileCache[userId] = data || { username: 'unknown', display_name: 'Unknown' };
    return profileCache[userId];
  }

  // ---- Boot ------------------------------------------------------------------
  (async () => {
    const session = await requireSession();
    if (!session) return;
    currentUserId = session.user.id;

    const params = new URLSearchParams(window.location.search);
    serverId = params.get('id');
    if (!serverId) { window.location.href = 'portal.html'; return; }

    const { data: server, error } = await window.db
      .from('servers')
      .select('*, server_members(count)')
      .eq('id', serverId)
      .single();

    if (error || !server) {
      document.getElementById('notFoundState').classList.remove('hidden');
      return;
    }

    document.getElementById('appShell').classList.remove('hidden');
    document.getElementById('serverNameLabel').textContent = server.name;
    const count = server.server_members?.[0]?.count ?? 0;
    document.getElementById('memberCountLabel').textContent = `${count} member${count === 1 ? '' : 's'}`;

    await loadChannels();
    wireServerMenu();
    wireComposer();
    wireMobileToggle();
  })();

  // ---- Channels ----------------------------------------------------------------
  async function loadChannels() {
    const { data, error } = await window.db
      .from('channels')
      .select('*')
      .eq('server_id', serverId)
      .order('position', { ascending: true });

    if (error) { showToast('Could not load channels: ' + error.message, true); return; }
    channels = data;
    renderChannelList();

    const firstText = channels.find((c) => c.type === 'text' || c.type === 'announcement');
    if (firstText) selectChannel(firstText);
  }

  function renderChannelList() {
    const listEl = document.getElementById('channelList');
    const categories = channels.filter((c) => c.type === 'category');
    const orphans = channels.filter((c) => c.type !== 'category' && !c.parent_id);

    let html = '';
    const renderChannelItem = (c) => {
      const icon = c.type === 'voice' || c.type === 'stage' ? 'fa-volume-high' : c.type === 'announcement' ? 'fa-bullhorn' : 'fa-hashtag';
      const disabled = c.type === 'voice' || c.type === 'stage';
      return `
        <div class="channel-item ${disabled ? 'voice-disabled' : ''} ${c.id === activeChannelId ? 'active' : ''}" data-id="${c.id}" data-disabled="${disabled}">
          <i class="fa-solid ${icon}"></i><span>${escapeHtml(c.name)}</span>
        </div>`;
    };

    categories.forEach((cat) => {
      const children = channels.filter((c) => c.parent_id === cat.id).sort((a, b) => a.position - b.position);
      html += `<div class="channel-category"><i class="fa-solid fa-chevron-down"></i> ${escapeHtml(cat.name)}</div>`;
      html += `<div class="channel-group">${children.map(renderChannelItem).join('')}</div>`;
    });
    if (orphans.length) html += orphans.map(renderChannelItem).join('');

    listEl.innerHTML = html;

    listEl.querySelectorAll('.channel-category').forEach((el) => {
      el.addEventListener('click', () => el.classList.toggle('collapsed'));
    });
    listEl.querySelectorAll('.channel-item').forEach((el) => {
      el.addEventListener('click', () => {
        if (el.dataset.disabled === 'true') { showToast('Voice channels aren\u2019t built yet — text channels work fully.'); return; }
        const ch = channels.find((c) => c.id === el.dataset.id);
        if (ch) selectChannel(ch);
        document.getElementById('channelRail').classList.remove('open');
      });
    });
  }

  async function selectChannel(channel) {
    activeChannelId = channel.id;
    activeChannelName = channel.name;
    renderChannelList();

    document.getElementById('channelIcon').innerHTML = `<i class="fa-solid ${channel.type === 'announcement' ? 'fa-bullhorn' : 'fa-hashtag'}"></i>`;
    document.getElementById('channelNameLabel').textContent = channel.name;
    const topicEl = document.getElementById('channelTopicLabel');
    if (channel.topic) { topicEl.textContent = channel.topic; topicEl.classList.remove('hidden'); }
    else topicEl.classList.add('hidden');

    document.getElementById('composerInput').placeholder = `Message #${channel.name}`;
    document.getElementById('composer').classList.remove('hidden');
    document.getElementById('channelEmptyState').classList.add('hidden');

    await loadMessages(channel.id);
    subscribeRealtime(channel.id);
  }

  // ---- Messages -----------------------------------------------------------------
  async function loadMessages(channelId) {
    const listEl = document.getElementById('messageList');
    listEl.innerHTML = `<div style="text-align:center; padding:2rem; color:var(--text-muted);"><i class="fa-solid fa-circle-notch fa-spin"></i></div>`;

    const { data: msgs, error } = await window.db
      .from('messages')
      .select('*, profiles(username, display_name, avatar_url)')
      .eq('channel_id', channelId)
      .order('created_at', { ascending: true })
      .limit(80);

    if (error) { listEl.innerHTML = ''; showToast('Could not load messages: ' + error.message, true); return; }

    msgs.forEach((m) => { if (m.profiles) profileCache[m.author_id] = m.profiles; });

    const ids = msgs.map((m) => m.id);
    Object.keys(messageReactions).forEach((k) => delete messageReactions[k]);
    if (ids.length) {
      const { data: reactions } = await window.db.from('message_reactions').select('*').in('message_id', ids);
      (reactions || []).forEach((r) => addReactionToState(r.message_id, r.emoji, r.user_id));
    }

    listEl.innerHTML = '';
    let lastAuthor = null, lastTime = 0;
    msgs.forEach((m) => {
      const t = new Date(m.created_at).getTime();
      const compact = m.author_id === lastAuthor && (t - lastTime) < 5 * 60 * 1000;
      listEl.insertAdjacentHTML('beforeend', messageRowHtml(m, compact));
      lastAuthor = m.author_id; lastTime = t;
    });
    wireMessageRows();
    scrollToBottom(true);
  }

  function addReactionToState(messageId, emoji, userId) {
    if (!messageReactions[messageId]) messageReactions[messageId] = {};
    if (!messageReactions[messageId][emoji]) messageReactions[messageId][emoji] = { count: 0, mine: false, users: [] };
    const bucket = messageReactions[messageId][emoji];
    if (!bucket.users.includes(userId)) {
      bucket.users.push(userId);
      bucket.count++;
      if (userId === currentUserId) bucket.mine = true;
    }
  }
  function removeReactionFromState(messageId, emoji, userId) {
    const bucket = messageReactions[messageId]?.[emoji];
    if (!bucket) return;
    bucket.users = bucket.users.filter((u) => u !== userId);
    bucket.count = bucket.users.length;
    if (userId === currentUserId) bucket.mine = false;
    if (bucket.count <= 0) delete messageReactions[messageId][emoji];
  }

  function reactionRowHtml(messageId) {
    const map = messageReactions[messageId];
    if (!map || !Object.keys(map).length) return '';
    return `<div class="reaction-row">${Object.entries(map).map(([emoji, v]) =>
      `<span class="reaction-pill ${v.mine ? 'mine' : ''}" data-msg="${messageId}" data-emoji="${emoji}">${emoji} ${v.count}</span>`
    ).join('')}</div>`;
  }

  function messageRowHtml(m, compact) {
    const author = m.profiles || profileCache[m.author_id] || { username: 'unknown', display_name: 'Unknown' };
    const name = author.display_name || author.username;
    const mine = m.author_id === currentUserId;

    const avatarBlock = compact
      ? `<div class="msg-avatar-slot"><span class="msg-time-hover">${new Date(m.created_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</span></div>`
      : `<div class="msg-avatar">${author.avatar_url ? `<img src="${author.avatar_url}" alt="" />` : `<div class="avatar-circle">${initials(name)}</div>`}</div>`;

    const headerBlock = compact ? '' : `
      <div class="msg-meta">
        <span class="msg-author">${escapeHtml(name)}</span>
        <span class="msg-time">${timeLabel(m.created_at)}</span>
      </div>`;

    return `
      <div class="msg-row ${compact ? 'compact' : ''}" data-id="${m.id}" data-author="${m.author_id}">
        ${avatarBlock}
        <div class="msg-body">
          ${headerBlock}
          <div class="msg-content" data-raw="${escapeHtml(m.content || '')}">${renderMarkdown(m.content)}${m.edited_at ? '<span class="edited-tag">(edited)</span>' : ''}</div>
          <div class="reaction-slot">${reactionRowHtml(m.id)}</div>
        </div>
        <div class="msg-actions">
          <button class="act-react" title="React"><i class="fa-regular fa-face-smile"></i></button>
          ${mine ? '<button class="act-edit" title="Edit"><i class="fa-solid fa-pen"></i></button>' : ''}
          <button class="act-delete" title="Delete"><i class="fa-solid fa-trash-can"></i></button>
        </div>
      </div>`;
  }

  function wireMessageRows() {
    document.querySelectorAll('.msg-row').forEach((row) => {
      const id = row.dataset.id;
      const author = row.dataset.author;
      const mine = author === currentUserId;

      row.querySelector('.act-react')?.addEventListener('click', (e) => openEmojiPicker(e.currentTarget, id));

      row.querySelector('.act-delete')?.addEventListener('click', async () => {
        if (!confirm('Delete this message?')) return;
        const { error } = await window.db.from('messages').delete().eq('id', id);
        if (error) showToast('Could not delete: ' + error.message, true);
      });

      if (mine) {
        row.querySelector('.act-edit')?.addEventListener('click', () => startEdit(row, id));
      }

      row.querySelectorAll('.reaction-pill').forEach((pill) => {
        pill.addEventListener('click', () => toggleReaction(pill.dataset.msg, pill.dataset.emoji));
      });
    });
  }

  function openEmojiPicker(anchorBtn, messageId) {
    document.querySelectorAll('.emoji-picker').forEach((p) => p.remove());
    const picker = document.createElement('div');
    picker.className = 'emoji-picker';
    picker.innerHTML = REACTIONS.map((e) => `<button data-e="${e}">${e}</button>`).join('');
    anchorBtn.closest('.msg-row').style.position = 'relative';
    anchorBtn.closest('.msg-row').appendChild(picker);
    picker.querySelectorAll('button').forEach((b) => {
      b.addEventListener('click', () => { toggleReaction(messageId, b.dataset.e); picker.remove(); });
    });
    setTimeout(() => {
      document.addEventListener('click', function outside(ev) {
        if (!picker.contains(ev.target) && ev.target !== anchorBtn) { picker.remove(); document.removeEventListener('click', outside); }
      });
    }, 0);
  }

  async function toggleReaction(messageId, emoji) {
    const mine = messageReactions[messageId]?.[emoji]?.mine;
    if (mine) {
      await window.db.from('message_reactions').delete().eq('message_id', messageId).eq('user_id', currentUserId).eq('emoji', emoji);
    } else {
      await window.db.from('message_reactions').insert({ message_id: messageId, user_id: currentUserId, emoji });
    }
    // Realtime subscription (below) reconciles UI; no local mutation needed here.
  }

  function startEdit(row, id) {
    const contentEl = row.querySelector('.msg-content');
    const raw = contentEl.dataset.raw.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"');
    const box = document.createElement('div');
    box.className = 'edit-box';
    box.innerHTML = `<textarea rows="2">${raw}</textarea><span class="hint">Enter to save · Escape to cancel</span>`;
    contentEl.replaceWith(box);
    const ta = box.querySelector('textarea');
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);

    const cancel = () => { box.replaceWith(contentEl); };
    ta.addEventListener('keydown', async (e) => {
      if (e.key === 'Escape') { cancel(); return; }
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        const newContent = ta.value.trim();
        if (!newContent) return;
        const { error } = await window.db.from('messages').update({ content: newContent, edited_at: new Date().toISOString() }).eq('id', id);
        if (error) showToast('Could not save edit: ' + error.message, true);
        // Realtime UPDATE event will replace the row content.
      }
    });
  }

  function scrollToBottom(force) {
    const list = document.getElementById('messageList');
    const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 150;
    if (force || nearBottom) list.scrollTop = list.scrollHeight;
  }

  // ---- Realtime ------------------------------------------------------------------
  function subscribeRealtime(channelId) {
    if (msgChannel) window.db.removeChannel(msgChannel);

    msgChannel = window.db
      .channel('room-' + channelId)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages', filter: `channel_id=eq.${channelId}` }, async (payload) => {
        const m = payload.new;
        const author = await getProfile(m.author_id);
        const list = document.getElementById('messageList');
        const lastRow = list.lastElementChild;
        const compact = lastRow && lastRow.dataset.author === m.author_id &&
          (new Date(m.created_at).getTime() - new Date(lastRow.dataset.ts || 0).getTime()) < 5 * 60 * 1000;
        list.insertAdjacentHTML('beforeend', messageRowHtml({ ...m, profiles: author }, !!compact));
        const inserted = list.lastElementChild;
        inserted.dataset.ts = m.created_at;
        wireRowById(m.id);
        scrollToBottom(false);
      })
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'messages', filter: `channel_id=eq.${channelId}` }, (payload) => {
        const m = payload.new;
        const row = document.querySelector(`.msg-row[data-id="${m.id}"]`);
        if (!row) return;
        const existing = row.querySelector('.edit-box, .msg-content');
        const replacement = document.createElement('div');
        replacement.className = 'msg-content';
        replacement.dataset.raw = escapeHtml(m.content || '');
        replacement.innerHTML = renderMarkdown(m.content) + (m.edited_at ? '<span class="edited-tag">(edited)</span>' : '');
        existing.replaceWith(replacement);
      })
      .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'messages', filter: `channel_id=eq.${channelId}` }, (payload) => {
        document.querySelector(`.msg-row[data-id="${payload.old.id}"]`)?.remove();
      })
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'message_reactions' }, (payload) => {
        const r = payload.new;
        if (!document.querySelector(`.msg-row[data-id="${r.message_id}"]`)) return;
        addReactionToState(r.message_id, r.emoji, r.user_id);
        refreshReactionRow(r.message_id);
      })
      .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'message_reactions' }, (payload) => {
        const r = payload.old;
        if (!document.querySelector(`.msg-row[data-id="${r.message_id}"]`)) return;
        removeReactionFromState(r.message_id, r.emoji, r.user_id);
        refreshReactionRow(r.message_id);
      })
      .subscribe();
  }

  function refreshReactionRow(messageId) {
    const row = document.querySelector(`.msg-row[data-id="${messageId}"] .reaction-slot`);
    if (!row) return;
    row.innerHTML = reactionRowHtml(messageId);
    row.querySelectorAll('.reaction-pill').forEach((pill) => {
      pill.addEventListener('click', () => toggleReaction(pill.dataset.msg, pill.dataset.emoji));
    });
  }

  function wireRowById(id) {
    const row = document.querySelector(`.msg-row[data-id="${id}"]`);
    if (!row) return;
    const author = row.dataset.author;
    row.querySelector('.act-react')?.addEventListener('click', (e) => openEmojiPicker(e.currentTarget, id));
    if (author === currentUserId) row.querySelector('.act-edit')?.addEventListener('click', () => startEdit(row, id));
    row.querySelector('.act-delete')?.addEventListener('click', async () => {
      if (!confirm('Delete this message?')) return;
      await window.db.from('messages').delete().eq('id', id);
    });
  }

  // ---- Composer ------------------------------------------------------------------
  function wireComposer() {
    const input = document.getElementById('composerInput');
    const send = async () => {
      const content = input.value.trim();
      if (!content || !activeChannelId) return;
      input.value = '';
      input.style.height = 'auto';
      const { error } = await window.db.from('messages').insert({ channel_id: activeChannelId, author_id: currentUserId, content });
      if (error) showToast('Could not send: ' + error.message, true);
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
    });
    input.addEventListener('input', () => {
      input.style.height = 'auto';
      input.style.height = Math.min(input.scrollHeight, 160) + 'px';
    });
    document.getElementById('btnSend').addEventListener('click', send);
  }

  // ---- Server menu + invites ------------------------------------------------------
  function wireServerMenu() {
    const btn = document.getElementById('btnServerMenu');
    const menu = document.getElementById('serverMenu');
    btn.addEventListener('click', (e) => { e.stopPropagation(); menu.classList.toggle('hidden'); });
    document.addEventListener('click', () => menu.classList.add('hidden'));

    document.getElementById('menuInvite').addEventListener('click', () => {
      menu.classList.add('hidden');
      document.getElementById('inviteCodeOutput').value = '';
      document.getElementById('inviteModal').classList.remove('hidden');
    });
    document.getElementById('menuSettings').addEventListener('click', () => {
      menu.classList.add('hidden');
      showToast('Server settings (roles, theming) isn\u2019t built yet.');
    });

    const inviteModal = document.getElementById('inviteModal');
    document.getElementById('closeInviteModal').addEventListener('click', () => inviteModal.classList.add('hidden'));
    inviteModal.addEventListener('click', (e) => { if (e.target === inviteModal) inviteModal.classList.add('hidden'); });

    document.getElementById('btnGenerateInvite').addEventListener('click', async () => {
      const { data, error } = await window.db.from('invites').insert({ server_id: serverId, created_by: currentUserId }).select().single();
      if (error) { showToast('Could not create invite: ' + error.message, true); return; }
      document.getElementById('inviteCodeOutput').value = data.code;
    });
    document.getElementById('btnCopyInvite').addEventListener('click', () => {
      const val = document.getElementById('inviteCodeOutput').value;
      if (!val) return;
      navigator.clipboard.writeText(val);
      showToast('Invite code copied.');
    });
  }

  function wireMobileToggle() {
    document.getElementById('btnMobileChannels').addEventListener('click', () => {
      document.getElementById('channelRail').classList.toggle('open');
    });
  }
})();
