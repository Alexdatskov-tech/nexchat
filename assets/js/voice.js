/* Voice + video rooms. WebRTC mesh, Supabase Realtime broadcast for signalling.
   Peers pre-negotiate audio + two video transceivers (camera and screen) so a
   camera or share can be switched on later with replaceTrack — no mid-call
   renegotiation, which is what previously left people seeing a black tile. */
window.Voice = (function () {
  let sig = null, local = null, screen = null, camTrack = null;
  let iceServers = null, manualStun = null;
  const peers = new Map();          // uid -> { pc, tx, audioStream, camStream, screenStream, queue }
  const members = new Map();        // uid -> profile + flags
  let me = null, chan = null, srvId = null;
  let muted = false, deaf = false, cam = false, sharing = false;
  let onChange = () => {}, onSpeak = () => {}, onStats = () => {};
  let actx = null, rafId = null, statTimer = null;
  const meters = new Map();
  let stats = { res: '', fps: 0, vkbps: 0, akbps: 0, rtt: 0, codec: '' };
  let prevBytes = { v: 0, a: 0, t: 0 };

  const state = () => ({ active: !!chan, channel: chan, muted, deaf, cam, sharing, members, stats });

  /* ---------- HD audio: force stereo, high-bitrate Opus -------------------
     WebRTC has no AAC; Opus at 256 kbps stereo/48 kHz is the highest-fidelity
     option browsers actually offer, and beats AAC at the same rate. */
  function hifiAudio(sdp) {
    const pt = (sdp.match(/a=rtpmap:(\d+)\s+opus\/48000\/2/i) || [])[1];
    if (!pt) return sdp;
    const opts = 'stereo=1;sprop-stereo=1;maxaveragebitrate=256000;maxplaybackrate=48000;useinbandfec=1;usedtx=0';
    if (new RegExp(`a=fmtp:${pt} `).test(sdp)) {
      return sdp.replace(new RegExp(`a=fmtp:${pt} ([^\\r\\n]*)`), (m, p) => {
        const kept = p.split(';').filter((x) => !/^(stereo|sprop-stereo|maxaveragebitrate|maxplaybackrate|useinbandfec|usedtx)=/.test(x.trim()));
        return `a=fmtp:${pt} ${[...kept, opts].filter(Boolean).join(';')}`;
      });
    }
    return sdp.replace(new RegExp(`(a=rtpmap:${pt} opus/48000/2\\r?\\n)`), `$1a=fmtp:${pt} ${opts}\r\n`);
  }
  const withHifi = (d) => ({ type: d.type, sdp: hifiAudio(d.sdp) });

  async function getMic() {
    if (local) return local;
    local = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true, noiseSuppression: true, autoGainControl: true,
        channelCount: 2, sampleRate: 48000, sampleSize: 16,
      },
      video: false,
    });
    return local;
  }

  function blankPeer(uid) {
    const pc = new RTCPeerConnection({ iceServers, iceCandidatePoolSize: 4, bundlePolicy: 'max-bundle' });
    const rec = {
      pc, tx: { audio: null, cam: null, screen: null },
      audioStream: new MediaStream(), camStream: new MediaStream(), screenStream: new MediaStream(),
      recv: new Map(),          // transceiver -> received video track
      queue: [], ready: false,
    };
    peers.set(uid, rec);

    pc.onicecandidate = (e) => { if (e.candidate) send('ice', { to: uid, candidate: e.candidate }); };

    pc.ontrack = (e) => {
      const tr = e.track, tx = e.transceiver;
      if (tr.kind === 'audio') {
        rec.audioStream.addTrack(tr);
        attachAudio(uid, rec);
        if (!meters.has(uid)) meter(uid, rec.audioStream);
      } else {
        // ontrack can fire before the answerer has mapped its transceivers, so
        // just record the track and let rebuildVideo() decide where it belongs.
        rec.recv.set(tx, tr);
        tr.onended = () => { rec.recv.delete(tx); rebuildVideo(rec); onChange(state()); };
        tr.onmute = () => { rebuildVideo(rec); onChange(state()); };
        tr.onunmute = () => { rebuildVideo(rec); onChange(state()); };
        rebuildVideo(rec);
      }
      onChange(state());
    };

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed') { try { pc.restartIce(); } catch {} }
      if (['closed', 'disconnected'].includes(pc.connectionState)) setTimeout(() => {
        if (peers.get(uid)?.pc.connectionState === 'disconnected') drop(uid);
      }, 6000);
      onChange(state());
    };
    return rec;
  }

  /* A transceiver that nobody is sending on still hands us a receiver track —
     it just stays muted and never delivers frames. Those phantom tracks are
     what produced empty "SCREEN" tiles and black camera tiles, so only tracks
     that are live AND unmuted count as a real feed. */
  const liveTrack = (t) => !!t && t.readyState === 'live' && !t.muted;

  function setStream(stream, track) {
    const cur = stream.getVideoTracks();
    if (track && cur.length === 1 && cur[0] === track) return false;
    cur.forEach((t) => stream.removeTrack(t));
    if (track) stream.addTrack(track);
    return true;
  }

  /* Slot the received video tracks by m-line position: first video transceiver
     is the camera, second is the screen. Works on both sides of the call and
     re-runs whenever a track mutes, unmutes or ends. */
  function rebuildVideo(rec) {
    const vids = rec.pc.getTransceivers().filter((t) =>
      (t.receiver.track && t.receiver.track.kind === 'video') || rec.recv.has(t));
    const camTx = vids[0], scrTx = vids[1];
    const camT = camTx ? (rec.recv.get(camTx) || camTx.receiver.track) : null;
    const scrT = scrTx ? (rec.recv.get(scrTx) || scrTx.receiver.track) : null;
    const a = setStream(rec.camStream, liveTrack(camT) ? camT : null);
    const b = setStream(rec.screenStream, liveTrack(scrT) ? scrT : null);
    return a || b;
  }

  /* Offerer builds the m-line layout: audio, camera video, screen video. */
  function buildOfferer(uid) {
    const rec = blankPeer(uid);
    const { pc } = rec;
    rec.tx.audio = pc.addTransceiver(local.getAudioTracks()[0], { direction: 'sendrecv' });
    rec.tx.cam = pc.addTransceiver('video', { direction: 'sendrecv' });
    rec.tx.screen = pc.addTransceiver('video', { direction: 'sendrecv' });
    applyLocalVideo(rec);
    rec.ready = true;
    return rec;
  }

  /* Answerer adopts the layout the offer defined, then attaches its own tracks. */
  function adoptTransceivers(rec) {
    const txs = rec.pc.getTransceivers();
    const a = txs.find((t) => (t.receiver.track || {}).kind === 'audio' || t.mid === '0');
    const vids = txs.filter((t) => (t.receiver.track || {}).kind === 'video');
    rec.tx.audio = a || txs[0];
    rec.tx.cam = vids[0] || null;
    rec.tx.screen = vids[1] || null;
    try {
      if (rec.tx.audio) {
        rec.tx.audio.direction = 'sendrecv';
        rec.tx.audio.sender.replaceTrack(local.getAudioTracks()[0]);
      }
      [rec.tx.cam, rec.tx.screen].forEach((t) => { if (t) t.direction = 'sendrecv'; });
    } catch {}
    applyLocalVideo(rec);
    rebuildVideo(rec);
    rec.ready = true;
  }

  function applyLocalVideo(rec) {
    try {
      if (rec.tx.cam) rec.tx.cam.sender.replaceTrack(cam ? camTrack : null);
      if (rec.tx.screen) rec.tx.screen.sender.replaceTrack(sharing && screen ? screen.getVideoTracks()[0] : null);
    } catch {}
  }

  async function flushIce(rec) {
    while (rec.queue.length) {
      const c = rec.queue.shift();
      try { await rec.pc.addIceCandidate(new RTCIceCandidate(c)); } catch {}
    }
  }

  function attachAudio(uid, rec) {
    let a = document.getElementById('va-' + uid);
    if (!a) {
      a = document.createElement('audio');
      a.id = 'va-' + uid;
      a.autoplay = true; a.playsInline = true;
      document.body.appendChild(a);
    }
    if (a.srcObject !== rec.audioStream) a.srcObject = rec.audioStream;
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

  async function offerTo(uid) {
    const rec = peers.get(uid) || buildOfferer(uid);
    const o = await rec.pc.createOffer();
    await rec.pc.setLocalDescription(o);
    send('offer', { to: uid, sdp: withHifi(rec.pc.localDescription), profile: selfProfile() });
  }

  const selfProfile = () => ({ ...me, muted, deaf, cam, sharing });

  /* ---------- speaking meters ---------- */
  function meter(uid, stream) {
    try {
      actx = actx || new (window.AudioContext || window.webkitAudioContext)();
      if (actx.state === 'suspended') actx.resume();
      const an = actx.createAnalyser();
      an.fftSize = 512; an.smoothingTimeConstant = 0.75;
      actx.createMediaStreamSource(stream).connect(an);
      meters.set(uid, { an, data: new Uint8Array(an.frequencyBinCount), on: false });
      if (!rafId) tick();
    } catch {}
  }
  function tick() {
    let changed = false;
    meters.forEach((m, uid) => {
      m.an.getByteFrequencyData(m.data);
      let s = 0;
      for (let i = 0; i < m.data.length; i++) s += m.data[i] * m.data[i];
      const on = Math.sqrt(s / m.data.length) > 12 && !(uid === me?.id && muted);
      if (on !== m.on) { m.on = on; changed = true; }
    });
    if (changed) onSpeak(speaking());
    rafId = requestAnimationFrame(tick);
  }
  function speaking() {
    const s = new Set();
    meters.forEach((m, uid) => { if (m.on) s.add(uid); });
    return s;
  }

  /* ---------- live connection stats ---------- */
  async function pollStats() {
    const rec = [...peers.values()][0];
    if (!rec) {
      const t = cam ? camTrack : (sharing && screen ? screen.getVideoTracks()[0] : null);
      const s = t?.getSettings?.() || {};
      stats = { ...stats, res: s.width ? `${s.width}×${s.height}` : '', fps: Math.round(s.frameRate || 0) };
      onStats(stats); return;
    }
    try {
      const rep = await rec.pc.getStats();
      let vBytes = 0, aBytes = 0, w = 0, h = 0, fps = 0, rtt = 0, codec = '';
      rep.forEach((r) => {
        if (r.type === 'outbound-rtp' && r.kind === 'video' && !r.isRemote) {
          vBytes += r.bytesSent || 0;
          if (r.frameWidth) { w = r.frameWidth; h = r.frameHeight; fps = Math.round(r.framesPerSecond || 0); }
        }
        if (r.type === 'outbound-rtp' && r.kind === 'audio' && !r.isRemote) aBytes += r.bytesSent || 0;
        if (r.type === 'candidate-pair' && r.state === 'succeeded' && r.currentRoundTripTime != null) {
          rtt = Math.round(r.currentRoundTripTime * 1000);
        }
        if (r.type === 'codec' && /opus/i.test(r.mimeType || '')) {
          codec = `Opus ${r.channels === 2 ? 'stereo' : 'mono'} ${Math.round((r.clockRate || 48000) / 1000)}kHz`;
        }
      });
      const now = performance.now();
      const dt = prevBytes.t ? (now - prevBytes.t) / 1000 : 0;
      const vk = dt > 0 ? Math.round(((vBytes - prevBytes.v) * 8) / dt / 1000) : 0;
      const ak = dt > 0 ? Math.round(((aBytes - prevBytes.a) * 8) / dt / 1000) : 0;
      prevBytes = { v: vBytes, a: aBytes, t: now };
      stats = {
        res: w ? `${w}×${h}` : '', fps,
        vkbps: Math.max(0, vk), akbps: Math.max(0, ak),
        rtt, codec: codec || 'Opus stereo 48kHz',
      };
      onStats(stats);
    } catch {}
  }

  /* ---------- join / leave ---------- */
  async function join(channel, serverId, profile, cb, speakCb, statsCb) {
    if (chan) await leave();
    me = profile; chan = channel; srvId = serverId;
    onChange = cb || (() => {}); onSpeak = speakCb || (() => {}); onStats = statsCb || (() => {});

    iceServers = await ICE.build({ manual: manualStun });

    try { await getMic(); }
    catch { chan = null; UI.toast('NexChat needs microphone access to join voice.', true); throw new Error('mic'); }

    members.set(me.id, selfProfile());
    meter(me.id, local);

    await window.db.from('voice_sessions').upsert({
      channel_id: channel.id, user_id: me.id, server_id: serverId,
      is_muted: muted, is_deafened: deaf, is_camera_on: cam, is_screen_sharing: sharing,
    });

    sig = window.db.channel('voice:' + channel.id, { config: { broadcast: { self: false, ack: false } } });

    sig.on('broadcast', { event: 'sig' }, async ({ payload: m }) => {
      if (!m || m.from === me.id || (m.to && m.to !== me.id)) return;
      const lowerIsMe = me.id < m.from;

      try {
        if (m.type === 'hello') {
          members.set(m.from, m.profile);
          // Lower id always offers. The higher id answers the ack so that a
          // late joiner still gets an offer from whoever was already here.
          if (lowerIsMe) await offerTo(m.from);
          else send('hello-ack', { to: m.from, profile: selfProfile() });
          onChange(state());
        }

        else if (m.type === 'hello-ack') {
          members.set(m.from, m.profile);
          if (lowerIsMe && !peers.has(m.from)) await offerTo(m.from);
          onChange(state());
        }

        else if (m.type === 'offer') {
          members.set(m.from, m.profile);
          let rec = peers.get(m.from);
          if (rec && !lowerIsMe) { /* keep */ }
          if (!rec) rec = blankPeer(m.from);
          await rec.pc.setRemoteDescription(new RTCSessionDescription(m.sdp));
          adoptTransceivers(rec);
          const ans = await rec.pc.createAnswer();
          await rec.pc.setLocalDescription(ans);
          await flushIce(rec);
          send('answer', { to: m.from, sdp: withHifi(rec.pc.localDescription), profile: selfProfile() });
          onChange(state());
        }

        else if (m.type === 'answer') {
          const rec = peers.get(m.from);
          if (rec && rec.pc.signalingState === 'have-local-offer') {
            await rec.pc.setRemoteDescription(new RTCSessionDescription(m.sdp));
            await flushIce(rec);
          }
        }

        else if (m.type === 'ice') {
          const rec = peers.get(m.from);
          if (!rec) return;
          if (rec.pc.remoteDescription && rec.pc.remoteDescription.type) {
            try { await rec.pc.addIceCandidate(new RTCIceCandidate(m.candidate)); } catch {}
          } else rec.queue.push(m.candidate);
        }

        else if (m.type === 'bye') drop(m.from);

        else if (m.type === 'state') {
          members.set(m.from, { ...(members.get(m.from) || {}), ...m.flags });
          onChange(state());
        }

        else if (m.type === 'ping') send('hello-ack', { to: m.from, profile: selfProfile() });
      } catch (err) { console.warn('signal error', m.type, err); }
    });

    await sig.subscribe((status) => {
      if (status === 'SUBSCRIBED') {
        send('hello', { profile: selfProfile() });
        // Second announce covers anyone whose subscription landed a beat later.
        setTimeout(() => send('ping', {}), 1200);
      }
    });

    statTimer = setInterval(() => {
      pollStats();
      // Some browsers fire mute/unmute inconsistently, so re-derive each tick.
      let changed = false;
      peers.forEach((rec) => { if (rebuildVideo(rec)) changed = true; });
      if (changed) onChange(state());
    }, 1000);
    onChange(state());
    return true;
  }

  async function leave() {
    if (!chan) return;
    send('bye', {});
    peers.forEach((p, uid) => { try { p.pc.close(); } catch {} document.getElementById('va-' + uid)?.remove(); });
    peers.clear(); members.clear(); meters.clear();
    if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
    if (statTimer) { clearInterval(statTimer); statTimer = null; }
    if (sig) { await window.db.removeChannel(sig); sig = null; }
    try { await window.db.from('voice_sessions').delete().eq('channel_id', chan.id).eq('user_id', me.id); } catch {}
    if (local) { local.getTracks().forEach((t) => t.stop()); local = null; }
    if (screen) { screen.getTracks().forEach((t) => t.stop()); screen = null; }
    if (camTrack) { camTrack.stop(); camTrack = null; }
    chan = null; cam = false; sharing = false;
    prevBytes = { v: 0, a: 0, t: 0 };
    onChange(state());
  }

  async function pushFlags() {
    members.set(me.id, selfProfile());
    if (chan) {
      window.db.from('voice_sessions')
        .update({ is_muted: muted, is_deafened: deaf, is_camera_on: cam, is_screen_sharing: sharing })
        .eq('channel_id', chan.id).eq('user_id', me.id).then(() => {});
    }
    send('state', { flags: { muted, deaf, cam, sharing } });
  }

  function setMute(v) {
    muted = v ?? !muted;
    local?.getAudioTracks().forEach((t) => (t.enabled = !muted));
    pushFlags(); onChange(state());
  }

  function setDeaf(v) {
    deaf = v ?? !deaf;
    if (deaf && !muted) { muted = true; local?.getAudioTracks().forEach((t) => (t.enabled = false)); }
    peers.forEach((_, uid) => { const a = document.getElementById('va-' + uid); if (a) a.muted = deaf; });
    pushFlags(); onChange(state());
  }

  async function toggleCam() {
    if (cam) {
      if (camTrack) { camTrack.stop(); camTrack = null; }
      cam = false;
    } else {
      try {
        const s = await navigator.mediaDevices.getUserMedia({
          video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } },
        });
        camTrack = s.getVideoTracks()[0];
        camTrack.onended = () => { cam = false; peers.forEach(applyLocalVideo); pushFlags(); onChange(state()); };
        cam = true;
      } catch { UI.toast('Could not start your camera.', true); return; }
    }
    peers.forEach(applyLocalVideo);
    pushFlags(); onChange(state());
  }

  async function toggleShare() {
    if (sharing) {
      screen?.getTracks().forEach((t) => t.stop());
      screen = null; sharing = false;
    } else {
      try {
        screen = await navigator.mediaDevices.getDisplayMedia({
          video: { frameRate: { ideal: 30, max: 60 }, width: { ideal: 1920 }, height: { ideal: 1080 } },
          audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
        });
        screen.getVideoTracks()[0].onended = () => { if (sharing) toggleShare(); };
        sharing = true;
      } catch { return; }
    }
    peers.forEach(applyLocalVideo);
    pushFlags(); onChange(state());
  }

  /* Developer mode: swap STUN servers without dropping the active call. */
  async function setManualStun(list) {
    manualStun = list && list.length ? list : null;
    iceServers = await ICE.build({ manual: manualStun });
    peers.forEach((rec) => {
      try { rec.pc.setConfiguration({ iceServers, iceCandidatePoolSize: 4, bundlePolicy: 'max-bundle' }); } catch {}
    });
    return iceServers;
  }

  const localCam = () => (cam && camTrack && camTrack.readyState === 'live' ? new MediaStream([camTrack]) : null);
  const localScreen = () => {
    if (!sharing || !screen) return null;
    const t = screen.getVideoTracks().filter((x) => x.readyState === 'live');
    return t.length ? new MediaStream(t) : null;
  };
  const peerCam = (uid) => {
    const s = peers.get(uid)?.camStream;
    return s && s.getVideoTracks().some(liveTrack) ? s : null;
  };
  const peerScreen = (uid) => {
    const s = peers.get(uid)?.screenStream;
    return s && s.getVideoTracks().some(liveTrack) ? s : null;
  };

  return {
    join, leave, setMute, setDeaf, toggleCam, toggleShare, state, speaking,
    localCam, localScreen, peerCam, peerScreen, setManualStun,
    get iceServers() { return iceServers; },
  };
})();
