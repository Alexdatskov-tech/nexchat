/* ICE server catalogue + latency probing. */
window.ICE = (function () {
  const STUN = [
    'stun:stun.l.google.com:19302',
    'stun:stun1.l.google.com:19302',
    'stun:stun2.l.google.com:19302',
    'stun:stun3.l.google.com:19302',
    'stun:stun4.l.google.com:19302',
    'stun:stun.cloudflare.com:3478',
    'stun:stun.fbsbx.com:3478',
    'stun:stun.antisip.com:3478',
    'stun:stun.counterpath.net:3478',
    'stun:stun.ipfire.org:3478',
    'stun:stun.pjsip.org:3478',
    'stun:stun.sigmavoip.com:3478',
    'stun:stun.sip.us:3478',
    'stun:stun.nextcloud.com:443',
    'stun:stun.flashdance.cx:3478',
    'stun:stun.cope.es:3478',
  ];

  const TURN = [
    { urls: 'turn:openrelay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' },
    { urls: 'turn:openrelay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' },
    { urls: 'turn:openrelay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' },
    { urls: 'turn:openrelay.metered.ca:80?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' },
  ];

  const CACHE_KEY = 'nx_ice_probe';
  const CACHE_TTL = 30 * 60 * 1000;

  /* Times how long a STUN server takes to hand back a server-reflexive
     candidate. Unreachable servers resolve as null and get dropped. */
  function probe(url, timeout = 2500) {
    return new Promise((resolve) => {
      let pc, done = false, t0 = performance.now();
      const finish = (ms) => {
        if (done) return;
        done = true;
        try { pc.close(); } catch {}
        resolve(ms);
      };
      try {
        pc = new RTCPeerConnection({ iceServers: [{ urls: url }], iceCandidatePoolSize: 0 });
      } catch { return resolve(null); }
      const timer = setTimeout(() => finish(null), timeout);
      pc.onicecandidate = (e) => {
        if (e.candidate && e.candidate.candidate.includes('typ srflx')) {
          clearTimeout(timer);
          finish(Math.round(performance.now() - t0));
        }
      };
      pc.createDataChannel('p');
      pc.createOffer().then((o) => pc.setLocalDescription(o)).catch(() => finish(null));
    });
  }

  async function rank(list = STUN, force = false) {
    if (!force) {
      try {
        const c = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null');
        if (c && Date.now() - c.at < CACHE_TTL && c.list?.length) return c.list;
      } catch {}
    }
    const results = await Promise.all(list.map(async (u) => ({ url: u, ms: await probe(u) })));
    const ok = results.filter((r) => r.ms !== null).sort((a, b) => a.ms - b.ms);
    const out = ok.length ? ok : list.map((u) => ({ url: u, ms: null }));
    try { localStorage.setItem(CACHE_KEY, JSON.stringify({ at: Date.now(), list: out })); } catch {}
    return out;
  }

  /* Builds the iceServers array actually handed to RTCPeerConnection.
     Honours a manual override when developer mode is on. */
  async function build(opts = {}) {
    const manual = opts.manual && opts.manual.length ? opts.manual : null;
    let chosen;
    if (manual) {
      chosen = manual.slice(0, 6);
    } else {
      const ranked = await rank(STUN, opts.force);
      chosen = ranked.slice(0, 5).map((r) => r.url);
    }
    return [{ urls: chosen }, ...TURN];
  }

  function lastProbe() {
    try { return JSON.parse(localStorage.getItem(CACHE_KEY) || 'null')?.list || []; } catch { return []; }
  }

  return { STUN, TURN, probe, rank, build, lastProbe };
})();
