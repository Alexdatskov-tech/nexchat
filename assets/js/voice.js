/* Voice + video rooms: WebRTC mesh, Supabase Realtime broadcast for signalling.
   Google STUN by default, public TURN relays as fallback for strict NATs. */
window.Voice = (function () {
  const ICE = [
    { urls: ['stun:stun.l.google.com:19302','stun:stun1.l.google.com:19302',
             'stun:stun2.l.google.com:19302','stun:stun3.l.google.com:19302',
             'stun:stun4.l.google.com:19302'] },
    { urls: 'turn:openrelay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' },
    { urls: 'turn:openrelay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' },
    { urls: 'turn:openrelay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' },
  ];

  let sig = null, local = null, screen = null;
  let actx = null, rafId = null;
  const meters = new Map();   // userId -> { analyser, data, speaking }
  let onSpeak = () => {};
  const peers = new Map();          // userId -> { pc, stream, el }
  let me = null, chan = null, srvId = null;
  let muted = false, deaf = false, cam = false, sharing = false;
  let onChange = () => {};
  const members = new Map();        // userId -> profile

  const el = (id) => document.getElementById(id);

  function state() {
    return { active: !!chan, channel: chan, muted, deaf, cam, sharing, peers: [...peers.keys()], members };
  }

  /* Lightweight RMS meter per stream — drives the speaking ring on tiles. */
  function meter(uid, stream) {
    try {
      actx = actx || new (window.AudioContext || window.webkitAudioContext)();
      if (actx.state === 'suspended') actx.resume();
      const src = actx.createMediaStreamSource(stream);
      const an = actx.createAnalyser();
      an.fftSize = 512;
      an.smoothingTimeConstant = 0.75;
      src.connect(an);
      meters.set(uid, { analyser: an, data: new Uint8Array(an.frequencyBinCount), speaking: false });
      if (!rafId) tick();
    } catch {}
  }

  function tick() {
    let changed = false;
    meters.forEach((m, uid) => {
      m.analyser.getByteFrequencyData(m.data);
      let sum = 0;
      for (let i = 0; i < m.data.length; i++) sum += m.data[i] * m.data[i];
      const rms = Math.sqrt(sum / m.data.length);
      const on = rms > 12 && !(uid === me?.id && muted);
      if (on !== m.speaking) { m.speaking = on; changed = true; }
    });
    if (changed) onSpeak(speaking());
    rafId = requestAnimationFrame(tick);
  }

  function speaking() {
    const s = new Set();
    meters.forEach((m, uid) => { if (m.speaking) s.add(uid); });
    return s;
  }

  async function getMic() {
    if (local) return local;
    local = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true,
               channelCount: 2, sampleRate: 48000 },
      video: false,
    });
    return local;
  }

  function newPeer(uid) {
    const pc = new RTCPeerConnection({ iceServers: ICE, iceCandidatePoolSize: 4 });
    const rec = { pc, stream: new MediaStream() };
    peers.set(uid, rec);

    if (local) local.getTracks().forEach((t) => pc.addTrack(t, local));
    if (screen) screen.getTracks().forEach((t) => pc.addTrack(t, screen));

    pc.onicecandidate = (e) => {
      if (e.candidate) send('ice', { to: uid, candidate: e.candidate });
    };
    pc.ontrack = (e) => {
      e.streams[0].getTracks().forEach((t) => {
        if (!rec.stream.getTracks().some((x) => x.id === t.id)) rec.stream.addTrack(t);
      });
      attach(uid, rec);
      if (rec.stream.getAudioTracks().length && !meters.has(uid)) meter(uid, rec.stream);
      onChange(state());
    };
    pc.onconnectionstatechange = () => {
      if (['failed','closed','disconnected'].includes(pc.connectionState)) drop(uid);
    };
    return rec;
  }

  // Remote audio plays through a hidden element; video shows in the stage grid.
  function attach(uid, rec) {
    let a = document.getElementById('va-' + uid);
    if (!a) {
      a = document.createElement('audio');
      a.id = 'va-' + uid;
      a.autoplay = true;
      a.playsInline = true;
      document.body.appendChild(a);
    }
    a.srcObject = rec.stream;
    a.muted = deaf;
    a.play?.().catch(() => {});
  }

  function drop(uid) {
    meters.delete(uid);
    const p = peers.get(uid);
    if (p) { try { p.pc.close(); } catch {} peers.delete(uid); }
    document.getElementById('va-' + uid)?.remove();
    members.delete(uid);
    onChange(state());
  }

  function send(type, payload) {
    sig?.send({ type: 'broadcast', event: 'sig', payload: { type, from: me.id, ...payload } });
  }

  async function join(channel, serverId, profile, cb, speakCb) {
    if (chan) await leave();
    me = profile; chan = channel; srvId = serverId;
    onChange = cb || (() => {});
    onSpeak = speakCb || (() => {});

    try { await getMic(); }
    catch { UI.toast('NexChat needs microphone access to join voice.', true); chan = null; throw new Error('mic denied'); }

    members.set(me.id, me);
    meter(me.id, local);

    await window.db.from('voice_sessions').upsert({
      channel_id: channel.id, user_id: me.id, server_id: serverId,
      is_muted: muted, is_deafened: deaf, is_camera_on: cam, is_screen_sharing: sharing,
    });

    sig = window.db.channel('voice:' + channel.id, { config: { broadcast: { self: false } } });

    sig.on('broadcast', { event: 'sig' }, async ({ payload: m }) => {
      if (!m || m.from === me.id) return;
      if (m.to && m.to !== me.id) return;

      if (m.type === 'hello') {
        members.set(m.from, m.profile);
        // Deterministic tie-break: the lower id always creates the offer,
        // so two peers never glare at each other with duelling offers.
        if (me.id < m.from) {
          const rec = peers.get(m.from) || newPeer(m.from);
          const offer = await rec.pc.createOffer();
          await rec.pc.setLocalDescription(offer);
          send('offer', { to: m.from, sdp: offer, profile: me });
        } else {
          send('hello-ack', { to: m.from, profile: me });
        }
        onChange(state());
      }

      if (m.type === 'hello-ack') { members.set(m.from, m.profile); onChange(state()); }

      if (m.type === 'offer') {
        members.set(m.from, m.profile);
        const rec = peers.get(m.from) || newPeer(m.from);
        await rec.pc.setRemoteDescription(new RTCSessionDescription(m.sdp));
        const ans = await rec.pc.createAnswer();
        await rec.pc.setLocalDescription(ans);
        send('answer', { to: m.from, sdp: ans, profile: me });
        onChange(state());
      }

      if (m.type === 'answer') {
        const rec = peers.get(m.from);
        if (rec && rec.pc.signalingState !== 'stable') {
          await rec.pc.setRemoteDescription(new RTCSessionDescription(m.sdp));
        }
      }

      if (m.type === 'ice') {
        const rec = peers.get(m.from);
        if (rec) { try { await rec.pc.addIceCandidate(new RTCIceCandidate(m.candidate)); } catch {} }
      }

      if (m.type === 'bye') drop(m.from);
      if (m.type === 'state') { members.set(m.from, { ...(members.get(m.from) || {}), ...m.flags }); onChange(state()); }
    });

    await sig.subscribe((status) => {
      if (status === 'SUBSCRIBED') send('hello', { profile: me });
    });

    onChange(state());
    return true;
  }

  async function leave() {
    if (!chan) return;
    send('bye', {});
    peers.forEach((p, uid) => { try { p.pc.close(); } catch {} document.getElementById('va-' + uid)?.remove(); });
    peers.clear(); members.clear(); meters.clear();
    if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
    if (sig) { await window.db.removeChannel(sig); sig = null; }
    await window.db.from('voice_sessions').delete().eq('channel_id', chan.id).eq('user_id', me.id);
    if (local) { local.getTracks().forEach((t) => t.stop()); local = null; }
    if (screen) { screen.getTracks().forEach((t) => t.stop()); screen = null; }
    chan = null; cam = false; sharing = false;
    onChange(state());
  }

  async function pushFlags() {
    await window.db.from('voice_sessions')
      .update({ is_muted: muted, is_deafened: deaf, is_camera_on: cam, is_screen_sharing: sharing })
      .eq('channel_id', chan.id).eq('user_id', me.id);
    send('state', { flags: { muted, deaf, cam, sharing } });
  }

  function setMute(v) {
    muted = v ?? !muted;
    local?.getAudioTracks().forEach((t) => (t.enabled = !muted));
    pushFlags(); onChange(state());
  }

  function setDeaf(v) {
    deaf = v ?? !deaf;
    if (deaf && !muted) setMute(true);
    peers.forEach((_, uid) => { const a = document.getElementById('va-' + uid); if (a) a.muted = deaf; });
    pushFlags(); onChange(state());
  }

  // Replaces the outgoing video track on every peer at once.
  async function swapVideo(track) {
    for (const [, rec] of peers) {
      const s = rec.pc.getSenders().find((x) => x.track?.kind === 'video');
      if (s) await s.replaceTrack(track);
      else if (track) rec.pc.addTrack(track, local || new MediaStream([track]));
    }
  }

  async function toggleCam() {
    if (cam) {
      local?.getVideoTracks().forEach((t) => { t.stop(); local.removeTrack(t); });
      await swapVideo(null);
      cam = false;
    } else {
      try {
        const s = await navigator.mediaDevices.getUserMedia({ video: { width: 1280, height: 720 } });
        const t = s.getVideoTracks()[0];
        local.addTrack(t);
        await swapVideo(t);
        cam = true;
      } catch { UI.toast('Could not start your camera.', true); return; }
    }
    pushFlags(); onChange(state());
  }

  async function toggleShare() {
    if (sharing) {
      screen?.getTracks().forEach((t) => t.stop());
      screen = null; sharing = false;
      await swapVideo(cam ? local.getVideoTracks()[0] || null : null);
    } else {
      try {
        screen = await navigator.mediaDevices.getDisplayMedia({
          video: { frameRate: 30 }, audio: true,
        });
        const t = screen.getVideoTracks()[0];
        t.onended = () => { if (sharing) toggleShare(); };
        await swapVideo(t);
        sharing = true;
      } catch { return; }
    }
    pushFlags(); onChange(state());
  }

  function localStream() { return local; }
  function peerStream(uid) { return peers.get(uid)?.stream; }

  return { join, leave, setMute, setDeaf, toggleCam, toggleShare, state, localStream, peerStream, speaking, ICE };
})();
