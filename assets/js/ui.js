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
    // Wrap with a presence dot when asked and we know who this is.
    if (o.presence && profile?.id && window.Presence) {
      const inner = avatar(profile, size, { ...o, presence: false });
      return `<span class="av-slot">${inner}${window.Presence.dot(profile.id)}</span>`;
    }
    const name = profile?.display_name || profile?.username || '?';
    const bg = profile?.accent_color && !profile?.avatar_url ? `background:${profile.accent_color};` : '';
    const inner = profile?.avatar_url
      ? `<div class="av" style="width:${size}px;height:${size}px;"><img src="${esc(profile.avatar_url)}" alt=""></div>`
      : `<div class="av" style="width:${size}px;height:${size}px;font-size:${Math.round(size * 0.38)}px;${bg}">${initial(name)}</div>`;
    if (profile?.is_nitro && o.halo !== false) return `<span class="${haloClass(profile)}"${haloStyle(profile)}>${inner}</span>`;
    return inner;
  }

  /* ---- Nitro halo ----
     Three tiers, in order of precedence:
       1. custom CSS   - dev mode only, the ring is whatever the user writes
       2. a GIF/APNG   - banner_gif_url, spun as an image instead of a gradient
       3. the default  - the built-in conic-gradient sweep */
  const IMG_EXT = /\.(gif|apng|png|jpe?g|webp|avif)($|\?)/i;

  // Only same-scheme https images, and only ones that look like images.
  function haloImage(profile) {
    const raw = (profile?.banner_gif_url || '').trim();
    if (!raw) return null;
    let u;
    try { u = new URL(raw, location.href); } catch { return null; }
    if (!['https:', 'http:'].includes(u.protocol)) return null;
    if (!IMG_EXT.test(u.pathname)) return null;
    return u.href;
  }

  /* Custom halo CSS is a dev-mode toy, so it is still fenced in: declarations
     only (no selectors, no braces, no @rules) and no url()/expression payloads. */
  function haloCss(profile) {
    if (!profile?.theme?.dev_mode) return null;
    const raw = (profile.theme.halo_css || '').trim();
    if (!raw) return null;
    if (/[{}<>;]\s*@|[{}<>]/.test(raw)) return null;
    if (/url\s*\(|expression\s*\(|javascript:|behavior\s*:|@import/i.test(raw)) return null;
    if (raw.length > 400) return null;
    return raw;
  }

  /* Custom CSS has to reach the ring, which is a ::before pseudo-element and so
     cannot be styled inline. Each distinct snippet therefore becomes one rule in
     a shared stylesheet, keyed by a hash of its text so repeats are free. */
  const haloSheetKeys = new Set();
  let haloSheet = null;

  function haloKey(css) {
    let h = 0;
    for (let i = 0; i < css.length; i++) h = (Math.imul(31, h) + css.charCodeAt(i)) | 0;
    return 'av-halo-c' + (h >>> 0).toString(36);
  }

  function registerHaloCss(css) {
    const key = haloKey(css);
    if (haloSheetKeys.has(key) || typeof document === 'undefined') return key;
    // The profile editor re-registers on every keystroke, so the sheet is
    // recycled rather than allowed to grow without bound.
    if (haloSheet && haloSheetKeys.size >= 64) {
      haloSheet.textContent = '';
      haloSheetKeys.clear();
    }
    if (!haloSheet) {
      haloSheet = document.getElementById('nx-halo-styles') || document.createElement('style');
      haloSheet.id = 'nx-halo-styles';
      if (!haloSheet.parentNode) (document.head || document.documentElement).appendChild(haloSheet);
    }
    haloSheet.appendChild(document.createTextNode(`.${key}::before{${css};}`));
    haloSheetKeys.add(key);
    return key;
  }

  function haloClass(profile) {
    const custom = haloCss(profile);
    if (custom) return `av-halo av-halo-custom ${registerHaloCss(custom)}`;
    if (haloImage(profile)) return 'av-halo av-halo-img';
    return 'av-halo';
  }

  // The style text itself, for callers that set it via the DOM. Custom CSS lives
  // in the stylesheet instead, so only the image tier needs an inline value.
  function haloStyleText(profile) {
    if (haloCss(profile)) return '';
    const img = haloImage(profile);
    if (img) return `--halo-img:url('${img.replace(/['"\\]/g, '')}')`;
    return '';
  }

  // Returns a ready-to-interpolate style attribute, or '' when none is needed.
  function haloStyle(profile) {
    const text = haloStyleText(profile);
    return text ? ` style="${esc(text)}"` : '';
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
    // Stored images are shown as plain <img> throughout the app, so a TIFF is
    // normalised to PNG here rather than needing a decoder at every render site.
    if (window.Tiff?.isTiff(file.name)) {
      try { file = await window.Tiff.toPngFile(file); }
      catch { throw new Error('That TIFF could not be read. Try a PNG or JPEG.'); }
    }
    const ext = (file.name.split('.').pop() || 'bin').toLowerCase();
    const path = `${folder}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
    // Browsers leave file.type empty for .tiff and most font files, and Storage
    // then stores them as octet-stream, which breaks <img> and @font-face.
    const contentType = file.type || window.__nx_tp?.mimeOf?.(file.name) || 'application/octet-stream';
    const { error } = await window.db.storage.from(bucket).upload(path, file, { upsert: false, contentType });
    if (error) throw error;
    const { data } = window.db.storage.from(bucket).getPublicUrl(path);
    return data.publicUrl;
  }

  // `confirm` overrides the action button's label; without it a dangerous
  // action reads "Delete", which is wrong for anything that is not a deletion.
  function confirmDialog(title, body, danger, confirmText) {
    return new Promise((resolve) => {
      const ov = document.createElement('div');
      ov.className = 'overlay';
      ov.innerHTML = `
        <div class="modal" style="max-width:380px;">
          <div class="modal-head"><h3>${esc(title)}</h3></div>
          <div class="modal-body"><p style="font-size:13.5px;color:var(--txt-2);margin:0;">${esc(body)}</p></div>
          <div class="modal-foot">
            <button class="btn btn-quiet" data-no>Cancel</button>
            <button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-yes>${esc(confirmText || (danger ? 'Delete' : 'Confirm'))}</button>
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

  /* Dynamic-island style pill: slides down, sits for ~1.8s, slides away.
     Clicking it runs the supplied action. Stacks if several arrive at once. */
  function island(opts) {
    let host = document.getElementById('islandHost');
    if (!host) {
      host = document.createElement('div');
      host.id = 'islandHost';
      host.className = 'island-host';
      document.body.appendChild(host);
    }
    const el = document.createElement('div');
    el.className = 'island' + (opts.accent ? ' accent' : '');
    el.innerHTML = `
      <div class="isl-ico">${opts.avatar || `<i class="fa-solid ${opts.icon || 'fa-bell'}"></i>`}</div>
      <div class="isl-txt"><b>${esc(opts.title || '')}</b>${opts.body ? `<small>${esc(opts.body)}</small>` : ''}</div>
      ${opts.action ? '<i class="fa-solid fa-chevron-right isl-go"></i>' : ''}`;
    host.appendChild(el);

    requestAnimationFrame(() => el.classList.add('in'));
    let gone = false;
    const dismiss = () => {
      if (gone) return;
      gone = true;
      el.classList.remove('in');
      setTimeout(() => el.remove(), 260);
    };
    const timer = setTimeout(dismiss, opts.duration || 1800);

    if (opts.action) {
      el.style.cursor = 'pointer';
      el.onclick = () => { clearTimeout(timer); dismiss(); opts.action(); };
    }
    // Hovering holds it open so it can actually be clicked.
    el.onmouseenter = () => clearTimeout(timer);
    el.onmouseleave = () => setTimeout(dismiss, 700);
    return dismiss;
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
        <div class="upop-av ${p.is_nitro ? haloClass(p) : ''}"${p.is_nitro ? haloStyle(p) : ''}>${avatar(p, 68, { halo: false })}</div>
        <h3>${esc(name)}
          ${p.is_nitro ? '<span class="badge badge-nitro"><i class="fa-solid fa-bolt"></i> Nitro</span>' : ''}
          ${p.is_platform_admin ? '<span class="badge badge-admin">Admin</span>' : ''}</h3>
        <div class="handle">@${esc(p.username)}</div>
        <div class="presence-line" style="margin-top:6px;color:${window.Presence?.isOnline(p.id) ? 'var(--accent)' : 'var(--txt-3)'}">
          <span class="pdot ${window.Presence?.isOnline(p.id) ? 'on' : 'off'}" data-pd="${p.id}"></span>
          ${window.Presence?.isOnline(p.id) ? 'Online' : 'Offline'}
        </div>
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

  /* ---- server name appearance ----
     A server's theme can override the colour and typeface its name is shown
     in. Both fall back to the stylesheet defaults (white, display face) so an
     unset or partially set theme can never render the name invisible. */
  const NAME_FONTS = {
    display: { label: 'Display', stack: "'Bricolage Grotesque', sans-serif" },
    body: { label: 'Sans', stack: "'Instrument Sans', sans-serif" },
    mono: { label: 'Mono', stack: "'JetBrains Mono', monospace" },
    serif: { label: 'Serif', stack: "Georgia, 'Times New Roman', serif" },
    rounded: { label: 'Rounded', stack: "'Trebuchet MS', 'Segoe UI', sans-serif" },
  };

  function nameFontStack(key) {
    return NAME_FONTS[key]?.stack || NAME_FONTS.display.stack;
  }

  /* ---- custom fonts ----
     A theme may point at a Google Fonts URL or an uploaded font file instead
     of one of the built-in stacks. Both are loaded on demand and cached, so
     the same face is never requested twice on one page. */
  const loadedFonts = new Set();

  // Only ever inject stylesheet links we recognise as Google's font CDN.
  function googleFontHref(url) {
    let u;
    try { u = new URL(String(url).trim()); } catch { return null; }
    if (u.protocol !== 'https:') return null;
    if (!['fonts.googleapis.com', 'fonts.gstatic.com'].includes(u.hostname)) return null;
    return u.href;
  }

  // Pulls the family out of a Google Fonts URL: ...?family=Rubik+Glitch&...
  function googleFontFamily(url) {
    try {
      const fam = new URL(url).searchParams.get('family');
      if (!fam) return null;
      return fam.split(':')[0].replace(/\+/g, ' ').trim() || null;
    } catch { return null; }
  }

  function loadGoogleFont(url) {
    const href = googleFontHref(url);
    if (!href || loadedFonts.has(href)) return googleFontFamily(href || '');
    loadedFonts.add(href);
    const l = document.createElement('link');
    l.rel = 'stylesheet';
    l.href = href;
    l.crossOrigin = 'anonymous';
    document.head.appendChild(l);
    return googleFontFamily(href);
  }

  const FONT_FORMATS = { woff2: 'woff2', woff: 'woff', ttf: 'truetype', otf: 'opentype', ttc: 'collection' };

  // Registers an uploaded font file under a generated family name.
  function loadFontFile(url, family) {
    if (!url || loadedFonts.has(url)) return family;
    let u;
    try { u = new URL(url, location.href); } catch { return null; }
    if (!['https:', 'http:', 'blob:', 'data:'].includes(u.protocol)) return null;
    loadedFonts.add(url);
    const ext = (u.pathname.split('.').pop() || '').toLowerCase();
    const fmt = FONT_FORMATS[ext];
    const st = document.createElement('style');
    st.textContent = `@font-face{font-family:'${family}';src:url('${url}')${fmt ? ` format('${fmt}')` : ''};font-display:swap;}`;
    document.head.appendChild(st);
    return family;
  }

  // Stable per-URL family name, so a page showing several servers (the portal
  // grid) can register each uploaded face without them overwriting each other.
  function fontFamilyFor(url) {
    let h = 0;
    for (let i = 0; i < url.length; i++) h = ((h << 5) - h + url.charCodeAt(i)) | 0;
    return `NexFont${(h >>> 0).toString(36)}`;
  }

  /* Resolves whichever font source a theme specifies down to one CSS stack. */
  function resolveNameFont(theme) {
    const t = theme || {};
    if (t.name_font === 'google' && t.name_font_url) {
      const fam = loadGoogleFont(t.name_font_url);
      if (fam) return `'${fam}', ${NAME_FONTS.display.stack}`;
    }
    if (t.name_font === 'upload' && t.name_font_file) {
      const fam = loadFontFile(t.name_font_file, fontFamilyFor(t.name_font_file));
      if (fam) return `'${fam}', ${NAME_FONTS.display.stack}`;
    }
    return nameFontStack(t.name_font);
  }

  /* Defaults for the chat column's extra blur/dim, shared with the profile
     editor so the sliders and the renderer cannot drift apart. */
  const CHAT_BLUR_DEFAULT = 12;
  const CHAT_DIM_DEFAULT = 42;

  /* Applies a user's chosen wallpaper to whatever page is asking. The dashboard
     grid, the profile editor, DMs and server channels all read the same
     profiles.theme keys, so the wallpaper follows the user around the app
     instead of only dressing the portal. */
  function applyBackground(theme) {
    const t = theme || {};
    const root = document.documentElement.style;
    if (!t.dash_bg) {
      document.body.classList.remove('has-bg', 'bg-blur', 'chat-blur');
      document.querySelector('.dash-veil')?.remove();
      return;
    }
    document.body.classList.add('has-bg');
    root.setProperty('--dash-bg', t.dash_bg);
    root.setProperty('--dash-dim', (t.dash_dim ?? 0) / 100);
    root.setProperty('--dash-blur', (t.dash_blur ?? 0) + 'px');
    root.setProperty('--dash-bright', (t.dash_bright ?? 100) / 100);
    // Blur is only mounted when actually asked for, so a zero-blur wallpaper
    // costs nothing on the compositor.
    document.body.classList.toggle('bg-blur', (t.dash_blur ?? 0) > 0);
    // The chat column's own extra treatment, on top of whatever the wallpaper
    // already has. Defaults match the CSS fallbacks so a profile saved before
    // these keys existed looks exactly the same as it did.
    const cBlur = t.chat_blur ?? CHAT_BLUR_DEFAULT;
    root.setProperty('--chat-blur', cBlur + 'px');
    root.setProperty('--chat-dim', (t.chat_dim ?? CHAT_DIM_DEFAULT) / 100);
    document.body.classList.toggle('chat-blur', cBlur > 0);
    if (!document.querySelector('.dash-veil')) {
      const v = document.createElement('div');
      v.className = 'dash-veil';
      document.body.appendChild(v);
    }
  }

  function applyServerName(theme) {
    const root = document.documentElement.style;
    const col = theme?.name_color;
    root.setProperty('--srv-name-color', /^#[0-9a-fA-F]{6}$/.test(col || '') ? col : '#FFFFFF');
    root.setProperty('--srv-name-font', resolveNameFont(theme));
  }

  return { toast, esc, initial, avatar, requireSession, myProfile, upload, confirmDialog, timeLabel, userCard, roleIcon, island, applyServerName, applyBackground, nameFontStack, resolveNameFont, loadGoogleFont, loadFontFile, googleFontHref, googleFontFamily, haloClass, haloStyle, haloStyleText, haloImage, haloCss, NAME_FONTS, CHAT_BLUR_DEFAULT, CHAT_DIM_DEFAULT };
})();
