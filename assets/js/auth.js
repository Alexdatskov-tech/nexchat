(function () {
  const $ = (id) => document.getElementById(id);
  const tabIn = $('tabIn'), tabUp = $('tabUp'), formIn = $('formIn'), formUp = $('formUp');

  function showTab(which) {
    const isIn = which === 'in';
    tabIn.classList.toggle('on', isIn);
    tabUp.classList.toggle('on', !isIn);
    formIn.classList.toggle('hidden', !isIn);
    formUp.classList.toggle('hidden', isIn);
  }
  tabIn.onclick = () => showTab('in');
  tabUp.onclick = () => showTab('up');

  const setErr = (id, m) => { $(id).textContent = m || ''; };
  const busy = (btn, on, label) => { btn.disabled = on; btn.textContent = on ? 'Working…' : label; };

  const USERNAME_RE = /^[a-zA-Z0-9_]{2,32}$/;

  // Supabase Auth needs an email identifier internally. Nobody ever sees or
  // receives mail at this address — it's derived from the username so sign-in
  // stays username+password only. The TLD must be real or Supabase rejects it.
  const toAddr = (u) => `${u.trim().toLowerCase()}@users.nexchat-app.com`;

  formUp.onsubmit = async (e) => {
    e.preventDefault();
    setErr('errUser', ''); setErr('errUp', '');
    const username = $('upUser').value.trim();
    const pass = $('upPass').value, pass2 = $('upPass2').value;
    const btn = $('btnUp');

    if (!USERNAME_RE.test(username)) return setErr('errUser', '2–32 characters, letters, numbers and underscores only.');
    if (pass.length < 8) return setErr('errUp', 'Use at least 8 characters.');
    if (pass !== pass2) return setErr('errUp', 'Those passwords don\u2019t match.');

    busy(btn, true, 'Create account');
    try {
      const { data: free } = await window.db.rpc('is_username_available', { p_username: username });
      if (free === false) { setErr('errUser', 'That username is taken.'); busy(btn, false, 'Create account'); return; }

      const { data, error } = await window.db.auth.signUp({
        email: toAddr(username), password: pass,
        options: { data: { username, display_name: username } },
      });
      if (error) throw error;

      if (data.session) window.location.href = 'portal.html';
      else { UI.toast('Account created — sign in to continue.'); showTab('in'); }
    } catch (err) {
      setErr('errUp', err.message || 'Could not create that account.');
    } finally { busy(btn, false, 'Create account'); }
  };

  formIn.onsubmit = async (e) => {
    e.preventDefault();
    setErr('errIn', '');
    const btn = $('btnIn');
    busy(btn, true, 'Sign in');
    try {
      const { data, error } = await window.db.auth.signInWithPassword({
        email: toAddr($('inUser').value), password: $('inPass').value,
      });
      if (error) throw new Error('Wrong username or password.');

      const { data: p } = await window.db.from('profiles').select('is_banned, ban_reason').eq('id', data.user.id).single();
      if (p?.is_banned) {
        /* The session stays open just long enough to file an appeal -- the
           insert has to be attributable to the account, and RLS checks
           auth.uid() against it. Dismissing the card signs out properly. */
        window.Guard.screen({
          reason: p.ban_reason,
          userId: data.user.id,
          exitText: 'Back to sign in',
          onExit: async () => {
            try { await window.db.auth.signOut(); } catch {}
            window.location.reload();
          },
        });
        return;
      }
      window.location.href = 'portal.html';
    } catch (err) {
      setErr('errIn', err.message || 'Could not sign in.');
    } finally { busy(btn, false, 'Sign in'); }
  };

  window.db?.auth.getSession().then(({ data }) => { if (data.session) window.location.href = 'portal.html'; });
})();
