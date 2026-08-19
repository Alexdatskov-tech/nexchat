(function () {
  const $ = (id) => document.getElementById(id);
  let me = null, srv = null, sid = null, isOwner = false;
  let icoFile = null, banFile = null;

  const PRESETS = ['#2FBF87', '#3B9EF5', '#8B7CF6', '#E8659A', '#E8B04B', '#E5484D', '#5AC8D8', '#94A3B8'];
  const PERMS = [
    ['VIEW_CHANNEL', 1, 'View channels'], ['SEND_MESSAGES', 2, 'Send messages'],
    ['MANAGE_MESSAGES', 4, 'Manage messages'], ['MANAGE_CHANNELS', 8, 'Manage channels'],
    ['MANAGE_ROLES', 16, 'Manage roles'], ['KICK_MEMBERS', 32, 'Kick members'],
    ['BAN_MEMBERS', 64, 'Ban members'], ['MANAGE_SERVER', 128, 'Manage server'],
    ['CREATE_INVITE', 256, 'Create invites'], ['CONNECT_VOICE', 512, 'Connect to voice'],
    ['SPEAK', 1024, 'Speak'], ['VIDEO', 2048, 'Video'],
    ['MUTE_MEMBERS', 4096, 'Mute members'], ['DEAFEN_MEMBERS', 8192, 'Deafen members'],
    ['MANAGE_NICKNAMES', 16384, 'Manage nicknames'], ['MANAGE_EMOJIS', 32768, 'Manage emoji'],
    ['ADMINISTRATOR', 65536, 'Administrator'],
  ];

  const NO_SAVE = ['channels', 'roles', 'members', 'invites', 'bans', 'danger'];
  document.querySelectorAll('.set-nav button[data-tab]').forEach((b) => {
    b.onclick = () => {
      document.querySelectorAll('.set-nav button[data-tab]').forEach((x) => x.classList.remove('on'));
      b.classList.add('on');
      const t = b.dataset.tab;
      document.querySelectorAll('[data-pane]').forEach((p) => p.classList.toggle('hidden', p.dataset.pane !== t));
      $('saveBar').classList.toggle('hidden', NO_SAVE.includes(t));
      ({ channels: loadChannels, roles: loadRoles, members: loadMembers, invites: loadInvites, bans: loadBans }[t] || (() => {}))();
      window.scrollTo(0, 0);
    };
  });

  /* ---- accent ---- */
  function setAccent(hex) {
    $('sAccent').value = hex;
    $('sAccentHex').value = hex.toUpperCase();
    document.documentElement.style.setProperty('--accent', hex);
    document.querySelectorAll('#sSwatches .swatch').forEach((s) => s.classList.toggle('on', s.dataset.c.toLowerCase() === hex.toLowerCase()));
  }
  $('sSwatches').innerHTML = PRESETS.map((c) => `<div class="swatch" data-c="${c}" style="background:${c}"></div>`).join('');
  document.querySelectorAll('#sSwatches .swatch').forEach((s) => { s.onclick = () => setAccent(s.dataset.c); });
  $('sAccent').oninput = (e) => setAccent(e.target.value);
  $('sAccentHex').oninput = (e) => { if (/^#[0-9a-fA-F]{6}$/.test(e.target.value.trim())) setAccent(e.target.value.trim()); };
  $('sAccentReset').onclick = () => setAccent('#2FBF87');

  /* ---- uploads ---- */
  function wireUp(inp, prev, cb, maxMb) {
    $(inp).onchange = (e) => {
      const f = e.target.files[0]; if (!f) return;
      if (f.size > maxMb * 1024 * 1024) { UI.toast(`Over ${maxMb} MB.`, true); e.target.value = ''; return; }
      const r = new FileReader();
      r.onload = (ev) => { $(prev).innerHTML = `<img src="${ev.target.result}">`; cb(f); };
      r.readAsDataURL(f);
    };
  }
  wireUp('sIcon', 'icoPrev', (f) => (icoFile = f), 2);
  wireUp('sBanner', 'banPrev', (f) => (banFile = f), 4);

  /* ---- save overview/appearance ---- */
  $('btnSave').onclick = async () => {
    const b = $('btnSave'); b.disabled = true; b.textContent = 'Saving…';
    try {
      const patch = {
        name: $('sName').value.trim(),
        description: $('sDesc').value.trim() || null,
        theme: { ...(srv.theme || {}), accent: $('sAccent').value },
      };
      if (patch.name.length < 2) throw new Error('The server needs a name of at least 2 characters.');
      if (icoFile) patch.icon_url = await UI.upload('server-icons', icoFile, sid);
      if (banFile) patch.banner_url = await UI.upload('server-banners', banFile, sid);

      const { error } = await window.db.from('servers').update(patch).eq('id', sid);
      if (error) throw error;
      Object.assign(srv, patch);
      icoFile = banFile = null;
      UI.toast('Server updated.');
    } catch (err) { UI.toast(err.message || 'Could not save.', true); }
    finally { b.disabled = false; b.textContent = 'Save changes'; }
  };
  $('btnReset').onclick = () => hydrate();

  /* ---- channels ---- */
  async function loadChannels() {
    const { data } = await window.db.from('channels').select('*').eq('server_id', sid).order('position');
    const cats = (data || []).filter((c) => c.type === 'category');
    const ico = (t) => t === 'voice' ? 'fa-volume-high' : t === 'category' ? 'fa-folder' : t === 'announcement' ? 'fa-bullhorn' : 'fa-hashtag';
    $('chanRows').innerHTML = (data || []).map((c) => `
      <div class="lrow" data-id="${c.id}">
        <i class="fa-solid ${ico(c.type)}" style="width:20px;text-align:center;color:var(--txt-3);"></i>
        <div class="lmain"><b>${UI.esc(c.name)}</b><small>${c.type}${c.topic ? ' · ' + UI.esc(c.topic) : ''}</small></div>
        <div class="lacts">
          <button class="btn btn-quiet btn-sm ed">Edit</button>
          <button class="btn btn-quiet btn-sm rm" style="color:#FF8085;"><i class="fa-solid fa-trash-can"></i></button>
        </div>
      </div>`).join('') || '<div class="empty"><p>No channels yet.</p></div>';

    $('chanRows').querySelectorAll('.lrow').forEach((r) => {
      const c = data.find((x) => x.id === r.dataset.id);
      r.querySelector('.ed').onclick = async () => {
        const name = prompt('Channel name', c.name);
        if (name === null) return;
        const patch = { name: name.trim() };
        if (c.type !== 'category') {
          const topic = prompt('Channel topic (blank for none)', c.topic || '');
          if (topic !== null) patch.topic = topic.trim() || null;
        }
        const { error } = await window.db.from('channels').update(patch).eq('id', c.id);
        if (error) return UI.toast(error.message, true);
        UI.toast('Channel updated.'); loadChannels();
      };
      r.querySelector('.rm').onclick = async () => {
        if (!await UI.confirmDialog(`Delete ${c.name}`, 'Every message in it goes too.', true)) return;
        const { error } = await window.db.from('channels').delete().eq('id', c.id);
        if (error) return UI.toast(error.message, true);
        UI.toast('Channel deleted.'); loadChannels();
      };
    });
  }
  $('addCat').onclick = async () => {
    const name = prompt('Category name');
    if (!name?.trim()) return;
    const { error } = await window.db.from('channels')
      .insert({ server_id: sid, name: name.trim(), type: 'category', position: 99 });
    if (error) return UI.toast(error.message, true);
    loadChannels();
  };

  /* ---- roles ---- */
  async function loadRoles() {
    const { data } = await window.db.from('roles').select('*').eq('server_id', sid).order('position', { ascending: false });
    $('roleRows').innerHTML = (data || []).map((r) => `
      <div class="set-block" data-role="${r.id}">
        <div style="display:flex;align-items:center;gap:11px;margin-bottom:14px;flex-wrap:wrap;">
          <span class="chip">${UI.roleIcon(r)}<span class="dot" style="background:${UI.esc(r.color || '#99AAB5')}"></span>${UI.esc(r.name)}</span>
          ${r.is_default ? '<span class="badge badge-owner">Everyone</span>' : ''}
          <div style="margin-left:auto;display:flex;gap:6px;flex-wrap:wrap;">
            <button class="btn btn-quiet btn-sm r-icon" title="Set an image or emoji"><i class="fa-regular fa-image"></i> Icon</button>
            <button class="btn btn-quiet btn-sm r-ed">Rename</button>
            <button class="btn btn-quiet btn-sm r-reset" title="Restore the default permission set">Reset</button>
            ${r.is_default ? '' : '<button class="btn btn-quiet btn-sm r-rm" style="color:#FF8085;">Delete</button>'}
            <button class="btn btn-primary btn-sm r-save">Save</button>
          </div>
        </div>
        <div class="perm-grid">
          ${PERMS.map(([k, bit, label]) => `
            <label class="perm"><input type="checkbox" data-bit="${bit}" ${(BigInt(r.permissions) & BigInt(bit)) ? 'checked' : ''}>${label}</label>`).join('')}
        </div>
      </div>`).join('') || '<div class="empty"><p>No roles yet.</p></div>';

    $('roleRows').querySelectorAll('[data-role]').forEach((box) => {
      const r = data.find((x) => x.id === box.dataset.role);
      box.querySelector('.r-save').onclick = async () => {
        let bits = 0n;
        box.querySelectorAll('input[data-bit]').forEach((c) => { if (c.checked) bits |= BigInt(c.dataset.bit); });
        const { error } = await window.db.from('roles').update({ permissions: Number(bits) }).eq('id', r.id);
        UI.toast(error ? error.message : `${r.name} permissions saved.`, !!error);
      };
      box.querySelector('.r-ed').onclick = async () => {
        const name = prompt('Role name', r.name); if (name === null) return;
        const color = prompt('Role colour (hex)', r.color || '#99AAB5'); if (color === null) return;
        const { error } = await window.db.from('roles').update({ name: name.trim(), color: color.trim() }).eq('id', r.id);
        if (error) return UI.toast(error.message, true);
        loadRoles();
      };
      // Default permission set: view, send, invite, connect, speak.
      const DEFAULT_PERMS = 1 + 2 + 256 + 512 + 1024;
      box.querySelector('.r-reset').onclick = async () => {
        const label = r.is_default ? '@everyone' : r.name;
        if (!await UI.confirmDialog(`Reset ${label}`,
              'Permissions go back to the defaults: view channels, send messages, create invites, connect and speak.')) return;
        const { error } = await window.db.from('roles').update({ permissions: DEFAULT_PERMS }).eq('id', r.id);
        if (error) return UI.toast(error.message, true);
        UI.toast(`${label} reset to defaults.`);
        loadRoles();
      };

      box.querySelector('.r-icon').onclick = () => roleIconModal(r);

      box.querySelector('.r-rm')?.addEventListener('click', async () => {
        if (!await UI.confirmDialog(`Delete ${r.name}`, 'Members lose this role and its permissions.', true)) return;
        const { error } = await window.db.from('roles').delete().eq('id', r.id);
        if (error) return UI.toast(error.message, true);
        loadRoles();
      });
    });
  }
  $('addRole').onclick = async () => {
    const name = prompt('Role name'); if (!name?.trim()) return;
    const { error } = await window.db.from('roles')
      .insert({ server_id: sid, name: name.trim(), color: '#99AAB5', permissions: 1 + 2 + 256 + 512 + 1024, position: 1 });
    if (error) return UI.toast(error.message, true);
    loadRoles();
  };

  /* Role icons: an uploaded image (png, svg, ico, gif, webp) or a plain emoji. */
  function roleIconModal(r) {
    const ov = document.createElement('div');
    ov.className = 'overlay';
    ov.innerHTML = `<div class="modal" style="max-width:400px;">
      <div class="modal-head"><h3>Role icon</h3><button class="x-btn" data-c><i class="fa-solid fa-xmark"></i></button></div>
      <div class="modal-body">
        <div class="upload-row">
          <div class="upload-prev" id="riPrev">${r.icon_url ? UI.roleIcon({ icon_url: r.icon_url }).replace('role-ico', 'role-ico" style="width:34px;height:34px') : '<i class="fa-regular fa-image"></i>'}</div>
          <div class="field" style="flex:1;">
            <label>Upload an image</label>
            <input type="file" id="riFile" accept=".png,.svg,.ico,.gif,.webp,.jpg,.jpeg,image/*" />
            <span class="hint">PNG, SVG, ICO, GIF or WebP. Under 1 MB.</span>
          </div>
        </div>
        <div class="field">
          <label for="riEmoji">…or use an emoji</label>
          <input id="riEmoji" class="input" maxlength="8" placeholder="🛡️" value="${r.icon_url && !/^https?:|^data:/.test(r.icon_url) ? UI.esc(r.icon_url) : ''}" />
        </div>
        <p class="err" id="riErr"></p>
      </div>
      <div class="modal-foot">
        <button class="btn btn-quiet" id="riClear">Remove icon</button>
        <button class="btn btn-primary" id="riSave">Save icon</button>
      </div>
    </div>`;
    document.body.appendChild(ov);
    const close = () => ov.remove();
    ov.querySelector('[data-c]').onclick = close;
    ov.onclick = (e) => { if (e.target === ov) close(); };

    let file = null;
    ov.querySelector('#riFile').onchange = (e) => {
      const f = e.target.files[0]; if (!f) return;
      if (f.size > 1024 * 1024) { ov.querySelector('#riErr').textContent = 'That image is over 1 MB.'; return; }
      file = f;
      const rd = new FileReader();
      rd.onload = (ev) => { ov.querySelector('#riPrev').innerHTML = `<img src="${ev.target.result}" style="width:34px;height:34px;object-fit:contain">`; };
      rd.readAsDataURL(f);
    };

    ov.querySelector('#riClear').onclick = async () => {
      const { error } = await window.db.from('roles').update({ icon_url: null }).eq('id', r.id);
      UI.toast(error ? error.message : 'Icon removed.', !!error);
      close(); loadRoles();
    };

    ov.querySelector('#riSave').onclick = async () => {
      const btn = ov.querySelector('#riSave');
      btn.disabled = true; btn.textContent = 'Saving…';
      try {
        let icon = ov.querySelector('#riEmoji').value.trim() || null;
        if (file) {
          const key = `nexchat/roles/${sid}/${Date.now()}-${file.name.replace(/[^\w.\-]/g, '_')}`;
          icon = (await window.__nx_tp.put(key, file)).url;
        }
        const { error } = await window.db.from('roles').update({ icon_url: icon }).eq('id', r.id);
        if (error) throw error;
        UI.toast('Role icon saved.');
        close(); loadRoles();
      } catch (err) {
        ov.querySelector('#riErr').textContent = err.message || 'Could not save that icon.';
        btn.disabled = false; btn.textContent = 'Save icon';
      }
    };
  }

  /* ---- members ---- */
  let memCache = [], roleCache = [];
  async function loadMembers() {
    const [{ data: mem }, { data: roles }] = await Promise.all([
      window.db.from('server_members').select('*, profiles(id,username,display_name,avatar_url,accent_color,is_nitro)').eq('server_id', sid),
      window.db.from('roles').select('*').eq('server_id', sid),
    ]);
    const { data: mr } = await window.db.from('member_roles').select('*').eq('server_id', sid);
    memCache = mem || []; roleCache = roles || [];
    paintMembers(mr || []);
  }
  function paintMembers(memberRoles) {
    const q = $('memSearch').value.trim().toLowerCase();
    const rows = memCache.filter((m) => {
      const p = m.profiles || {};
      return !q || (p.username || '').toLowerCase().includes(q) || (p.display_name || '').toLowerCase().includes(q);
    });
    $('memRows').innerHTML = rows.map((m) => {
      const p = m.profiles || { username: 'unknown' };
      const owner = m.user_id === srv.owner_id;
      const mine = m.user_id === me.id;
      const theirs = memberRoles.filter((x) => x.user_id === m.user_id)
        .map((x) => roleCache.find((r) => r.id === x.role_id)).filter(Boolean);
      return `<div class="lrow" data-u="${m.user_id}">
        ${UI.avatar(p, 32, { presence: true })}
        <div class="lmain">
          <b>${UI.esc(p.display_name || p.username)} ${owner ? '<span class="badge badge-owner">Owner</span>' : ''}</b>
          <small>@${UI.esc(p.username)}</small>
          ${theirs.length ? `<div style="display:flex;gap:4px;flex-wrap:wrap;margin-top:4px;">${theirs.map((r) => `<span class="chip">${UI.roleIcon(r)}<span class="dot" style="background:${UI.esc(r.color)}"></span>${UI.esc(r.name)}</span>`).join('')}</div>` : ''}
        </div>
        <div class="lacts">
          <button class="btn btn-quiet btn-sm m-role">Roles</button>
          ${owner || mine ? '' : `
            <button class="btn btn-quiet btn-sm m-kick">Kick</button>
            <button class="btn btn-quiet btn-sm m-ban" style="color:#FF8085;">Ban</button>`}
        </div>
      </div>`;
    }).join('') || '<div class="empty"><p>Nobody matches that.</p></div>';

    $('memRows').querySelectorAll('.lrow').forEach((row) => {
      const uid = row.dataset.u;
      row.querySelector('.m-kick')?.addEventListener('click', async () => {
        if (!await UI.confirmDialog('Kick member', 'They can rejoin with a new invite.', true)) return;
        const { error } = await window.db.rpc('kick_member', { p_server_id: sid, p_user_id: uid });
        UI.toast(error ? error.message : 'Member kicked.', !!error); loadMembers();
      });
      row.querySelector('.m-ban')?.addEventListener('click', async () => {
        if (!await UI.confirmDialog('Ban member', 'They won\u2019t be able to rejoin.', true)) return;
        const { error } = await window.db.rpc('ban_member', { p_server_id: sid, p_user_id: uid, p_reason: null });
        UI.toast(error ? error.message : 'Member banned.', !!error); loadMembers();
      });
      row.querySelector('.m-role').onclick = () => roleModal(uid, memberRoles);
      row.querySelector('.av, .av-halo')?.addEventListener('click', () => UI.userCard(uid, { serverId: sid }));
    });
  }
  $('memSearch').oninput = () => loadMembers();

  function roleModal(uid, memberRoles) {
    const owned = new Set(memberRoles.filter((x) => x.user_id === uid).map((x) => x.role_id));
    const ov = document.createElement('div');
    ov.className = 'overlay';
    ov.innerHTML = `<div class="modal" style="max-width:380px;">
      <div class="modal-head"><h3>Assign roles</h3><button class="x-btn" data-c><i class="fa-solid fa-xmark"></i></button></div>
      <div class="modal-body">${roleCache.filter((r) => !r.is_default).map((r) => `
        <label class="perm"><input type="checkbox" data-r="${r.id}" ${owned.has(r.id) ? 'checked' : ''}>
        <span class="chip">${UI.roleIcon(r)}<span class="dot" style="background:${UI.esc(r.color)}"></span>${UI.esc(r.name)}</span></label>`).join('')
        || '<p style="font-size:13px;color:var(--txt-3);margin:0;">Create a role first.</p>'}</div>
      <div class="modal-foot"><button class="btn btn-quiet" data-c>Cancel</button><button class="btn btn-primary" data-ok>Apply</button></div>
    </div>`;
    document.body.appendChild(ov);
    ov.querySelectorAll('[data-c]').forEach((b) => (b.onclick = () => ov.remove()));
    ov.onclick = (e) => { if (e.target === ov) ov.remove(); };
    ov.querySelector('[data-ok]').onclick = async () => {
      const want = new Set([...ov.querySelectorAll('input[data-r]:checked')].map((c) => c.dataset.r));
      const add = [...want].filter((r) => !owned.has(r));
      const rem = [...owned].filter((r) => !want.has(r));
      if (add.length) await window.db.from('member_roles').insert(add.map((role_id) => ({ server_id: sid, user_id: uid, role_id })));
      for (const role_id of rem) await window.db.from('member_roles').delete().eq('server_id', sid).eq('user_id', uid).eq('role_id', role_id);
      ov.remove(); UI.toast('Roles updated.'); loadMembers();
    };
  }

  /* ---- invites ---- */
  async function loadInvites() {
    const { data } = await window.db.from('invites').select('*').eq('server_id', sid).order('created_at', { ascending: false });
    $('invRows').innerHTML = (data || []).map((i) => {
      const dead = i.expires_at && new Date(i.expires_at) < new Date();
      return `<div class="lrow" data-id="${i.id}">
        <div class="lmain">
          <b class="mono">${UI.esc(i.code)}</b>
          <small>${i.uses} use${i.uses === 1 ? '' : 's'}${i.max_uses ? ` / ${i.max_uses}` : ''} · ${dead ? 'Expired' : i.expires_at ? 'Expires ' + new Date(i.expires_at).toLocaleString() : 'Never expires'}</small>
        </div>
        <div class="lacts">
          <button class="btn btn-quiet btn-sm i-cp"><i class="fa-regular fa-copy"></i></button>
          <button class="btn btn-quiet btn-sm i-rm" style="color:#FF8085;"><i class="fa-solid fa-trash-can"></i></button>
        </div>
      </div>`;
    }).join('') || '<div class="empty"><p>No invites yet. Create one from the server menu.</p></div>';

    $('invRows').querySelectorAll('.lrow').forEach((r) => {
      const inv = data.find((x) => x.id === r.dataset.id);
      r.querySelector('.i-cp').onclick = () => {
        navigator.clipboard.writeText(`${location.origin}${location.pathname.replace(/server-settings\.html$/, 'portal.html')}?invite=${inv.code}`);
        UI.toast('Invite link copied.');
      };
      r.querySelector('.i-rm').onclick = async () => {
        const { error } = await window.db.from('invites').delete().eq('id', inv.id);
        UI.toast(error ? error.message : 'Invite revoked.', !!error); loadInvites();
      };
    });
  }

  /* ---- bans ---- */
  async function loadBans() {
    const { data } = await window.db.from('server_bans')
      .select('*, profiles!user_id(username,display_name,avatar_url,accent_color)').eq('server_id', sid);
    $('banRows').innerHTML = (data || []).map((b) => {
      const p = b.profiles || { username: 'unknown' };
      return `<div class="lrow" data-u="${b.user_id}">
        ${UI.avatar(p, 32, { presence: true })}
        <div class="lmain"><b>${UI.esc(p.display_name || p.username)}</b><small>${UI.esc(b.reason || 'No reason given')}</small></div>
        <div class="lacts"><button class="btn btn-quiet btn-sm b-un">Unban</button></div>
      </div>`;
    }).join('') || '<div class="empty"><p>Nobody is banned.</p></div>';

    $('banRows').querySelectorAll('.b-un').forEach((btn) => {
      btn.onclick = async () => {
        const uid = btn.closest('.lrow').dataset.u;
        const { error } = await window.db.from('server_bans').delete().eq('server_id', sid).eq('user_id', uid);
        UI.toast(error ? error.message : 'Ban lifted.', !!error); loadBans();
      };
    });
  }

  /* ---- danger ---- */
  $('btnDelete').onclick = async () => {
    if (!isOwner) return UI.toast('Only the owner can delete this server.', true);
    if (!await UI.confirmDialog('Delete server', `"${srv.name}" and everything in it will be gone permanently.`, true)) return;
    const { error } = await window.db.from('servers').delete().eq('id', sid);
    if (error) return UI.toast(error.message, true);
    window.location.href = 'portal.html';
  };

  function hydrate() {
    $('sName').value = srv.name || '';
    $('sDesc').value = srv.description || '';
    $('icoPrev').innerHTML = srv.icon_url ? `<img src="${UI.esc(srv.icon_url)}">` : '<i class="fa-regular fa-image"></i>';
    if (srv.banner_url) {
      $('banPrev').innerHTML = `<img src="${UI.esc(srv.banner_url)}">`;
      $('banPrev').style.background = '';
    } else {
      $('banPrev').innerHTML = '<span style="font-size:9.5px;color:#5A5E68;font-weight:600;">Default</span>';
      $('banPrev').style.background = 'linear-gradient(135deg,#F2F3F6 0%,#D5D8DF 48%,#BFC3CC 100%)';
    }
    setAccent(srv.theme?.accent || '#2FBF87');
    icoFile = banFile = null;
    $('sIcon').value = ''; $('sBanner').value = '';
  }

  (async () => {
    const s = await UI.requireSession(); if (!s) return;
    me = await UI.myProfile(s.user.id);
    sid = new URLSearchParams(location.search).get('id');
    if (!sid) return (window.location.href = 'portal.html');
    $('backLink').href = `server.html?id=${sid}`;

    const { data, error } = await window.db.from('servers').select('*').eq('id', sid).single();
    if (error || !data) { UI.toast('Server not found.', true); return; }
    srv = data;
    window.Notify?.start(me);
    window.Presence?.start(me);
    window.Presence?.onChange(() => window.Presence.refreshDots());
    isOwner = srv.owner_id === me.id;
    $('navTitle').textContent = srv.name;
    document.title = `${srv.name} — Settings`;
    hydrate();
  })();
})();
