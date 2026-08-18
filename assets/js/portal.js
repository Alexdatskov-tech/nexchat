(function () {
  const toast = document.getElementById('toast');
  function showToast(msg, isError) {
    toast.textContent = msg;
    toast.classList.toggle('error', !!isError);
    toast.classList.add('show');
    setTimeout(() => toast.classList.remove('show'), 3800);
  }

  function escapeHtml(str) {
    return (str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function initials(name) {
    return (name || '?').trim().charAt(0).toUpperCase();
  }

  // Deterministic gradient per server, staying within the brand's cyan→violet→gold
  // family instead of hashing into arbitrary, clashing rainbow hues.
  const BRAND_HUES = [192, 189, 258, 271, 291, 38];
  function fallbackBanner(seed) {
    let h = 0;
    for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
    const hue1 = BRAND_HUES[h % BRAND_HUES.length];
    const hue2 = BRAND_HUES[(h >> 3) % BRAND_HUES.length];
    return `linear-gradient(135deg, hsl(${hue1},62%,32%), hsl(${hue2},58%,22%))`;
  }

  let currentUserId = null;

  async function requireSession() {
    const { data } = await window.db.auth.getSession();
    if (!data.session) {
      window.location.href = 'index.html';
      return null;
    }
    return data.session;
  }

  async function loadHeader(session) {
    const { data: profile } = await window.db
      .from('profiles')
      .select('username, display_name, avatar_url')
      .eq('id', session.user.id)
      .single();

    const label = profile?.display_name || profile?.username || 'You';
    document.getElementById('userLabel').textContent = label;
    const avatarEl = document.getElementById('userAvatar');
    if (profile?.avatar_url) {
      avatarEl.style.background = `url(${profile.avatar_url}) center/cover`;
      avatarEl.textContent = '';
    } else {
      avatarEl.textContent = initials(label);
    }
  }

  function serverCardHtml(server) {
    const memberCount = server.server_members?.[0]?.count ?? 0;
    const isOwner = server.owner_id === currentUserId;
    const bannerStyle = server.banner_url
      ? `background-image:url('${server.banner_url}')`
      : `background:${fallbackBanner(server.id)}`;

    const iconInner = server.icon_url
      ? `<img src="${server.icon_url}" alt="" />`
      : `<div class="avatar-circle">${initials(server.name)}</div>`;

    return `
      <div class="glass-panel interactive server-card" data-id="${server.id}">
        <div class="banner" style="${bannerStyle}"></div>
        <div class="icon-wrap">${iconInner}</div>
        <div class="body">
          <div class="name">${escapeHtml(server.name)} ${isOwner ? '<span class="owner-pill">OWNER</span>' : ''}</div>
          <div class="desc">${escapeHtml(server.description || 'No description yet.')}</div>
          <div class="meta">
            <span><i class="fa-solid fa-users"></i> ${memberCount}</span>
          </div>
        </div>
      </div>`;
  }

  async function loadServers() {
    const { data: memberships, error: mErr } = await window.db
      .from('server_members')
      .select('server_id')
      .eq('user_id', currentUserId);

    document.getElementById('loadingState').classList.add('hidden');

    if (mErr) {
      showToast('Could not load your servers: ' + mErr.message, true);
      return;
    }

    if (!memberships.length) {
      document.getElementById('emptyState').classList.remove('hidden');
      document.getElementById('serverGrid').classList.add('hidden');
      return;
    }

    const ids = memberships.map((m) => m.server_id);
    const { data: servers, error: sErr } = await window.db
      .from('servers')
      .select('*, server_members(count)')
      .in('id', ids)
      .order('created_at', { ascending: true });

    if (sErr) {
      showToast('Could not load server details: ' + sErr.message, true);
      return;
    }

    const grid = document.getElementById('serverGrid');
    grid.innerHTML = servers.map(serverCardHtml).join('');
    grid.classList.remove('hidden');
    document.getElementById('emptyState').classList.add('hidden');

    grid.querySelectorAll('.server-card').forEach((card) => {
      card.addEventListener('click', () => {
        window.location.href = `server.html?id=${card.dataset.id}`;
      });
    });
  }

  // ---- Create server modal --------------------------------------------------
  const createModal = document.getElementById('createModal');
  let pendingIconFile = null;

  document.getElementById('btnOpenCreate').addEventListener('click', () => {
    document.getElementById('createNameInput').value = '';
    document.getElementById('createDescInput').value = '';
    document.getElementById('createError').textContent = '';
    document.getElementById('createIconPreview').innerHTML = '<i class="fa-solid fa-image"></i>';
    pendingIconFile = null;
    createModal.classList.remove('hidden');
  });
  document.getElementById('closeCreateModal').addEventListener('click', () => createModal.classList.add('hidden'));
  createModal.addEventListener('click', (e) => { if (e.target === createModal) createModal.classList.add('hidden'); });

  document.getElementById('createIconInput').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    pendingIconFile = file;
    const reader = new FileReader();
    reader.onload = (ev) => {
      document.getElementById('createIconPreview').innerHTML = `<img src="${ev.target.result}" alt="" />`;
    };
    reader.readAsDataURL(file);
  });

  document.getElementById('btnSubmitCreate').addEventListener('click', async () => {
    const name = document.getElementById('createNameInput').value.trim();
    const description = document.getElementById('createDescInput').value.trim();
    const errEl = document.getElementById('createError');
    const btn = document.getElementById('btnSubmitCreate');

    if (name.length < 2) {
      errEl.textContent = 'Give your server a name (at least 2 characters).';
      return;
    }

    btn.disabled = true;
    btn.textContent = 'Creating…';
    try {
      const { data: server, error } = await window.db
        .from('servers')
        .insert({ name, description: description || null, owner_id: currentUserId })
        .select()
        .single();
      if (error) throw error;

      if (pendingIconFile) {
        const ext = pendingIconFile.name.split('.').pop();
        const path = `${server.id}/icon-${Date.now()}.${ext}`;
        const { error: upErr } = await window.db.storage.from('server-icons').upload(path, pendingIconFile);
        if (!upErr) {
          const { data: pub } = window.db.storage.from('server-icons').getPublicUrl(path);
          await window.db.from('servers').update({ icon_url: pub.publicUrl }).eq('id', server.id);
        }
      }

      createModal.classList.add('hidden');
      showToast(`${name} is live — taking you in.`);
      window.location.href = `server.html?id=${server.id}`;
    } catch (err) {
      errEl.textContent = err.message || 'Could not create the server.';
    } finally {
      btn.disabled = false;
      btn.textContent = 'Create server';
    }
  });

  // ---- Join server modal ------------------------------------------------------
  const joinModal = document.getElementById('joinModal');
  document.getElementById('btnOpenJoin').addEventListener('click', () => {
    document.getElementById('joinCodeInput').value = '';
    document.getElementById('joinError').textContent = '';
    joinModal.classList.remove('hidden');
  });
  document.getElementById('closeJoinModal').addEventListener('click', () => joinModal.classList.add('hidden'));
  joinModal.addEventListener('click', (e) => { if (e.target === joinModal) joinModal.classList.add('hidden'); });

  document.getElementById('btnSubmitJoin').addEventListener('click', async () => {
    const code = document.getElementById('joinCodeInput').value.trim();
    const errEl = document.getElementById('joinError');
    const btn = document.getElementById('btnSubmitJoin');
    if (!code) { errEl.textContent = 'Enter an invite code.'; return; }

    btn.disabled = true;
    btn.textContent = 'Joining…';
    try {
      const { data: serverId, error } = await window.db.rpc('join_server_by_invite', { p_code: code });
      if (error) throw error;
      joinModal.classList.add('hidden');
      showToast('Joined! Taking you in.');
      window.location.href = `server.html?id=${serverId}`;
    } catch (err) {
      errEl.textContent = err.message || 'That invite code didn\u2019t work.';
    } finally {
      btn.disabled = false;
      btn.textContent = 'Join server';
    }
  });

  // ---- Sign out ----------------------------------------------------------------
  document.getElementById('btnSignOut').addEventListener('click', async () => {
    await window.db.auth.signOut();
    window.location.href = 'index.html';
  });

  // ---- Boot -----------------------------------------------------------------------
  (async () => {
    const session = await requireSession();
    if (!session) return;
    currentUserId = session.user.id;
    await loadHeader(session);
    await loadServers();
  })();
})();
