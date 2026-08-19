/* Online/offline tracking via a shared Supabase Realtime presence channel. */
window.Presence = (function () {
  let chan = null, me = null;
  const online = new Set();
  const subs = new Set();

  function notify() { subs.forEach((cb) => { try { cb(online); } catch {} }); }

  function recompute(state) {
    online.clear();
    Object.keys(state || {}).forEach((k) => {
      const entries = state[k] || [];
      const id = entries[0]?.user_id || k;
      if (id) online.add(id);
    });
    notify();
  }

  async function start(profile) {
    if (chan) return;
    me = profile;
    chan = window.db.channel('nx-presence', {
      config: { presence: { key: me.id } },
    });
    chan
      .on('presence', { event: 'sync' }, () => recompute(chan.presenceState()))
      .on('presence', { event: 'join' }, () => recompute(chan.presenceState()))
      .on('presence', { event: 'leave' }, () => recompute(chan.presenceState()))
      .subscribe(async (status) => {
        if (status === 'SUBSCRIBED') {
          await chan.track({ user_id: me.id, at: Date.now() });
        }
      });

    // Leaving the tab should drop you promptly rather than waiting for timeout.
    document.addEventListener('visibilitychange', () => {
      if (!chan) return;
      if (document.visibilityState === 'hidden') chan.untrack();
      else chan.track({ user_id: me.id, at: Date.now() });
    });
    window.addEventListener('beforeunload', () => { try { chan.untrack(); } catch {} });
  }

  const isOnline = (uid) => online.has(uid);
  function onChange(cb) { subs.add(cb); cb(online); return () => subs.delete(cb); }

  /* Small status dot markup, positioned over an avatar by CSS. */
  function dot(uid, size) {
    return `<span class="pdot ${isOnline(uid) ? 'on' : 'off'}" data-pd="${uid}"
             style="${size ? `width:${size}px;height:${size}px;` : ''}"></span>`;
  }

  /* Repaints every dot currently on the page. */
  function refreshDots() {
    document.querySelectorAll('.pdot[data-pd]').forEach((el) => {
      const on = isOnline(el.dataset.pd);
      el.classList.toggle('on', on);
      el.classList.toggle('off', !on);
    });
  }

  return { start, isOnline, onChange, dot, refreshDots, get online() { return online; } };
})();
