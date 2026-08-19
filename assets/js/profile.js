(function () {
  const $ = (id) => document.getElementById(id);
  let me = null, avatarFile = null, bannerFile = null;
  let clearAvatar = false, clearBanner = false;

  const PRESETS = ['#2FBF87', '#3B9EF5', '#8B7CF6', '#E8659A', '#E8B04B', '#E5484D', '#5AC8D8', '#94A3B8'];
  const BG_PRESETS = [
    { n: 'None',    v: '' },
    { n: 'Aurora',  v: 'linear-gradient(135deg,#0B3B2E,#0C2436 55%,#211B3D)' },
    { n: 'Ember',   v: 'linear-gradient(135deg,#3A1D14,#2A1520 60%,#161018)' },
    { n: 'Deep',    v: 'linear-gradient(135deg,#0A1A2F,#0B1220 60%,#0A0A12)' },
    { n: 'Moss',    v: 'linear-gradient(135deg,#16281B,#101E23 60%,#0D1014)' },
    { n: 'Dusk',    v: 'radial-gradient(120% 100% at 20% 0%,#2B2246,#141222 55%,#0B0A11)' },
  ];
  let bgVal = '', bgDim = 0, bgBlur = 0, bgBright = 100, wpFile = null, devMode = false, manualStun = [];

  function applyBg() {
    if (!bgVal) { document.body.classList.remove('has-bg'); return; }
    document.body.classList.add('has-bg');
    document.documentElement.style.setProperty('--dash-bg', bgVal);
    document.documentElement.style.setProperty('--dash-dim', bgDim / 100);
    document.documentElement.style.setProperty('--dash-blur', bgBlur + 'px');
    document.documentElement.style.setProperty('--dash-bright', bgBright / 100);
    document.body.classList.toggle('bg-blur', bgBlur > 0);
    if (!document.querySelector('.dash-veil')) {
      const v = document.createElement('div'); v.className = 'dash-veil'; document.body.appendChild(v);
    }
  }
  function paintBgUI() {
    document.querySelectorAll('.bg-preset').forEach((el) => el.classList.toggle('on', el.dataset.v === bgVal));
    $('fBgDim').value = bgDim; $('bgDimV').textContent = bgDim + '%';
    $('fBgBlur').value = bgBlur; $('bgBlurV').textContent = bgBlur + 'px';
    $('fBgBright').value = bgBright; $('bgBrightV').textContent = bgBright + '%';
    applyBg();
  }

  // ---- tabs ----
  document.querySelectorAll('.set-nav button[data-tab]').forEach((b) => {
    b.onclick = () => {
      document.querySelectorAll('.set-nav button[data-tab]').forEach((x) => x.classList.remove('on'));
      b.classList.add('on');
      document.querySelectorAll('[data-pane]').forEach((p) => p.classList.toggle('hidden', p.dataset.pane !== b.dataset.tab));
      // Only the editable panes need the save bar.
      $('saveBar').classList.toggle('hidden', b.dataset.tab === 'account' || b.dataset.tab === 'dev');
      window.scrollTo(0, 0);
    };
  });

  // ---- live preview ----
  function paint() {
    const display = $('fDisplay').value.trim() || me.username;
    const accent = $('fAccent').value;
    const bio = $('fBio').value.trim();

    $('pvName').textContent = display;
    $('pvHandle').textContent = '@' + me.username;
    $('pvBio').textContent = bio;
    $('pvBio').classList.toggle('hidden', !bio);

    let badges = '';
    if (me.is_nitro) badges += ' <span class="badge badge-nitro"><i class="fa-solid fa-bolt"></i> Nitro</span>';
    if (me.is_platform_admin) badges += ' <span class="badge badge-admin">Admin</span>';
    $('pvBadges').innerHTML = badges;

    const avUrl = clearAvatar ? null : (avatarFile?._preview || me.avatar_url);
    const bnUrl = clearBanner ? null : (bannerFile?._preview || me.banner_url);

    // Preview the halo from the in-progress fields, not just the saved row,
    // so editing the GIF URL or the custom CSS updates the card live.
    const haloPreview = { ...me, banner_gif_url: $('fHalo')?.value.trim() || me.banner_gif_url,
      theme: { ...(me.theme || {}), dev_mode: devMode, halo_css: $('fHaloCss')?.value.trim() || '' } };
    const wrap = $('pvAvWrap');
    wrap.className = 'pcard-av' + (me.is_nitro ? ' ' + UI.haloClass(haloPreview) : '');
    wrap.removeAttribute('style');
    const haloStyleText = me.is_nitro ? UI.haloStyleText(haloPreview) : '';
    if (haloStyleText) wrap.setAttribute('style', haloStyleText);
    $('pvAvWrap').innerHTML = avUrl
      ? `<div class="av"><img src="${avUrl}" alt=""></div>`
      : `<div class="av" style="background:${accent};">${UI.initial(display)}</div>`;

    $('pvBanner').style.background = bnUrl
      ? `url('${bnUrl}') center/cover`
      : `linear-gradient(120deg, ${accent}, ${accent}22)`;

    $('bioCount').textContent = bio.length;
  }

  ['fDisplay', 'fBio', 'fStatus'].forEach((id) => $(id).addEventListener('input', paint));

  // ---- accent ----
  function setAccent(hex) {
    $('fAccent').value = hex;
    $('fAccentHex').value = hex.toUpperCase();
    document.querySelectorAll('.swatch').forEach((s) => s.classList.toggle('on', s.dataset.c.toLowerCase() === hex.toLowerCase()));
    paint();
  }
  $('bgPresets').innerHTML = BG_PRESETS.map((b) =>
    `<div class="bg-preset" data-v="${b.v}" style="background:${b.v || 'var(--bg-2)'}"><span>${b.n}</span></div>`).join('');
  document.querySelectorAll('.bg-preset').forEach((el) => {
    el.onclick = () => { bgVal = el.dataset.v; $('fBgUrl').value = ''; paintBgUI(); };
  });
  $('fBgUrl').oninput = (e) => {
    const u = e.target.value.trim();
    bgVal = u ? `url('${u.replace(/'/g, "%27")}')` : '';
    paintBgUI();
  };
  $('fBgDim').oninput = (e) => { bgDim = +e.target.value; paintBgUI(); };
  $('fBgBright').oninput = (e) => { bgBright = +e.target.value; paintBgUI(); };
  $('fWallpaper').onchange = (e) => {
    const f = e.target.files[0]; if (!f) return;
    if (f.size > 10 * 1024 * 1024) { UI.toast('That wallpaper is over 10 MB.', true); e.target.value = ''; return; }
    wpFile = f;
    const preview = (src) => {
      $('wpPrev').innerHTML = `<img src="${src}">`;
      bgVal = `url('${src}')`;   // instant local preview; uploads on save
      $('fBgUrl').value = '';
      paintBgUI();
    };
    if (window.Tiff?.isTiff(f.name)) {
      // CSS cannot paint a TIFF, so decode it before previewing.
      window.Tiff.toPngUrl(URL.createObjectURL(f))
        .then(preview)
        .catch(() => UI.toast('That TIFF could not be read. Try a PNG or JPEG.', true));
      return;
    }
    const r = new FileReader();
    r.onload = (ev) => preview(ev.target.result);
    r.readAsDataURL(f);
  };
  $('fBgBlur').oninput = (e) => { bgBlur = +e.target.value; paintBgUI(); };
  $('bgClear').onclick = () => {
    bgVal = ''; wpFile = null;
    $('fBgUrl').value = ''; $('fWallpaper').value = '';
    $('wpPrev').innerHTML = '<i class="fa-regular fa-image"></i>';
    paintBgUI();
  };

  /* ---------- developer mode / STUN picker ---------- */
  function paintIce() {
    const probed = ICE.lastProbe();
    const msOf = (u) => probed.find((p) => p.url === u)?.ms;
    $('iceList').innerHTML = ICE.STUN.map((u) => {
      const ms = msOf(u);
      const cls = ms == null ? 'dead' : ms < 80 ? 'fast' : ms < 220 ? 'mid' : 'slow';
      const label = ms == null ? 'untested' : ms + ' ms';
      return `<label class="ice-row">
        <input type="checkbox" value="${u}" ${manualStun.includes(u) ? 'checked' : ''}>
        <code>${UI.esc(u)}</code><span class="ms ${cls}">${label}</span></label>`;
    }).join('');
    $('iceList').querySelectorAll('input').forEach((c) => {
      c.onchange = async () => {
        manualStun = [...$('iceList').querySelectorAll('input:checked')].map((x) => x.value);
        if (window.Voice) await window.Voice.setManualStun(manualStun);
        UI.toast(manualStun.length ? `Using ${manualStun.length} manual server${manualStun.length === 1 ? '' : 's'}.` : 'Back to automatic selection.');
      };
    });
  }

  $('devToggle').onchange = (e) => {
    devMode = e.target.checked;
    $('devPanel').classList.toggle('hidden', !devMode);
    syncHaloCssField();
    paint();
    if (devMode) paintIce();
  };

  // The custom-halo box only exists for Nitro members in developer mode.
  function syncHaloCssField() {
    $('haloCssField').classList.toggle('hidden', !(devMode && me?.is_nitro));
  }
  $('fHalo').oninput = () => paint();
  $('fHaloCss').oninput = () => paint();
  $('iceProbe').onclick = async (e) => {
    const b = e.currentTarget; b.disabled = true; b.textContent = 'Testing…';
    await ICE.rank(ICE.STUN, true);
    paintIce();
    b.disabled = false; b.innerHTML = '<i class="fa-solid fa-gauge-high"></i> Re-test all';
    UI.toast('Latency test finished.');
  };
  $('iceAuto').onclick = async () => {
    manualStun = [];
    if (window.Voice) await window.Voice.setManualStun([]);
    paintIce();
    UI.toast('Server selection is automatic again.');
  };

  $('swatches').innerHTML = PRESETS.map((c) => `<div class="swatch" data-c="${c}" style="background:${c}" title="${c}"></div>`).join('');
  document.querySelectorAll('.swatch').forEach((s) => { s.onclick = () => setAccent(s.dataset.c); });
  $('fAccent').oninput = (e) => setAccent(e.target.value);
  $('fAccentHex').oninput = (e) => {
    const v = e.target.value.trim();
    if (/^#[0-9a-fA-F]{6}$/.test(v)) setAccent(v);
  };

  // ---- uploads ----
  function wireUpload(inputId, prevId, clearId, kind) {
    $(inputId).onchange = (e) => {
      const f = e.target.files[0]; if (!f) return;
      const max = kind === 'avatar' ? 2 : 4;
      if (f.size > max * 1024 * 1024) { UI.toast(`That file is over ${max} MB.`, true); e.target.value = ''; return; }
      const r = new FileReader();
      r.onload = (ev) => {
        f._preview = ev.target.result;
        if (kind === 'avatar') { avatarFile = f; clearAvatar = false; } else { bannerFile = f; clearBanner = false; }
        $(prevId).innerHTML = `<img src="${ev.target.result}" alt="">`;
        window.Tiff?.hydrateFile($(prevId).querySelector('img'), f);
        $(clearId).classList.remove('hidden');
        paint();
      };
      r.readAsDataURL(f);
    };
    $(clearId).onclick = () => {
      if (kind === 'avatar') { avatarFile = null; clearAvatar = true; $(prevId).innerHTML = '<i class="fa-regular fa-user"></i>'; }
      else { bannerFile = null; clearBanner = true; $(prevId).innerHTML = '<i class="fa-regular fa-image"></i>'; }
      $(inputId).value = '';
      $(clearId).classList.add('hidden');
      paint();
    };
  }
  wireUpload('fAvatar', 'avPrev', 'avClear', 'avatar');
  wireUpload('fBanner', 'bnPrev', 'bnClear', 'banner');

  // ---- save ----
  $('btnSave').onclick = async () => {
    const btn = $('btnSave'); btn.disabled = true; btn.textContent = 'Saving…';
    try {
      const patch = {
        display_name: $('fDisplay').value.trim() || me.username,
        bio: $('fBio').value.trim() || null,
        custom_status: $('fStatus').value.trim() || null,
        accent_color: $('fAccent').value,
        theme: { ...(me.theme || {}) },
      };

      // Wallpaper lives in iDrive; Supabase only stores the URL, so the same
      // background follows this account onto any other device.
      if (wpFile) {
        // TIFF is not renderable as a CSS background; store a PNG instead.
        if (window.Tiff?.isTiff(wpFile.name)) {
          try { wpFile = await window.Tiff.toPngFile(wpFile); }
          catch { throw new Error('That TIFF could not be read. Try a PNG or JPEG.'); }
        }
        const key = `nexchat/users/${me.id}/wallpaper-${Date.now()}-${wpFile.name.replace(/[^\w.\-]/g, '_')}`;
        const up = await window.__nx_tp.put(key, wpFile);
        bgVal = `url('${up.url}')`;
        patch.theme.dash_wallpaper_key = key;
        wpFile = null;
        $('fWallpaper').value = '';
      }
      patch.theme.dash_bg = bgVal;
      patch.theme.dash_dim = bgDim;
      patch.theme.dash_blur = bgBlur;
      patch.theme.dash_bright = bgBright;
      patch.theme.dev_mode = devMode;
      patch.theme.manual_stun = manualStun;
      if (me.is_nitro) {
        patch.banner_gif_url = $('fHalo').value.trim() || null;
        const hc = $('fHaloCss').value.trim();
        if (hc && !UI.haloCss({ theme: { dev_mode: true, halo_css: hc } })) {
          throw new Error('That halo CSS is not allowed. Use plain declarations, with no selectors, braces or url().');
        }
        patch.theme.halo_css = hc || null;
      }

      if (avatarFile) patch.avatar_url = await UI.upload('avatars', avatarFile, me.id);
      else if (clearAvatar) patch.avatar_url = null;

      if (bannerFile) patch.banner_url = await UI.upload('banners', bannerFile, me.id);
      else if (clearBanner) patch.banner_url = null;

      const { error } = await window.db.from('profiles').update(patch).eq('id', me.id);
      if (error) throw error;

      Object.assign(me, patch);
      avatarFile = bannerFile = null; clearAvatar = clearBanner = false;
      $('avClear').classList.toggle('hidden', !me.avatar_url);
      $('bnClear').classList.toggle('hidden', !me.banner_url);
      UI.toast('Profile saved.');
      paint();
    } catch (err) {
      UI.toast(err.message || 'Could not save your profile.', true);
    } finally { btn.disabled = false; btn.textContent = 'Save changes'; }
  };

  $('btnReset').onclick = () => hydrate();

  // ---- nitro ----
  async function loadNitro() {
    ['nitroActive', 'nitroPending', 'nitroRequest', 'nitroDenied'].forEach((id) => ($(id).style.display = 'none'));

    if (me.is_nitro) {
      $('nitroActive').style.display = '';
      $('fHalo').value = me.banner_gif_url || '';
      $('fHaloCss').value = me.theme?.halo_css || '';
      syncHaloCssField();
      $('nitroSince').textContent = me.nitro_since
        ? 'Active since ' + new Date(me.nitro_since).toLocaleDateString([], { month: 'long', day: 'numeric', year: 'numeric' })
        : 'Active on your account.';
      return;
    }

    const { data: reqs } = await window.db.from('nitro_requests')
      .select('*').eq('user_id', me.id).order('created_at', { ascending: false }).limit(1);
    const last = reqs?.[0];

    if (last?.status === 'pending') { $('nitroPending').style.display = ''; return; }
    if (last?.status === 'denied') {
      $('nitroDenied').style.display = '';
      $('nitroDeniedNote').textContent = last.review_note || 'No reason was given.';
      return;
    }
    $('nitroRequest').style.display = '';
  }

  async function sendRequest() {
    const { error } = await window.db.from('nitro_requests')
      .insert({ user_id: me.id, message: $('fNitroMsg').value.trim() || null });
    if (error) return UI.toast(error.message, true);
    UI.toast('Request sent to the admins.');
    loadNitro();
  }
  $('btnNitro').onclick = sendRequest;
  $('btnNitroAgain').onclick = () => { $('nitroDenied').style.display = 'none'; $('nitroRequest').style.display = ''; };

  // ---- password ----
  $('btnPass').onclick = async () => {
    const a = $('fPass1').value, b = $('fPass2').value;
    $('passErr').textContent = '';
    if (a.length < 8) return ($('passErr').textContent = 'Use at least 8 characters.');
    if (a !== b) return ($('passErr').textContent = 'Those don\u2019t match.');
    const btn = $('btnPass'); btn.disabled = true; btn.textContent = 'Updating…';
    const { error } = await window.db.auth.updateUser({ password: a });
    btn.disabled = false; btn.textContent = 'Update password';
    if (error) return ($('passErr').textContent = error.message);
    $('fPass1').value = ''; $('fPass2').value = '';
    UI.toast('Password updated.');
  };

  $('btnOut').onclick = async () => { await window.db.auth.signOut(); window.location.href = 'index.html'; };

  function hydrate() {
    $('fDisplay').value = me.display_name || '';
    $('fBio').value = me.bio || '';
    $('fStatus').value = me.custom_status || '';
    setAccent(me.accent_color || '#2FBF87');
    const th = me.theme || {};
    bgVal = th.dash_bg || '';
    bgDim = th.dash_dim ?? 0;
    bgBlur = th.dash_blur ?? 0;
    bgBright = th.dash_bright ?? 100;
    devMode = !!th.dev_mode;
    manualStun = th.manual_stun || [];
    wpFile = null;
    if (bgVal.startsWith('url(')) {
      const u = bgVal.slice(5, -2);
      $('wpPrev').innerHTML = `<img src="${u}">`;
      if (!th.dash_wallpaper_key) $('fBgUrl').value = u;
    } else {
      $('wpPrev').innerHTML = '<i class="fa-regular fa-image"></i>';
    }
    $('devToggle').checked = devMode;
    $('devPanel').classList.toggle('hidden', !devMode);
    $('fHaloCss').value = th.halo_css || '';
    syncHaloCssField();
    if (devMode) paintIce();
    paintBgUI();
    avatarFile = bannerFile = null; clearAvatar = clearBanner = false;
    $('fAvatar').value = ''; $('fBanner').value = '';
    $('avPrev').innerHTML = me.avatar_url ? `<img src="${UI.esc(me.avatar_url)}" alt="">` : '<i class="fa-regular fa-user"></i>';
    $('bnPrev').innerHTML = me.banner_url ? `<img src="${UI.esc(me.banner_url)}" alt="">` : '<i class="fa-regular fa-image"></i>';
    $('avClear').classList.toggle('hidden', !me.avatar_url);
    $('bnClear').classList.toggle('hidden', !me.banner_url);
    paint();
  }

  (async () => {
    const s = await UI.requireSession(); if (!s) return;
    me = await UI.myProfile(s.user.id);
    if (!me) return UI.toast('Could not load your profile.', true);
    window.Notify?.start(me);
    window.Guard?.start(me);
    $('acUser').textContent = '@' + me.username;
    $('acSince').textContent = new Date(me.created_at).toLocaleDateString([], { month: 'long', day: 'numeric', year: 'numeric' });
    hydrate();
    loadNitro();
  })();
})();
