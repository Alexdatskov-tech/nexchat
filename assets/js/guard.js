/* Account guard: enforces a ban on an already-signed-in session, and renders
   the ban screen wherever it is needed.

   Checking only at sign-in leaves anyone who is already logged in with a
   fully working app until they happen to reload. This watches the live
   session's own profile row and slams a blocking screen over the page the
   moment is_banned flips true.

   Realtime is the fast path but is not trusted on its own -- a channel can
   report SUBSCRIBED and then deliver nothing -- so a slow poll always runs
   alongside it.

   The same screen is reused by the sign-in page, which hits a banned account
   before a session exists. Guard.screen() is therefore separate from the
   watching: it takes what it needs and renders, with no session assumed. */
window.Guard = (function () {
  let me = null, chan = null, timer = null, locked = false;
  const POLL_MS = 15000;

  const esc = (s) => (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  /* Renders the ban interstitial.
       opts.reason   - shown in the reason panel when present
       opts.userId   - who is appealing; without it the appeal form is hidden,
                       since an appeal has to be attributable to an account
       opts.onExit   - what the dismiss button does; defaults to signing out
       opts.exitText - label for that button                                  */
  function screen(opts) {
    const o = opts || {};
    if (document.querySelector('.ban-screen')) return;

    document.querySelectorAll('audio, video').forEach((el) => { try { el.pause(); } catch {} });

    const el = document.createElement('div');
    el.className = 'ban-screen';
    el.setAttribute('role', 'alertdialog');
    el.setAttribute('aria-modal', 'true');
    el.innerHTML = `
      <div class="ban-noise" aria-hidden="true"></div>
      <div class="ban-scan" aria-hidden="true"></div>
      <div class="ban-card">
        <div class="ban-icon"><i class="fa-solid fa-ban"></i></div>
        <h1 class="ban-title" data-t="ACCOUNT BANNED">ACCOUNT BANNED</h1>
        <p class="ban-sub">Your access to NexChat has been revoked by an administrator.</p>
        ${o.reason ? `<div class="ban-reason"><span>Reason</span><p>${esc(o.reason)}</p></div>` : ''}
        <div class="ban-acts">
          ${o.userId ? '<button class="ban-btn ban-btn-quiet" id="banAppeal">Appeal this ban</button>' : ''}
          <button class="ban-btn" id="banOut">${esc(o.exitText || 'Sign out')}</button>
        </div>
        ${o.userId ? `
        <form class="ban-appeal hidden" id="banForm">
          <label for="banMsg">Tell an administrator why this should be reviewed</label>
          <textarea id="banMsg" rows="4" maxlength="2000" required
                    placeholder="Explain what happened, in your own words."></textarea>
          <div class="ban-appeal-foot">
            <span class="ban-count" id="banCount">0 / 2000</span>
            <button type="submit" class="ban-btn ban-btn-sm" id="banSend">Submit appeal</button>
          </div>
          <p class="ban-note hidden" id="banNote"></p>
        </form>` : ''}
      </div>`;
    document.body.appendChild(el);
    document.body.classList.add('is-banned');

    const btn = el.querySelector('#banOut');
    btn.onclick = async () => {
      btn.disabled = true;
      btn.textContent = 'Signing out…';
      if (o.onExit) { o.onExit(); return; }
      try { await window.db.auth.signOut(); } catch {}
      window.location.replace('index.html');
    };

    if (o.userId) wireAppeal(el, o.userId);

    setTimeout(() => btn.focus(), 60);
    // Focus stays inside the dialog; nothing behind it is reachable.
    el.addEventListener('keydown', (e) => {
      if (e.key !== 'Tab') return;
      const f = [...el.querySelectorAll('button, textarea')].filter((x) => !x.disabled && x.offsetParent);
      if (!f.length) return e.preventDefault();
      const i = f.indexOf(document.activeElement);
      const next = e.shiftKey ? (i <= 0 ? f.length - 1 : i - 1) : (i === f.length - 1 ? 0 : i + 1);
      f[next].focus();
      e.preventDefault();
    });
    return el;
  }

  function wireAppeal(el, userId) {
    const open = el.querySelector('#banAppeal');
    const form = el.querySelector('#banForm');
    const msg = el.querySelector('#banMsg');
    const send = el.querySelector('#banSend');
    const note = el.querySelector('#banNote');
    const count = el.querySelector('#banCount');

    const say = (text, bad) => {
      note.textContent = text;
      note.classList.remove('hidden');
      note.classList.toggle('bad', !!bad);
    };

    open.onclick = () => {
      const showing = !form.classList.contains('hidden');
      form.classList.toggle('hidden', showing);
      open.textContent = showing ? 'Appeal this ban' : 'Cancel appeal';
      if (!showing) setTimeout(() => msg.focus(), 40);
    };

    msg.oninput = () => { count.textContent = `${msg.value.length} / 2000`; };

    form.onsubmit = async (e) => {
      e.preventDefault();
      const text = msg.value.trim();
      if (text.length < 10) return say('Please write at least a sentence — 10 characters minimum.', true);

      send.disabled = true;
      send.textContent = 'Sending…';
      try {
        const { error } = await window.db.from('ban_appeals').insert({ user_id: userId, message: text });
        if (error) throw error;
        form.innerHTML = '<p class="ban-note ok">Appeal submitted. An administrator will review it — '
          + 'you\u2019ll be able to sign in again if it\u2019s accepted.</p>';
        open.remove();
      } catch (err) {
        // The partial unique index is what enforces one open appeal per user.
        const dupe = /duplicate key|unique/i.test(err.message || '');
        say(dupe ? 'You already have an appeal waiting to be reviewed.'
                 : (err.message || 'Could not submit that appeal.'), true);
        send.disabled = false;
        send.textContent = 'Submit appeal';
      }
    };
  }

  function lock(reason) {
    if (locked) return;
    locked = true;

    // Stop everything still talking to the backend on this page.
    try { window.Notify?.stop?.(); } catch {}
    try { window.Voice?.leave?.(); } catch {}
    if (timer) { clearInterval(timer); timer = null; }
    if (chan) { try { window.db.removeChannel(chan); } catch {} chan = null; }

    screen({ reason, userId: me?.id });
  }

  async function check() {
    if (locked || !me) return;
    const { data, error } = await window.db.from('profiles')
      .select('is_banned, ban_reason').eq('id', me.id).single();
    // A missing row means the account was deleted out from under us.
    if (error) return;
    if (data?.is_banned) lock(data.ban_reason);
  }

  function start(profile) {
    if (!profile || me) return;
    me = profile;

    // Already banned when the page opened.
    if (profile.is_banned) { lock(profile.ban_reason); return; }

    chan = window.db.channel('nx-guard:' + me.id)
      .on('postgres_changes', {
        event: 'UPDATE', schema: 'public', table: 'profiles', filter: `id=eq.${me.id}`,
      }, (p) => { if (p.new?.is_banned) lock(p.new.ban_reason); })
      .subscribe((status, err) => {
        if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
          console.warn('NexChat realtime: nx-guard -> ' + status, err || '');
        }
      });

    // Never switched off: the socket reporting healthy is not proof it delivers.
    timer = setInterval(check, POLL_MS);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) check(); });
    check();
  }

  return { start, check, screen, get locked() { return locked; } };
})();
