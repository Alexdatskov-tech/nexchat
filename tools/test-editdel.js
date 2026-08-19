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
const rxRows = [];    // message_reactions
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
    delete() {
      const d = { _f: {}, eq(c, v) { d._f[c] = v; return d; },
        then(res, rej) {
          for (let i = store.length - 1; i >= 0; i--) {
            if (Object.entries(d._f).every(([k, v]) => store[i][k] === v)) store.splice(i, 1);
          }
          return Promise.resolve({ error: null }).then(res, rej);
        } };
      return d;
    },
    update(patch) {
      const u = { _f: {}, eq(c, v) { u._f[c] = v; return u; },
        then(res, rej) {
          store.forEach((r) => {
            if (Object.entries(u._f).every(([k, v]) => r[k] === v)) Object.assign(r, patch);
          });
          return Promise.resolve({ error: null }).then(res, rej);
        } };
      return u;
    },
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
    if (t === 'message_reactions') return tbl('rx', rxRows);
    return tbl(t, []);
  },
  channel() {
    const ch = {
      on(_e, opts, cb) { if (opts && opts.table === 'messages' && opts.event === 'INSERT') insertHandler = cb; return ch; },
      subscribe(cb) { setTimeout(() => cb && cb(subStatus), 5); return ch; },
      track: async () => {}, untrack: async () => {}, presenceState: () => ({}), send: async () => {},
    };
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
window.eval(fs.readFileSync(`${REPO}/assets/js/emoji-data.js`, 'utf8'));
window.eval(fs.readFileSync(`${REPO}/assets/js/emoji-picker.js`, 'utf8'));
window.eval(fs.readFileSync(`${REPO}/assets/js/server.js`, 'utf8'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rowCount = () => window.document.querySelectorAll('#msgs .m').length;
const texts = () => [...window.document.querySelectorAll('#msgs .m .m-text')].map((e) => e.textContent.trim());

(async () => {
  await sleep(300);
  console.log(`socket=${subStatus} (SILENT=${SILENT})`);

  // two messages from the other person
  const t0 = Date.now();
  msgs.push({ id: 'x1', channel_id: 'c1', author_id: 'them', content: 'first message', created_at: new Date(t0).toISOString() });
  msgs.push({ id: 'x2', channel_id: 'c1', author_id: 'them', content: 'second message', created_at: new Date(t0+1000).toISOString() });
  await sleep(2000);
  const shown = () => [...window.document.querySelectorAll('#msgs .m[data-id]')].map(el=>el.dataset.id);
  const textOf = (id) => window.document.querySelector(`.m[data-id="${id}"] .m-text`)?.textContent.trim();
  console.log('1. both rendered      :', shown());

  // --- THEY EDIT a message directly in the DB (no realtime event) ---
  const m1 = msgs.find(m=>m.id==='x1');
  m1.content = 'first message EDITED';
  m1.edited_at = new Date().toISOString();
  await sleep(2500);
  console.log('2. after their EDIT   :', JSON.stringify(textOf('x1')));
  const sawEdit = (textOf('x1')||'').includes('EDITED');
  const sawTag  = !!window.document.querySelector('.m[data-id="x1"] .m-edited');

  // --- THEY DELETE the other message ---
  const i = msgs.findIndex(m=>m.id==='x2');
  msgs.splice(i,1);
  await sleep(2500);
  console.log('3. after their DELETE :', shown());
  const sawDelete = !shown().includes('x2');

  // --- an edit must NOT clobber a message I am actively editing ---
  const el = window.document.querySelector('.m[data-id="x1"]');
  const box = window.document.createElement('div');
  box.className = 'editbox';
  el.querySelector('.m-main').appendChild(box);
  m1.content = 'changed while I type';
  await sleep(2000);
  const preserved = !!el.querySelector('.editbox');
  console.log('4. my open editor kept:', preserved);
  box.remove();

  const ok = sawEdit && sawTag && sawDelete && preserved;
  console.log(ok ? '\n*** PASS: edits and deletes sync live ***'
                 : `\n*** FAIL edit=${sawEdit} tag=${sawTag} del=${sawDelete} preserved=${preserved} ***`);
  process.exit(ok ? 0 : 1);
})();
