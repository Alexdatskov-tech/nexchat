(function () {
  const tabSignIn = document.getElementById('tabSignIn');
  const tabSignUp = document.getElementById('tabSignUp');
  const formSignIn = document.getElementById('formSignIn');
  const formSignUp = document.getElementById('formSignUp');
  const toast = document.getElementById('toast');

  function showTab(which) {
    const isIn = which === 'signin';
    tabSignIn.classList.toggle('active', isIn);
    tabSignUp.classList.toggle('active', !isIn);
    formSignIn.classList.toggle('hidden', !isIn);
    formSignUp.classList.toggle('hidden', isIn);
  }
  tabSignIn.addEventListener('click', () => showTab('signin'));
  tabSignUp.addEventListener('click', () => showTab('signup'));

  function showToast(msg, isError) {
    toast.textContent = msg;
    toast.classList.toggle('error', !!isError);
    toast.classList.add('show');
    setTimeout(() => toast.classList.remove('show'), 3800);
  }

  function setFieldError(id, msg) {
    const el = document.getElementById(id);
    if (el) el.textContent = msg || '';
  }

  function setLoading(btn, loading, label) {
    btn.disabled = loading;
    btn.textContent = loading ? 'Please wait…' : label;
  }

  const USERNAME_RE = /^[a-zA-Z0-9_]{2,32}$/;

  // Supabase Auth requires an email/phone identifier under the hood even
  // though the person only ever sees a username. This deterministically
  // derives an invisible placeholder address from the username — never
  // displayed, never emailed (email confirmation must stay OFF in the
  // Supabase dashboard, since this address can't receive anything real).
  function usernameToPlaceholderEmail(username) {
    return `${username.trim().toLowerCase()}@users.nexchat.internal`;
  }

  // ---- Sign up ------------------------------------------------------------
  formSignUp.addEventListener('submit', async (e) => {
    e.preventDefault();
    setFieldError('errUsername', '');
    setFieldError('errSignUp', '');

    const username = document.getElementById('suUsername').value.trim();
    const password = document.getElementById('suPassword').value;
    const passwordConfirm = document.getElementById('suPasswordConfirm').value;
    const btn = document.getElementById('btnSignUp');

    if (!USERNAME_RE.test(username)) {
      setFieldError('errUsername', 'Username: 2-32 characters, letters/numbers/underscore only.');
      return;
    }
    if (password.length < 8) {
      setFieldError('errSignUp', 'Password must be at least 8 characters.');
      return;
    }
    if (password !== passwordConfirm) {
      setFieldError('errSignUp', 'Passwords don\u2019t match.');
      return;
    }

    setLoading(btn, true, 'Create account');
    try {
      // Optional pre-check RPC (public.is_username_available) — see setup notes.
      if (window.db.rpc) {
        const { data: available, error: checkErr } = await window.db.rpc('is_username_available', { p_username: username });
        if (!checkErr && available === false) {
          setFieldError('errUsername', 'That username is already taken.');
          setLoading(btn, false, 'Create account');
          return;
        }
      }

      const { data, error } = await window.db.auth.signUp({
        email: usernameToPlaceholderEmail(username),
        password,
        options: { data: { username, display_name: username } },
      });

      if (error) throw error;

      if (data.session) {
        window.location.href = 'portal.html';
      } else {
        // Should not normally happen with email confirmation off, but handle it
        // gracefully rather than telling them to check an email that doesn't exist.
        showToast('Account created — try signing in now.');
        showTab('signin');
      }
    } catch (err) {
      setFieldError('errSignUp', err.message || 'Something went wrong creating your account.');
    } finally {
      setLoading(btn, false, 'Create account');
    }
  });

  // ---- Sign in --------------------------------------------------------------
  formSignIn.addEventListener('submit', async (e) => {
    e.preventDefault();
    setFieldError('errSignIn', '');
    const username = document.getElementById('siUsername').value.trim();
    const password = document.getElementById('siPassword').value;
    const btn = document.getElementById('btnSignIn');

    setLoading(btn, true, 'Sign in');
    try {
      const { data, error } = await window.db.auth.signInWithPassword({
        email: usernameToPlaceholderEmail(username),
        password,
      });
      if (error) throw new Error('Incorrect username or password.');

      // Respect a platform-wide ban before letting them into the portal.
      const { data: profile } = await window.db
        .from('profiles')
        .select('is_banned, ban_reason')
        .eq('id', data.user.id)
        .single();

      if (profile && profile.is_banned) {
        await window.db.auth.signOut();
        setFieldError('errSignIn', 'This account has been banned' + (profile.ban_reason ? `: ${profile.ban_reason}` : '.'));
        return;
      }

      window.location.href = 'portal.html';
    } catch (err) {
      setFieldError('errSignIn', err.message || 'Could not sign in with those details.');
    } finally {
      setLoading(btn, false, 'Sign in');
    }
  });

  // If already signed in, skip straight to the portal.
  window.db?.auth.getSession().then(({ data }) => {
    if (data.session) window.location.href = 'portal.html';
  });
})();
