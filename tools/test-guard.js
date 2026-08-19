/* Ban enforcement on a live session: the overlay must appear from a realtime
   UPDATE, from the poll when realtime is silent, and immediately at page load
   for an account that is already banned. */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const APP = '/home/user/nexchat';
const MODE = process.env.SOCKET || 'live';   // live | silent
let fails = 0;
const ok = (n, c, extra) => { console.log(`${c ? 'PASS' : 'FAIL'}  [${MODE}] ${n}${extra ? '  ' + extra : ''}`); if (!c) fails++; };
const tick = (ms) => new Promise((r) => setTimeout(r, ms));

function harness({ banned = false, reason = null } = {}) {
  const dom = new JSDOM(
    '<!doctype html><html><head></head><body><audio id="a"></audio><video id="v"></video></body></html>',
    { runScripts: 'outside-only', url: 'https://nexchat.example/portal.html' });
  const w = dom.window;
  w.matchMedia = () => ({ matches: false, addListener() {}, removeListener() {} });

  const state = { banned, reason, signedOut: false, removed: [], handlers: [], subscribed: false,
                  selects: 0, paused: [], inserts: [], insertError: null };
  w.HTMLMediaElement.prototype.pause = function () { state.paused.push(this.id); };

  const chan = {
    on(_evt, _opts, cb) { state.handlers.push(cb); return chan; },
    subscribe(cb) { state.subscribed = true; cb?.('SUBSCRIBED'); return chan; },
    track() {}, untrack() {}, presenceState() { return {}; }, send() {},
  };
  w.db = {
    channel: () => chan,
    removeChannel: (c) => state.removed.push(c),
    auth: { signOut: async () => { state.signedOut = true; } },
    from: (table) => ({
      select: () => ({
        eq: () => ({
          single: async () => {
            state.selects++;
            return { data: { is_banned: state.banned, ban_reason: state.reason }, error: null };
          },
        }),
      }),
      insert: async (row) => {
        state.inserts.push({ table, row });
        return { error: state.insertError };
      },
    }),
  };
  // jsdom refuses to let window.location be replaced, so guard.js is evaluated
  // against a proxy that swaps in a recording location object.
  const nav = [];
  const fakeLoc = { replace: (u) => nav.push(u), assign: (u) => nav.push(u), href: 'portal.html', search: '' };
  const proxy = new Proxy(w, {
    get: (t, p) => (p === 'location' ? fakeLoc : t[p]),
    set: (t, p, v) => { t[p] = v; return true; },
    has: (t, p) => p in t,
  });
  const src = fs.readFileSync(path.join(APP, 'assets/js/guard.js'), 'utf8');
  // eslint-disable-next-line no-new-func
  new w.Function('window', 'document', 'console', 'setTimeout', 'setInterval', 'clearInterval', src)
    .call(proxy, proxy, w.document, console, w.setTimeout.bind(w), w.setInterval.bind(w), w.clearInterval.bind(w));
  return { w, state, nav, chan };
}

(async () => {
  /* ---- 1. clean session stays usable ---- */
  {
    const { w, state } = harness();
    w.Guard.start({ id: 'u1', is_banned: false });
    await tick(30);
    ok('clean session is not locked', w.Guard.locked === false);
    ok('no overlay for a clean session', !w.document.querySelector('.ban-screen'));
    ok('body not marked banned', !w.document.body.classList.contains('is-banned'));
    ok('guard subscribed to realtime', state.subscribed);
    ok('guard did an initial check', state.selects >= 1, `${state.selects} selects`);
  }

  /* ---- 2. already banned at page load ---- */
  {
    const { w } = harness();
    w.Guard.start({ id: 'u1', is_banned: true, ban_reason: 'Spamming invite links' });
    await tick(30);
    ok('page-load ban locks immediately', w.Guard.locked === true);
    const ov = w.document.querySelector('.ban-screen');
    ok('overlay present at load', !!ov);
    ok('overlay is an alertdialog', ov?.getAttribute('role') === 'alertdialog');
    ok('overlay is modal', ov?.getAttribute('aria-modal') === 'true');
    ok('body marked banned', w.document.body.classList.contains('is-banned'));
    ok('reason shown', /Spamming invite links/.test(ov?.textContent || ''));
    ok('title present', /ACCOUNT BANNED/.test(ov?.querySelector('.ban-title')?.textContent || ''));
    ok('sign-out button present', !!ov?.querySelector('#banOut'));
  }

  /* ---- 3. ban lands mid-session ---- */
  {
    const { w, state } = harness();
    w.Guard.start({ id: 'u1', is_banned: false });
    await tick(30);
    ok('not locked before the ban', w.Guard.locked === false);

    if (MODE === 'live') {
      // Realtime delivers the UPDATE.
      state.handlers.forEach((h) => h({ new: { is_banned: true, ban_reason: 'Harassment' } }));
    } else {
      // Realtime stays silent; only the poll can notice.
      state.banned = true; state.reason = 'Harassment';
      await w.Guard.check();
    }
    await tick(30);

    ok('locks when the ban lands', w.Guard.locked === true);
    const ov = w.document.querySelector('.ban-screen');
    ok('overlay injected mid-session', !!ov);
    ok('reason rendered', /Harassment/.test(ov?.textContent || ''));
    ok('media paused', state.paused.length === 2, state.paused.join(','));
    ok('guard channel torn down', state.removed.length === 1);

    // Locking twice must not stack overlays.
    state.handlers.forEach((h) => h({ new: { is_banned: true, ban_reason: 'Harassment' } }));
    await w.Guard.check();
    await tick(20);
    ok('overlay is not duplicated', w.document.querySelectorAll('.ban-screen').length === 1);
  }

  /* ---- 4. an unrelated profile update must not lock ---- */
  {
    const { w, state } = harness();
    w.Guard.start({ id: 'u1', is_banned: false });
    await tick(20);
    state.handlers.forEach((h) => h({ new: { is_banned: false, display_name: 'new name' } }));
    await tick(20);
    ok('a non-ban update does not lock', w.Guard.locked === false);
    ok('no overlay from a non-ban update', !w.document.querySelector('.ban-screen'));
  }

  /* ---- 5. sign-out path ---- */
  {
    const { w, state, nav } = harness();
    w.Guard.start({ id: 'u1', is_banned: true, ban_reason: 'Ban evasion' });
    await tick(30);
    const btn = w.document.querySelector('#banOut');
    btn.onclick();
    await tick(40);
    ok('sign out called', state.signedOut === true);
    ok('redirected to the login page', nav[0] === 'index.html', nav.join(','));
    ok('button disabled while signing out', btn.disabled === true);
  }

  /* ---- 6. no reason supplied ---- */
  {
    const { w } = harness();
    w.Guard.start({ id: 'u1', is_banned: true, ban_reason: null });
    await tick(30);
    const ov = w.document.querySelector('.ban-screen');
    ok('overlay renders without a reason', !!ov);
    ok('reason block omitted', !ov.querySelector('.ban-reason'));
  }

  /* ---- 7. reason is escaped, not injected ---- */
  {
    const { w } = harness();
    w.Guard.start({ id: 'u1', is_banned: true, ban_reason: '<img src=x onerror="alert(1)">' });
    await tick(30);
    const ov = w.document.querySelector('.ban-screen');
    ok('injected markup did not become an element', !ov.querySelector('img'));
    ok('reason shown as literal text', /<img src=x/.test(ov.querySelector('.ban-reason p').textContent));
  }

  /* ---- 8. start() is idempotent ---- */
  {
    const { w, state } = harness();
    w.Guard.start({ id: 'u1', is_banned: false });
    const first = state.handlers.length;
    w.Guard.start({ id: 'u1', is_banned: false });
    await tick(20);
    ok('second start() is ignored', state.handlers.length === first);
  }

  /* ---- 9. wiring across the signed-in pages ---- */
  const PAGES = ['portal', 'profile', 'admin', 'server', 'dms', 'server-settings'];
  for (const p of PAGES) {
    const html = fs.readFileSync(path.join(APP, `${p}.html`), 'utf8');
    ok(`${p}.html loads guard.js`, /assets\/js\/guard\.js\?v=\d+/.test(html));
    const js = fs.readFileSync(path.join(APP, `assets/js/${p}.js`), 'utf8');
    ok(`${p}.js starts the guard`, /window\.Guard\?\.start\(me\);/.test(js));
  }

  /* ---- 10. appealing a ban ---- */
  {
    const { w, state } = harness();
    w.Guard.start({ id: 'u7', is_banned: true, ban_reason: 'Spam' });
    await tick(30);
    const ov = w.document.querySelector('.ban-screen');

    ok('appeal button offered', !!ov.querySelector('#banAppeal'));
    ok('appeal form starts hidden', ov.querySelector('#banForm').classList.contains('hidden'));

    ov.querySelector('#banAppeal').onclick();
    await tick(20);
    ok('appeal form opens', !ov.querySelector('#banForm').classList.contains('hidden'));
    ok('button becomes a cancel', /Cancel/.test(ov.querySelector('#banAppeal').textContent));

    // Too short -- must not reach the database.
    const form = ov.querySelector('#banForm');
    ov.querySelector('#banMsg').value = 'nope';
    await form.onsubmit({ preventDefault() {} });
    await tick(20);
    ok('a too-short appeal is refused', state.inserts.length === 0);
    ok('  and says why', /at least a sentence/i.test(ov.querySelector('#banNote').textContent));

    // A real appeal.
    ov.querySelector('#banMsg').value = 'I believe this ban was a mistake, please review it.';
    await form.onsubmit({ preventDefault() {} });
    await tick(30);
    ok('appeal inserted', state.inserts.length === 1);
    ok('  into ban_appeals', state.inserts[0]?.table === 'ban_appeals');
    ok('  attributed to the user', state.inserts[0]?.row.user_id === 'u7');
    ok('  carrying the message', /this ban was a mistake/.test(state.inserts[0]?.row.message || ''));
    ok('confirmation replaces the form', /Appeal submitted/.test(ov.querySelector('.ban-appeal').textContent));
    ok('appeal button removed once filed', !ov.querySelector('#banAppeal'));
  }

  /* ---- 11. a duplicate appeal is reported, not swallowed ---- */
  {
    const { w, state } = harness();
    w.Guard.start({ id: 'u8', is_banned: true, ban_reason: 'Spam' });
    await tick(30);
    const ov = w.document.querySelector('.ban-screen');
    state.insertError = { message: 'duplicate key value violates unique constraint' };
    ov.querySelector('#banAppeal').onclick();
    ov.querySelector('#banMsg').value = 'Please have another look at this, it was not me.';
    await ov.querySelector('#banForm').onsubmit({ preventDefault() {} });
    await tick(30);
    ok('duplicate appeal explained plainly',
       /already have an appeal/i.test(ov.querySelector('#banNote').textContent));
    ok('  and the button is re-enabled', ov.querySelector('#banSend').disabled === false);
  }

  /* ---- 12. the sign-in page shows the same card ---- */
  {
    const auth = fs.readFileSync(path.join(APP, 'assets/js/auth.js'), 'utf8');
    ok('sign-in uses the ban screen', /window\.Guard\.screen\(/.test(auth));
    ok('  passing the reason', /reason: p\.ban_reason/.test(auth));
    ok('  passing the user id so appeals work', /userId: data\.user\.id/.test(auth));
    ok('  no longer just an error string', !/setErr\('errIn', 'This account is banned/.test(auth));
    ok('  signs out on dismiss', /auth\.signOut\(\)/.test(auth));
    const idx = fs.readFileSync(path.join(APP, 'index.html'), 'utf8');
    ok('index.html loads guard.js', /assets\/js\/guard\.js\?v=\d+/.test(idx));
    ok('  before auth.js',
       idx.indexOf('guard.js') < idx.indexOf('auth.js'));
  }

  /* ---- 13. screen() works with no session at all ---- */
  {
    const { w } = harness();
    let exited = false;
    w.Guard.screen({ reason: 'Nope', exitText: 'Back to sign in', onExit: () => { exited = true; } });
    const ov = w.document.querySelector('.ban-screen');
    ok('screen() renders without start()', !!ov);
    ok('  no appeal form without a user id', !ov.querySelector('#banForm'));
    ok('  custom button label used', /Back to sign in/.test(ov.querySelector('#banOut').textContent));
    ov.querySelector('#banOut').onclick();
    await tick(20);
    ok('  custom exit handler runs', exited === true);
  }

  /* ---- 14. admin review surface ---- */
  {
    const adminJs = fs.readFileSync(path.join(APP, 'assets/js/admin.js'), 'utf8');
    const adminHtml = fs.readFileSync(path.join(APP, 'admin.html'), 'utf8');
    ok('admin has an appeals pane', /data-pane="appeals"/.test(adminHtml));
    ok('admin has an appeals tab', /data-tab="appeals"/.test(adminHtml));
    ok('admin loads appeals', /from\('ban_appeals'\)/.test(adminJs));
    ok('admin resolves via the rpc', /rpc\('resolve_ban_appeal'/.test(adminJs));
    ok('appeal text is escaped', /UI\.esc\(a\.message\)/.test(adminJs));
  }

  /* ---- 15. the migration is present ---- */
  {
    const sql = fs.readFileSync(path.join(APP, 'nexchat_patch6.sql'), 'utf8');
    ok('patch6 creates ban_appeals', /create table if not exists public\.ban_appeals/.test(sql));
    ok('patch6 enables RLS on it', /alter table public\.ban_appeals enable row level security/.test(sql));
    ok('patch6 limits one pending appeal', /unique index[\s\S]{0,120}where status = 'pending'/.test(sql));
    ok('patch6 publishes profiles to realtime', /add table public\.profiles/.test(sql));
    ok('patch6 sets replica identity on profiles', /alter table public\.profiles replica identity full/.test(sql));
    ok('patch6 lets a user read their own row', /profiles_select_self/.test(sql));
    ok('patch6 unbans on acceptance', /set is_banned = false/.test(sql));
  }

  /* ---- 16. ban screen styling exists ---- */
  const css = fs.readFileSync(path.join(APP, 'assets/css/theme.css'), 'utf8');
  for (const sel of ['.ban-screen', '.ban-card', '.ban-title', '.ban-reason', '.ban-btn', '.is-banned',
                     '.ban-appeal', '.ban-acts', '.ban-btn-quiet', '.appeal-msg']) {
    ok(`${sel} styled`, new RegExp(sel.replace('.', '\\.')).test(css));
  }
  ok('ban screen sits above everything', /\.ban-screen[\s\S]{0,400}z-index:\s*\d{4,}/.test(css));

  console.log(fails ? `\n${fails} FAILED` : '\nAll guard checks passed');
  process.exit(fails ? 1 : 0);
})();
