const { JSDOM } = require('jsdom');
const fs = require('fs');
const REPO = '/home/user/nexchat';

const html = fs.readFileSync(REPO + '/server.html', 'utf8');
const dom = new JSDOM(html, { url: 'https://app.test/server.html?id=s1', runScripts: 'outside-only', pretendToBeVisual: true });
const { window } = dom;
global.window = window; global.document = window.document; global.navigator = window.navigator;
window.matchMedia = () => ({ matches: false, addEventListener(){}, removeEventListener(){} });

const msgs = [];      // messages table
const atts = [];
let subStatus = (process.env.SOCKET === 'live' || process.env.SOCKET === 'silent') ? 'SUBSCRIBED' : 'CHANNEL_ERROR';
const SILENT = process.env.SOCKET === 'silent';
let insertHandler = null;

function tbl(name, store) {
  const q = { f: {}, gt: null, name };
  const api = {
    select() { return api; },
    eq(c, v) { q.f[c] = v; return api; },
    in(c, vs) { q.f['__in_' + c] = vs; return api; },
    gt(c, v) { q.gt = [c, v]; return api; },
    order() { return api; }, limit() { return api; },
    single: async () => ({ data: store[0] || null, error: null }),
    insert(r) {
      const row = Array.isArray(r) ? r[0] : r;
      const rec = { id: name[0] + (store.length + 1), created_at: new Date(Date.now() + store.length * 1000).toISOString(), ...row };
      store.push(rec);
      return { select: () => ({ single: async () => ({ data: rec, error: null }) }) };
    },
    delete() { return api; }, update() { return api; },
    then(res, rej) {
      let out = store.filter((r) => Object.entries(q.f).every(([k, v]) =>
        k.startsWith('__in_') ? v.includes(r[k.slice(5)]) : r[k] === v));
      if (q.gt) out = out.filter((r) => new Date(r[q.gt[0]]) > new Date(q.gt[1]));
      return Promise.resolve({ data: out, error: null }).then(res, rej);
    },
  };
  return api;
}

const channels = [
  { id: 'c1', server_id: 's1', name: 'general', type: 'text', position: 0, parent_id: null, topic: null },
];
const profilesTbl = [
  { id: 'me', username: 'me', display_name: 'Me' },
  { id: 'them', username: 'them', display_name: 'Them' },
];

window.db = {
  from(t) {
    if (t === 'messages') return tbl('messages', msgs);
    if (t === 'message_attachments') return tbl('att', atts);
    if (t === 'channels') return tbl('channels', channels);
    if (t === 'servers') {
      return { select: () => ({ eq: () => ({ single: async () => ({ data: { id: 's1', name: 'Test', owner_id: 'me', server_members: [{ count: 2 }] }, error: null }) }) }) };
    }
    if (t === 'profiles') {
      const api = { _id: null, select() { return api; }, eq(c, v) { api._id = v; return api; },
        single: async () => ({ data: profilesTbl.find((p) => p.id === api._id) || null, error: null }),
        in() { return api; }, order() { return api; }, limit() { return api; },
        then: (r) => Promise.resolve({ data: profilesTbl, error: null }).then(r) };
      return api;
    }
    if (t === 'message_reactions') return tbl('rx', []);
    return tbl(t, []);
  },
  channel(name) {
    const ch = {
      _name: name, _p: {}, _tracked: null,
      on(ev, opts, cb) {
        if (opts && opts.table === 'messages' && opts.event === 'INSERT') insertHandler = cb;
        if (ev === 'presence') ch._p[opts.event] = cb;
        return ch;
      },
      subscribe(cb) { setTimeout(() => cb && cb(subStatus), 5); return ch; },
      track: async (p) => { ch._tracked = p; global.__pstate[p.user_id] = [p]; ch._p.sync?.(); },
      untrack: async () => { if (ch._tracked) delete global.__pstate[ch._tracked.user_id]; ch._p.sync?.(); },
      presenceState: () => global.__pstate,
      send: async () => {},
    };
    global.__chans.push(ch);
    return ch;
  },
  removeChannel() {},
  rpc: async () => ({ data: true, error: null }),
  auth: { getSession: async () => ({ data: { session: { user: { id: 'me' } } } }), signOut: async () => {} },
};
window.__nx_tp = { put: async () => ({ url: '', type: '' }), del: async () => {}, presign: async () => '', getText: async () => '' };

for (const f of ['ui.js', 'md.js', 'viewer.js', 'presence.js']) {
  window.eval(fs.readFileSync(`${REPO}/assets/js/${f}`, 'utf8'));
}
window.Voice = { state: () => ({ active: false, members: new Map() }), leave: async () => {}, join: async () => {} };
window.Notify = { start() {} };
window.eval(fs.readFileSync(`${REPO}/assets/js/server.js`, 'utf8'));

global.__chans = []; global.__pstate = {};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rowCount = () => window.document.querySelectorAll('#msgs .m').length;
const texts = () => [...window.document.querySelectorAll('#msgs .m .m-text')].map((e) => e.textContent.trim());


(async () => {
  await sleep(400);

  const pchan = global.__chans.find((c) => c._name === 'nx-presence');
  console.log('1. joined nx-presence channel :', !!pchan);
  if (!pchan) {
    console.log('\n*** FAIL: server page never joins the presence channel ***');
    process.exit(1);
  }
  console.log('2. tracked self               :', JSON.stringify(pchan._tracked?.user_id));

  // Render a message from another user so their avatar dot is on the page.
  const t0 = Date.now();
  msgs.push({ id: 'p1', channel_id: 'c1', author_id: 'them', content: 'hi', created_at: new Date(t0).toISOString() });
  await sleep(1500);

  const dot = () => window.document.querySelector('.pdot[data-pd="them"]');
  console.log('3. dot rendered for them      :', !!dot(), dot()?.className.trim());
  const startedOff = dot() && dot().classList.contains('off');

  // They come online: presence sync fires.
  global.__pstate['them'] = [{ user_id: 'them', at: Date.now() }];
  pchan._p.join?.(); pchan._p.sync?.();
  await sleep(300);
  const wentOn = dot() && dot().classList.contains('on') && !dot().classList.contains('off');
  console.log('4. after they come ONLINE     :', dot()?.className.trim());

  // They go offline again.
  delete global.__pstate['them'];
  pchan._p.leave?.(); pchan._p.sync?.();
  await sleep(300);
  const wentOff = dot() && dot().classList.contains('off') && !dot().classList.contains('on');
  console.log('5. after they go OFFLINE      :', dot()?.className.trim());

  const ok = startedOff && wentOn && wentOff;
  console.log(ok ? '\n*** PASS: server presence dots track online/offline live ***'
                 : `\n*** FAIL startedOff=${startedOff} wentOn=${wentOn} wentOff=${wentOff} ***`);
  process.exit(ok ? 0 : 1);
})();
