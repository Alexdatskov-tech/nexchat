/* Account guard: enforces a ban on an already-signed-in session.

   Checking only at sign-in leaves anyone who is already logged in with a
   fully working app until they happen to reload. This watches the live
   session's own profile row and slams a blocking screen over the page the
   moment is_banned flips true.

   Realtime is the fast path but is not trusted on its own -- a channel can
   report SUBSCRIBED and then deliver nothing -- so a slow poll always runs
   alongside it. */
window.Guard = (function () {
  let me = null, chan = null, timer = null, locked = false;
  const POLL_MS = 15000;

  function lock(reason) {
    if (locked) return;
    locked = true;

    // Stop everything still talking to the backend on this page.
    try { window.Notify?.stop?.(); } catch {}
    try { window.Voice?.leave?.(); } catch {}
    if (timer) { clearInterval(timer); timer = null; }
    if (chan) { try { window.db.removeChannel(chan); } catch {} chan = null; }

    document.querySelectorAll('audio, video').forEach((el) => { try { el.pause(); } catch {} });

    const esc = (s) => (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');

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
        ${reason ? `<div class="ban-reason"><span>Reason</span><p>${esc(reason)}</p></div>` : ''}
        <button class="ban-btn" id="banOut">Sign out</button>
      </div>`;
    document.body.appendChild(el);
    document.body.classList.add('is-banned');

    // Keep focus trapped on the one control that remains.
    const btn = el.querySelector('#banOut');
    btn.onclick = async () => {
      btn.disabled = true;
      btn.textContent = 'Signing out…';
      try { await window.db.auth.signOut(); } catch {}
      window.location.replace('index.html');
    };
    setTimeout(() => btn.focus(), 60);
    el.addEventListener('keydown', (e) => { if (e.key === 'Tab') e.preventDefault(); });
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

  return { start, check, get locked() { return locked; } };
})();
