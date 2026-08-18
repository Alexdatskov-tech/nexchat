(function () {
  const $ = (id) => document.getElementById(id);
  let me = null, avatarFile = null, bannerFile = null;
  let clearAvatar = false, clearBanner = false;

  const PRESETS = ['#2FBF87', '#3B9EF5', '#8B7CF6', '#E8659A', '#E8B04B', '#E5484D', '#5AC8D8', '#94A3B8'];

  // ---- tabs ----
  document.querySelectorAll('.set-nav button[data-tab]').forEach((b) => {
    b.onclick = () => {
      document.querySelectorAll('.set-nav button[data-tab]').forEach((x) => x.classList.remove('on'));
      b.classList.add('on');
      document.querySelectorAll('[data-pane]').forEach((p) => p.classList.toggle('hidden', p.dataset.pane !== b.dataset.tab));
      // Only the editable panes need the save bar.
      $('saveBar').classList.toggle('hidden', b.dataset.tab === 'account');
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

    $('pvAvWrap').className = 'pcard-av' + (me.is_nitro ? ' av-halo' : '');
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
      };
      if (me.is_nitro) patch.banner_gif_url = $('fHalo').value.trim() || null;

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
    $('acUser').textContent = '@' + me.username;
    $('acSince').textContent = new Date(me.created_at).toLocaleDateString([], { month: 'long', day: 'numeric', year: 'numeric' });
    hydrate();
    loadNitro();
  })();
})();
