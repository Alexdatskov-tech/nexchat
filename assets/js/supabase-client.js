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
  window.db = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: true, autoRefreshToken: true },
  });
})();
