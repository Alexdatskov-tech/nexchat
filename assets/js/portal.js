(function () {
  const $ = (id) => document.getElementById(id);
  let me = null;

  // Deterministic banner per server, drawn from the accent's own hue family so
  // the grid stays cohesive instead of turning into random neon.
  // Default banner is a clean light neutral until an owner uploads one.
  const DEFAULT_BANNER = 'linear-gradient(135deg,#F2F3F6 0%,#D5D8DF 48%,#BFC3CC 100%)';
  function banner() { return DEFAULT_BANNER; }

  // Applies the saved dashboard background from profiles.theme.
  function applyDashboardBg(theme) {
    const t = theme || {};
    if (!t.dash_bg) { document.body.classList.remove('has-bg'); return; }
    document.body.classList.add('has-bg');
    document.documentElement.style.setProperty('--dash-bg', t.dash_bg);
    document.documentElement.style.setProperty('--dash-dim', (t.dash_dim ?? 0) / 100);
    document.documentElement.style.setProperty('--dash-blur', (t.dash_blur ?? 0) + 'px');
    document.documentElement.style.setProperty('--dash-bright', (t.dash_bright ?? 100) / 100);
    if (!document.querySelector('.dash-veil')) {
      const v = document.createElement('div');
      v.className = 'dash-veil';
      document.body.appendChild(v);
    }
  }

  function card(s) {
    const count = s.server_members?.[0]?.count ?? 0;
    const owner = s.owner_id === me.id;
    const bg = s.banner_url ? `background-image:url('${UI.esc(s.banner_url)}')` : `background:${banner()}`;
    const ico = s.icon_url ? `<img src="${UI.esc(s.icon_url)}" alt="">` : UI.initial(s.name);
    return `
      <button class="scard" data-id="${s.id}">
        <div class="scard-banner" style="${bg};background-size:cover;"></div>
        <div class="scard-ico">${ico}</div>
        <div class="scard-body">
          <div class="scard-name">
            <span>${UI.esc(s.name)}</span>
            ${owner ? '<span class="badge badge-owner">Owner</span>' : ''}
          </div>
          <div class="scard-desc">${UI.esc(s.description || 'No description.')}</div>
          <div class="scard-meta"><i class="fa-solid fa-user-group"></i> ${count} member${count === 1 ? '' : 's'}</div>
        </div>
      </button>`;
  }

  async function load() {
    const { data: mem, error } = await window.db.from('server_members').select('server_id').eq('user_id', me.id);
    $('skeleton').classList.add('hidden');
    if (error) return UI.toast('Could not load servers: ' + error.message, true);

    if (!mem.length) {
      $('empty').classList.remove('hidden');
      $('serverCount').textContent = 'No servers yet';
      return;
    }

    const { data: servers, error: e2 } = await window.db
      .from('servers').select('*, server_members(count)')
      .in('id', mem.map((m) => m.server_id))
      .order('created_at', { ascending: true });
    if (e2) return UI.toast('Could not load servers: ' + e2.message, true);

    $('serverCount').textContent = `${servers.length} server${servers.length === 1 ? '' : 's'}`;
    const grid = $('grid');
    grid.innerHTML = servers.map(card).join('');
    grid.classList.remove('hidden');
    grid.querySelectorAll('.scard').forEach((el) => {
      el.onclick = () => { window.location.href = `server.html?id=${el.dataset.id}`; };
    });
  }

  // ---- modals ----
  function bindModal(id) {
    const m = $(id);
    m.querySelectorAll('[data-close]').forEach((b) => { b.onclick = () => m.classList.add('hidden'); });
    m.onclick = (e) => { if (e.target === m) m.classList.add('hidden'); };
    return m;
  }
  const mCreate = bindModal('mCreate'), mJoin = bindModal('mJoin');

  const openCreate = () => {
    $('cName').value = ''; $('cDesc').value = ''; $('cErr').textContent = '';
    $('cIconPrev').innerHTML = '<i class="fa-solid fa-image"></i>'; iconFile = null;
    mCreate.classList.remove('hidden'); setTimeout(() => $('cName').focus(), 60);
  };
  const openJoin = () => {
    $('jCode').value = ''; $('jErr').textContent = '';
    mJoin.classList.remove('hidden'); setTimeout(() => $('jCode').focus(), 60);
  };
  $('btnCreate').onclick = openCreate; $('btnCreate2').onclick = openCreate;
  $('btnJoin').onclick = openJoin; $('btnJoin2').onclick = openJoin;

  let iconFile = null;
  $('cIcon').onchange = (e) => {
    const f = e.target.files[0]; if (!f) return;
    iconFile = f;
    const r = new FileReader();
    r.onload = (ev) => { $('cIconPrev').innerHTML = `<img src="${ev.target.result}" alt="">`; };
    r.readAsDataURL(f);
  };

  $('cGo').onclick = async () => {
    const name = $('cName').value.trim();
    if (name.length < 2) return ($('cErr').textContent = 'Give it a name — at least 2 characters.');
    const btn = $('cGo'); btn.disabled = true; btn.textContent = 'Creating…';
    try {
      const { data: srv, error } = await window.db.from('servers')
        .insert({ name, description: $('cDesc').value.trim() || null, owner_id: me.id })
        .select().single();
      if (error) throw error;

      if (iconFile) {
        try {
          const url = await UI.upload('server-icons', iconFile, srv.id);
          await window.db.from('servers').update({ icon_url: url }).eq('id', srv.id);
        } catch (_) { /* icon is optional — never block server creation on it */ }
      }
      window.location.href = `server.html?id=${srv.id}`;
    } catch (err) {
      $('cErr').textContent = err.message || 'Could not create that server.';
      btn.disabled = false; btn.textContent = 'Create server';
    }
  };

  $('jGo').onclick = async () => {
    let code = $('jCode').value.trim();
    if (code.includes('/')) code = code.split('/').filter(Boolean).pop();
    if (code.includes('=')) code = code.split('=').pop();
    if (!code) return ($('jErr').textContent = 'Paste an invite code.');
    const btn = $('jGo'); btn.disabled = true; btn.textContent = 'Joining…';
    try {
      const { data: id, error } = await window.db.rpc('join_server_by_invite', { p_code: code });
      if (error) throw error;
      window.location.href = `server.html?id=${id}`;
    } catch (err) {
      $('jErr').textContent = err.message || 'That code didn\u2019t work.';
      btn.disabled = false; btn.textContent = 'Join';
    }
  };

  $('btnOut').onclick = async () => { await window.db.auth.signOut(); window.location.href = 'index.html'; };

  (async () => {
    const s = await UI.requireSession(); if (!s) return;
    me = await UI.myProfile(s.user.id);
    if (!me) { UI.toast('Profile missing — try signing out and back in.', true); return; }
    applyDashboardBg(me.theme);
    $('meAv').innerHTML = UI.avatar(me, 24);
    $('meName').textContent = me.display_name || me.username;
    if (me.is_platform_admin) $('adminLink').style.display = '';

    // Deep link: portal.html?invite=CODE opens the join box pre-filled.
    const inv = new URLSearchParams(location.search).get('invite');
    if (inv) { openJoin(); $('jCode').value = inv; }

    await load();
  })();
})();
