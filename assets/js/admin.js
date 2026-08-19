(function () {
  const $ = (id) => document.getElementById(id);
  let me = null, users = [];

  document.querySelectorAll('.set-nav button[data-tab]').forEach((b) => {
    b.onclick = () => {
      document.querySelectorAll('.set-nav button[data-tab]').forEach((x) => x.classList.remove('on'));
      b.classList.add('on');
      document.querySelectorAll('[data-pane]').forEach((p) => p.classList.toggle('hidden', p.dataset.pane !== b.dataset.tab));
      if (b.dataset.tab === 'users') loadUsers();
      if (b.dataset.tab === 'appeals') loadAppeals();
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

  async function loadAppeals({ quiet = false } = {}) {
    const { data, error } = await window.db.from('ban_appeals')
      .select('*, profiles!user_id(username,display_name,avatar_url,accent_color,is_banned)')
      .order('created_at', { ascending: false });

    if (error) {
      // The appeals table arrives with a migration that may not have been run
      // yet. Say so in the pane rather than nagging from whichever tab is open.
      const missing = error.code === 'PGRST205' || /schema cache|does not exist/i.test(error.message || '');
      $('appealCount').innerHTML = '';
      if (missing) {
        $('appealRows').innerHTML = `<div class="empty"><div class="ico"><i class="fa-solid fa-database"></i></div>
          <h3>Appeals aren't set up yet</h3>
          <p>Run <code>nexchat_patch6.sql</code> in the Supabase SQL editor to create the appeals table.</p></div>`;
        return;
      }
      $('appealRows').innerHTML = `<div class="empty"><div class="ico"><i class="fa-solid fa-triangle-exclamation"></i></div>
        <h3>Couldn't load appeals</h3><p>${UI.esc(error.message || 'Unknown error')}</p></div>`;
      if (!quiet) UI.toast(error.message, true);
      return;
    }

    const pending = (data || []).filter((a) => a.status === 'pending');
    $('appealCount').innerHTML = pending.length
      ? `<span class="badge badge-admin" style="margin-left:auto;">${pending.length}</span>` : '';

    $('appealRows').innerHTML = (data || []).map((a) => {
      const p = a.profiles || { username: 'unknown' };
      const tag = a.status === 'pending' ? ''
        : `<span class="badge ${a.status === 'accepted' ? 'badge-admin' : 'badge-owner'}">${a.status}</span>`;
      return `<div class="lrow" data-id="${a.id}" style="align-items:flex-start;">
        ${UI.avatar(p, 32)}
        <div class="lmain">
          <b>${UI.esc(p.display_name || p.username)} ${tag}</b>
          <small>@${UI.esc(p.username)} · ${new Date(a.created_at).toLocaleString()}</small>
          <div class="appeal-msg">${UI.esc(a.message)}</div>
          ${a.review_note ? `<small style="display:block;margin-top:6px;">Note: ${UI.esc(a.review_note)}</small>` : ''}
        </div>
        ${a.status === 'pending' ? `<div class="lacts">
          <button class="btn btn-quiet btn-sm a-no">Decline</button>
          <button class="btn btn-primary btn-sm a-yes">Accept &amp; unban</button>
        </div>` : ''}
      </div>`;
    }).join('') || '<div class="empty"><div class="ico"><i class="fa-solid fa-gavel"></i></div><h3>No appeals</h3><p>Appeals from banned accounts land here.</p></div>';

    $('appealRows').querySelectorAll('.lrow').forEach((row) => {
      const id = row.dataset.id;
      const resolve = async (accept, note) => {
        const { error } = await window.db.rpc('resolve_ban_appeal',
          { p_appeal_id: id, p_accept: accept, p_note: note });
        if (error) return UI.toast(error.message, true);
        UI.toast(accept ? 'Appeal accepted — account restored.' : 'Appeal declined.');
        // The ban state just changed underneath the cached user list.
        users = [];
        loadAppeals();
      };
      row.querySelector('.a-yes')?.addEventListener('click', () => resolve(true, null));
      row.querySelector('.a-no')?.addEventListener('click', () => resolve(false, prompt('Reason (optional)') || null));
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

  // The rpc raises plain-language exceptions; surface those as-is and only
  // fall back to the raw message for anything unexpected.
  function adminErr(error) {
    const m = error?.message || '';
    if (/schema cache|does not exist|PGRST205/i.test(m) || error?.code === 'PGRST202') {
      return 'Admin promotion isn\u2019t set up yet - run nexchat_patch7.sql.';
    }
    const known = ['not authorised', 'no such user', 'at least one admin', 'your own admin access'];
    const hit = known.find((k) => m.toLowerCase().includes(k));
    return hit ? m.replace(/^.*?:\s*/, '') : (m || 'Could not change admin access.');
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
          <button class="btn btn-quiet btn-sm u-admin">${u.is_platform_admin ? 'Remove admin' : 'Make admin'}</button>
          <button class="btn btn-quiet btn-sm u-ban" style="${u.is_banned ? '' : 'color:#FF8085;'}">${u.is_banned ? 'Unban' : 'Ban'}</button>
        </div>`}
      </div>`).join('') || '<div class="empty"><p>No one matches that.</p></div>';

    $('userRows').querySelectorAll('.u-admin').forEach((btn) => {
      btn.onclick = async () => {
        const uid = btn.closest('.lrow').dataset.u;
        const u = users.find((x) => x.id === uid);
        const promoting = !u.is_platform_admin;
        const okd = await UI.confirmDialog(
          promoting ? 'Make admin' : 'Remove admin',
          promoting
            ? `${u.username} will be able to ban accounts, review appeals and promote other admins.`
            : `${u.username} will lose access to the admin panel.`,
          !promoting, promoting ? 'Make admin' : 'Remove admin');
        if (!okd) return;
        btn.disabled = true;
        const { error } = await window.db.rpc('set_user_admin', { p_user_id: uid, p_admin: promoting });
        btn.disabled = false;
        if (error) return UI.toast(adminErr(error), true);
        u.is_platform_admin = promoting;
        UI.toast(promoting ? `${u.username} is now an admin.` : `${u.username} is no longer an admin.`);
        paintUsers();
      };
    });

    $('userRows').querySelectorAll('.u-ban').forEach((btn) => {
      btn.onclick = async () => {
        const uid = btn.closest('.lrow').dataset.u;
        const u = users.find((x) => x.id === uid);
        let reason = null;
        if (!u.is_banned) {
          if (!await UI.confirmDialog('Ban account', `${u.username} will be locked out of NexChat entirely.`, true, 'Ban account')) return;
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
    loadAppeals({ quiet: true });
  })();
})();
