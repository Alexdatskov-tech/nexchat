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

  return { toast, esc, initial, avatar, requireSession, myProfile, upload, confirmDialog, timeLabel };
})();
