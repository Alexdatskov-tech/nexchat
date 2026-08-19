(function () {
  const $ = (id) => document.getElementById(id);
  let me = null, users = [];

  document.querySelectorAll('.set-nav button[data-tab]').forEach((b) => {
    b.onclick = () => {
      document.querySelectorAll('.set-nav button[data-tab]').forEach((x) => x.classList.remove('on'));
      b.classList.add('on');
      document.querySelectorAll('[data-pane]').forEach((p) => p.classList.toggle('hidden', p.dataset.pane !== b.dataset.tab));
      if (b.dataset.tab === 'users') loadUsers();
      window.scrollTo(0, 0);
    };
  });

  async function loadRequests() {
    const { data, error } = await window.db.from('nitro_requests')
      .select('*, profiles!user_id(username,display_name,avatar_url,accent_color,is_nitro)')
      .order('created_at', { ascending: false });
    if (error) return UI.toast(error.message, true);

    const pending = (data || []).filter((r) => r.status === 'pending');
    $('pendCount').innerHTML = pending.length ? `<span class="badge badge-admin" style="margin-left:auto;">${pending.length}</span>` : '';

    $('reqRows').innerHTML = (data || []).map((r) => {
      const p = r.profiles || { username: 'unknown' };
      const tag = r.status === 'pending' ? '' :
        `<span class="badge ${r.status === 'approved' ? 'badge-admin' : 'badge-owner'}">${r.status}</span>`;
      return `<div class="lrow" data-id="${r.id}" data-u="${r.user_id}">
        ${UI.avatar(p, 32, { presence: true })}
        <div class="lmain">
          <b>${UI.esc(p.display_name || p.username)} ${tag}</b>
          <small>${UI.esc(r.message || 'No message')} · ${new Date(r.created_at).toLocaleDateString()}</small>
        </div>
        ${r.status === 'pending' ? `<div class="lacts">
          <button class="btn btn-quiet btn-sm r-no">Decline</button>
          <button class="btn btn-primary btn-sm r-yes">Approve</button>
        </div>` : ''}
      </div>`;
    }).join('') || '<div class="empty"><div class="ico"><i class="fa-solid fa-inbox"></i></div><h3>Nothing waiting</h3><p>New Nitro requests land here.</p></div>';

    $('reqRows').querySelectorAll('.lrow').forEach((row) => {
      const id = row.dataset.id;
      row.querySelector('.r-yes')?.addEventListener('click', async () => {
        const { error } = await window.db.from('nitro_requests')
          .update({ status: 'approved', reviewed_by: me.id, reviewed_at: new Date().toISOString() }).eq('id', id);
        UI.toast(error ? error.message : 'Nitro granted.', !!error);
        loadRequests();
      });
      row.querySelector('.r-no')?.addEventListener('click', async () => {
        const note = prompt('Reason (optional)') || null;
        const { error } = await window.db.from('nitro_requests')
          .update({ status: 'denied', reviewed_by: me.id, reviewed_at: new Date().toISOString(), review_note: note }).eq('id', id);
        UI.toast(error ? error.message : 'Request declined.', !!error);
        loadRequests();
      });
    });
  }

  async function loadUsers() {
    if (!users.length) {
      const { data, error } = await window.db.from('profiles').select('*').order('created_at', { ascending: false }).limit(300);
      if (error) return UI.toast(error.message, true);
      users = data || [];
    }
    paintUsers();
  }

  function paintUsers() {
    const q = $('uSearch').value.trim().toLowerCase();
    const rows = users.filter((u) => !q || u.username.toLowerCase().includes(q) || (u.display_name || '').toLowerCase().includes(q));
    $('userRows').innerHTML = rows.map((u) => `
      <div class="lrow" data-u="${u.id}">
        ${UI.avatar(u, 32, { presence: true })}
        <div class="lmain">
          <b>${UI.esc(u.display_name || u.username)}
            ${u.is_nitro ? '<span class="badge badge-nitro"><i class="fa-solid fa-bolt"></i> Nitro</span>' : ''}
            ${u.is_platform_admin ? '<span class="badge badge-admin">Admin</span>' : ''}
            ${u.is_banned ? '<span class="badge" style="color:#FF8085;background:var(--danger-lo);">Banned</span>' : ''}
          </b>
          <small>@${UI.esc(u.username)} · joined ${new Date(u.created_at).toLocaleDateString()}</small>
        </div>
        ${u.id === me.id ? '<span class="badge badge-owner">You</span>' : `
        <div class="lacts">
          <button class="btn btn-quiet btn-sm u-ban" style="${u.is_banned ? '' : 'color:#FF8085;'}">${u.is_banned ? 'Unban' : 'Ban'}</button>
        </div>`}
      </div>`).join('') || '<div class="empty"><p>No one matches that.</p></div>';

    $('userRows').querySelectorAll('.u-ban').forEach((btn) => {
      btn.onclick = async () => {
        const uid = btn.closest('.lrow').dataset.u;
        const u = users.find((x) => x.id === uid);
        let reason = null;
        if (!u.is_banned) {
          if (!await UI.confirmDialog('Ban account', `${u.username} will be locked out of NexChat entirely.`, true)) return;
          reason = prompt('Reason (optional)') || null;
        }
        const { error } = await window.db.rpc('set_user_ban', { p_user_id: uid, p_banned: !u.is_banned, p_reason: reason });
        if (error) return UI.toast(error.message, true);
        u.is_banned = !u.is_banned; u.ban_reason = reason;
        UI.toast(u.is_banned ? 'Account banned.' : 'Account restored.');
        paintUsers();
      };
    });
  }
  $('uSearch').oninput = paintUsers;

  (async () => {
    const s = await UI.requireSession(); if (!s) return;
    me = await UI.myProfile(s.user.id);
    if (!me?.is_platform_admin) { $('denied').classList.remove('hidden'); return; }
    window.Notify?.start(me);
    window.Guard?.start(me);
    window.Presence?.start(me);
    window.Presence?.onChange(() => window.Presence.refreshDots());
    $('wrap').classList.remove('hidden');
    loadRequests();
  })();
})();
