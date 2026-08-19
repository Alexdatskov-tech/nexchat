/* Global realtime notifier: DM messages, friend requests, incoming calls.
   Loaded on every signed-in page so alerts arrive wherever you are. */
window.Notify = (function () {
  let me = null, convIds = new Set(), chans = [];
  const seen = new Set();

  const onDmPage = () => /dms\.html/.test(location.pathname);
  const activeConv = () => new URLSearchParams(location.search).get('c');

  async function refreshConvs() {
    const { data } = await window.db.from('dm_participants')
      .select('conversation_id').eq('user_id', me.id);
    convIds = new Set((data || []).map((p) => p.conversation_id));
  }

  async function start(profile) {
    me = profile;
    await refreshConvs();

    // --- new direct messages ---
    chans.push(window.db.channel('nx-dm-notify')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'dm_messages' }, async (p) => {
        const m = p.new;
        if (m.author_id === me.id || seen.has(m.id)) return;
        if (!convIds.has(m.conversation_id)) {
          await refreshConvs();
          if (!convIds.has(m.conversation_id)) return;
        }
        // Don't shout about a conversation you're already looking at.
        if (onDmPage() && activeConv() === m.conversation_id) return;
        seen.add(m.id);

        const { data: who } = await window.db.from('profiles')
          .select('username,display_name,avatar_url,accent_color,is_nitro').eq('id', m.author_id).single();
        const name = who?.display_name || who?.username || 'Someone';
        UI.island({
          avatar: who ? UI.avatar(who, 32, { halo: false }) : null,
          title: name,
          body: m.content ? m.content.slice(0, 60) : 'Sent an attachment',
          action: () => { window.location.href = `dms.html?c=${m.conversation_id}`; },
        });
      })
      .subscribe());

    // --- friend requests and acceptances ---
    chans.push(window.db.channel('nx-friend-notify')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'friendships' }, async (p) => {
        const f = p.new;
        if (f.friend_id !== me.id || f.status !== 'pending') return;
        const { data: who } = await window.db.from('profiles')
          .select('username,display_name,avatar_url,accent_color,is_nitro').eq('id', f.user_id).single();
        UI.island({
          avatar: who ? UI.avatar(who, 32, { halo: false }) : null,
          title: who?.display_name || who?.username || 'Someone',
          body: 'Sent you a friend request',
          accent: true,
          action: () => { window.location.href = 'dms.html#requests'; },
        });
      })
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'friendships' }, async (p) => {
        const f = p.new;
        if (f.user_id !== me.id || f.status !== 'accepted') return;
        const { data: who } = await window.db.from('profiles')
          .select('username,display_name,avatar_url,accent_color,is_nitro').eq('id', f.friend_id).single();
        UI.island({
          avatar: who ? UI.avatar(who, 32, { halo: false }) : null,
          title: who?.display_name || who?.username || 'Someone',
          body: 'Accepted your friend request',
          accent: true,
          action: () => { window.location.href = 'dms.html'; },
        });
      })
      .subscribe());

    // --- incoming DM calls ---
    chans.push(window.db.channel('nx-call:' + me.id)
      .on('broadcast', { event: 'ring' }, ({ payload }) => {
        if (!payload || payload.to !== me.id) return;
        if (onDmPage() && activeConv() === payload.conversation) return;
        UI.island({
          avatar: payload.avatar || null,
          icon: 'fa-phone',
          title: `${payload.name} is calling`,
          body: 'Tap to join the call',
          accent: true,
          duration: 20000,
          action: () => { window.location.href = `dms.html?c=${payload.conversation}&call=1`; },
        });
      })
      .subscribe());
  }

  /* Rings a specific person's personal channel. */
  function ring(toUserId, payload) {
    const ch = window.db.channel('nx-call:' + toUserId);
    ch.subscribe((s) => {
      if (s === 'SUBSCRIBED') {
        ch.send({ type: 'broadcast', event: 'ring', payload: { ...payload, to: toUserId } });
        setTimeout(() => window.db.removeChannel(ch), 1200);
      }
    });
  }

  function stop() { chans.forEach((c) => window.db.removeChannel(c)); chans = []; }

  return { start, stop, ring, refreshConvs };
})();
