// Requires the Supabase JS CDN script to be loaded before this file.
// Exposes a single shared client as `window.db` for every page to reuse.
(function () {
  if (!window.supabase || !window.supabase.createClient) {
    console.error('Supabase JS SDK failed to load. Check your network/CDN block list.');
    return;
  }
  const { SUPABASE_URL, SUPABASE_ANON_KEY } = window.NEXCHAT_CONFIG || {};
  if (!SUPABASE_URL || SUPABASE_URL.includes('YOUR-PROJECT')) {
    console.warn('NexChat: config.js still has placeholder Supabase values — fill those in first.');
  }
  const db = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: true, autoRefreshToken: true },
    realtime: { params: { eventsPerSecond: 20 } },
  });
  window.db = db;

  /* ------------------------------------------------------------------
     Realtime authentication.

     The websocket does NOT inherit the user's session from the REST
     client. Without an explicit setAuth() the changefeed connects as
     `anon`, and every RLS-protected table (messages, dm_messages, ...)
     silently yields zero rows: REST reads keep working, but no INSERT
     events are ever delivered. That is why messages only showed up on
     a page refresh.

     We push the access token in on boot and on every auth state change
     (including TOKEN_REFRESHED, which happens roughly hourly — without
     it, realtime would go quiet again after the first token expiry).
  ------------------------------------------------------------------ */
  function applyToken(token) {
    try {
      if (db.realtime && typeof db.realtime.setAuth === 'function') db.realtime.setAuth(token || null);
      else if (typeof db.setAuth === 'function') db.setAuth(token || null); // older SDKs
    } catch (e) {
      console.warn('NexChat: could not set realtime auth token', e);
    }
  }

  // `authReady` lets pages await the first token push before subscribing.
  window.authReady = db.auth.getSession()
    .then(({ data }) => { applyToken(data?.session?.access_token); return data?.session || null; })
    .catch(() => null);

  db.auth.onAuthStateChange((event, session) => {
    applyToken(session?.access_token);
    // A refreshed token needs the sockets to re-handshake with it.
    if (event === 'TOKEN_REFRESHED' || event === 'SIGNED_IN') {
      try {
        if (db.realtime && typeof db.realtime.isConnected === 'function' && db.realtime.isConnected()) {
          db.realtime.channels.forEach((ch) => {
            if (ch.state === 'errored' || ch.state === 'closed') ch.subscribe();
          });
        }
      } catch (_) { /* non-fatal */ }
    }
  });
})();
