/* Shared UI helpers used by every page. */
window.UI = (function () {
  function toast(msg, isErr) {
    let el = document.getElementById('toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'toast';
      el.className = 'toast';
      document.body.appendChild(el);
    }
    el.textContent = msg;
    el.classList.toggle('err', !!isErr);
    el.classList.add('show');
    clearTimeout(el._t);
    el._t = setTimeout(() => el.classList.remove('show'), 3400);
  }

  function esc(s) {
    return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function initial(name) { return (name || '?').trim().charAt(0).toUpperCase(); }

  // Renders an avatar, wrapping it in the animated halo for Nitro members.
  function avatar(profile, size, opts) {
    const o = opts || {};
    const name = profile?.display_name || profile?.username || '?';
    const bg = profile?.accent_color && !profile?.avatar_url ? `background:${profile.accent_color};` : '';
    const inner = profile?.avatar_url
      ? `<div class="av" style="width:${size}px;height:${size}px;"><img src="${esc(profile.avatar_url)}" alt=""></div>`
      : `<div class="av" style="width:${size}px;height:${size}px;font-size:${Math.round(size * 0.38)}px;${bg}">${initial(name)}</div>`;
    if (profile?.is_nitro && o.halo !== false) return `<span class="av-halo">${inner}</span>`;
    return inner;
  }

  async function requireSession(redirect) {
    const { data } = await window.db.auth.getSession();
    if (!data.session) { window.location.href = redirect || 'index.html'; return null; }
    return data.session;
  }

  async function myProfile(userId) {
    const { data } = await window.db.from('profiles').select('*').eq('id', userId).single();
    return data;
  }

  // Uploads to a Supabase Storage bucket and returns the public URL.
  // Profile buckets are RLS-scoped to a folder named after the user's id.
  async function upload(bucket, file, folder) {
    const ext = (file.name.split('.').pop() || 'bin').toLowerCase();
    const path = `${folder}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
    const { error } = await window.db.storage.from(bucket).upload(path, file, { upsert: false });
    if (error) throw error;
    const { data } = window.db.storage.from(bucket).getPublicUrl(path);
    return data.publicUrl;
  }

  function confirmDialog(title, body, danger) {
    return new Promise((resolve) => {
      const ov = document.createElement('div');
      ov.className = 'overlay';
      ov.innerHTML = `
        <div class="modal" style="max-width:380px;">
          <div class="modal-head"><h3>${esc(title)}</h3></div>
          <div class="modal-body"><p style="font-size:13.5px;color:var(--txt-2);margin:0;">${esc(body)}</p></div>
          <div class="modal-foot">
            <button class="btn btn-quiet" data-no>Cancel</button>
            <button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-yes>${danger ? 'Delete' : 'Confirm'}</button>
          </div>
        </div>`;
      document.body.appendChild(ov);
      const done = (v) => { ov.remove(); resolve(v); };
      ov.querySelector('[data-no]').onclick = () => done(false);
      ov.querySelector('[data-yes]').onclick = () => done(true);
      ov.onclick = (e) => { if (e.target === ov) done(false); };
    });
  }

  function timeLabel(iso) {
    const d = new Date(iso), now = new Date();
    const t = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    const yest = new Date(now); yest.setDate(now.getDate() - 1);
    if (d.toDateString() === now.toDateString()) return `Today at ${t}`;
    if (d.toDateString() === yest.toDateString()) return `Yesterday at ${t}`;
    return `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} at ${t}`;
  }

  /* Clickable user card: bio, badges, roles, and quick actions. */
  async function userCard(userId, opts = {}) {
    const { data: p } = await window.db.from('profiles').select('*').eq('id', userId).single();
    if (!p) return toast('Could not load that profile.', true);

    const { data: sess } = await window.db.auth.getSession();
    const meId = sess?.session?.user?.id;
    const isMe = meId === userId;

    let roles = [];
    if (opts.serverId) {
      const { data: mr } = await window.db.from('member_roles')
        .select('role_id, roles(name,color,icon_url)').eq('server_id', opts.serverId).eq('user_id', userId);
      roles = (mr || []).map((r) => r.roles).filter(Boolean);
    }

    let rel = null;
    if (!isMe) {
      const { data: f } = await window.db.from('friendships')
        .select('*').or(`and(user_id.eq.${meId},friend_id.eq.${userId}),and(user_id.eq.${userId},friend_id.eq.${meId})`);
      const mine = (f || []).find((x) => x.user_id === meId);
      const theirs = (f || []).find((x) => x.friend_id === meId);
      if (mine?.status === 'accepted' || theirs?.status === 'accepted') rel = 'friends';
      else if (mine?.status === 'pending') rel = 'sent';
      else if (theirs?.status === 'pending') rel = 'incoming';
    }

    const name = p.display_name || p.username;
    const accent = p.accent_color || '#2FBF87';
    const banner = p.banner_url ? `url('${esc(p.banner_url)}') center/cover`
                                : `linear-gradient(120deg, ${accent}, ${accent}22)`;

    const roleChips = roles.length ? `
      <div class="sect"><h5>Roles</h5><div class="roles">${roles.map((r) => `
        <span class="chip">${roleIcon(r)}<span class="dot" style="background:${esc(r.color || '#99AAB5')}"></span>${esc(r.name)}</span>`).join('')}
      </div></div>` : '';

    let actions = '';
    if (!isMe) {
      const friendBtn = rel === 'friends'
        ? '<button class="btn btn-ghost" data-unfriend>Remove friend</button>'
        : rel === 'sent' ? '<button class="btn btn-ghost" disabled>Request sent</button>'
        : rel === 'incoming' ? '<button class="btn btn-primary" data-accept>Accept request</button>'
        : '<button class="btn btn-ghost" data-add>Add friend</button>';
      actions = `<div class="upop-acts"><button class="btn btn-primary" data-dm><i class="fa-solid fa-paper-plane"></i> Message</button>${friendBtn}</div>`;
    } else {
      actions = '<div class="upop-acts"><a class="btn btn-ghost" href="profile.html">Edit profile</a></div>';
    }

    const ov = document.createElement('div');
    ov.className = 'overlay';
    ov.innerHTML = `<div class="upop">
      <div class="upop-banner" style="background:${banner}"></div>
      <div class="upop-body">
        <div class="upop-av ${p.is_nitro ? 'av-halo' : ''}">${avatar(p, 68, { halo: false })}</div>
        <h3>${esc(name)}
          ${p.is_nitro ? '<span class="badge badge-nitro"><i class="fa-solid fa-bolt"></i> Nitro</span>' : ''}
          ${p.is_platform_admin ? '<span class="badge badge-admin">Admin</span>' : ''}</h3>
        <div class="handle">@${esc(p.username)}</div>
        ${p.custom_status ? `<div class="sect"><h5>Status</h5><p>${esc(p.custom_status)}</p></div>` : ''}
        <div class="sect"><h5>About me</h5><p>${p.bio ? esc(p.bio) : '<span style="color:var(--txt-3)">Nothing here yet.</span>'}</p></div>
        ${roleChips}
        <div class="sect"><h5>Member since</h5><p>${new Date(p.created_at).toLocaleDateString([], { month: 'long', day: 'numeric', year: 'numeric' })}</p></div>
        ${actions}
      </div>
    </div>`;
    document.body.appendChild(ov);
    const close = () => ov.remove();
    ov.onclick = (e) => { if (e.target === ov) close(); };

    ov.querySelector('[data-dm]')?.addEventListener('click', async () => {
      const { data, error } = await window.db.rpc('open_dm', { p_other: userId });
      if (error) return toast(error.message, true);
      window.location.href = `dms.html?c=${data}`;
    });
    ov.querySelector('[data-add]')?.addEventListener('click', async (e) => {
      e.currentTarget.disabled = true;
      const { error } = await window.db.rpc('send_friend_request', { p_username: p.username });
      toast(error ? error.message : 'Friend request sent.', !!error);
      close();
    });
    ov.querySelector('[data-accept]')?.addEventListener('click', async () => {
      const { error } = await window.db.rpc('accept_friend_request', { p_from: userId });
      toast(error ? error.message : `You and ${name} are now friends.`, !!error);
      close();
    });
    ov.querySelector('[data-unfriend]')?.addEventListener('click', async () => {
      const { error } = await window.db.rpc('remove_friend', { p_other: userId });
      toast(error ? error.message : 'Friend removed.', !!error);
      close();
    });
  }

  /* Role icons accept an uploaded image (png/svg/ico/gif) or a plain emoji. */
  function roleIcon(role) {
    if (!role?.icon_url) return '';
    const v = role.icon_url.trim();
    if (/^https?:\/\//i.test(v) || v.startsWith('data:')) return `<img class="role-ico" src="${esc(v)}" alt="">`;
    return `<span class="role-emoji">${esc(v)}</span>`;
  }

  return { toast, esc, initial, avatar, requireSession, myProfile, upload, confirmDialog, timeLabel, userCard, roleIcon };
})();
