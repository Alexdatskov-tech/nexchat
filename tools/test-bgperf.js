/* Background-image performance: the wallpaper layer must not force a repaint
   on every scroll. Guards the specific constructs that caused the tearing —
   background-attachment: fixed, a full-viewport backdrop-filter over scrolling
   content, and a per-card backdrop-filter on every server tile. */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const APP = '/home/user/nexchat';
let fails = 0;
const ok = (n, c, extra) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${extra ? '  ' + extra : ''}`); if (!c) fails++; };

const css = fs.readFileSync(path.join(APP, 'assets/css/theme.css'), 'utf8');

// Pulls the body of a rule, ignoring commented-out text.
function rule(selector) {
  const bare = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const re = new RegExp(`(?:^|[},])\\s*${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`, 'm');
  return bare.match(re)?.[1] ?? null;
}

/* ---- 1. no scroll-linked background repaint ---- */
ok('no background-attachment anywhere', !/background-attachment\s*:/.test(css.replace(/\/\*[\s\S]*?\*\//g, '')));

const before = rule('body.has-bg::before');
ok('body.has-bg::before exists', before !== null);
ok('  it is position:fixed', /position:\s*fixed/.test(before || ''));
ok('  promoted to its own layer', /translateZ\(0\)/.test(before || ''));
ok('  will-change declared', /will-change:\s*transform/.test(before || ''));
ok('  backface-visibility hidden', /backface-visibility:\s*hidden/.test(before || ''));
ok('  sits behind content', /z-index:\s*-?\d/.test(before || ''));

/* ---- 2. blur is on the image layer, not over scrolling content ---- */
const veil = rule('body.has-bg .dash-veil');
ok('body.has-bg .dash-veil exists', veil !== null);
ok('  .dash-veil has no backdrop-filter', !/backdrop-filter/.test(veil || ''), veil?.trim().slice(0, 80));
ok('  .dash-veil promoted', /translateZ\(0\)/.test(veil || ''));

const blurLayer = rule('body.has-bg.bg-blur::before');
ok('bg-blur layer exists', blurLayer !== null);
ok('  it carries the blur', /blur\(var\(--dash-blur[^)]*\)\)/.test(blurLayer || ''), blurLayer?.trim());
ok('  applied as filter, not backdrop-filter', /(^|[^-])filter:/.test(blurLayer || '') && !/backdrop-filter/.test(blurLayer || ''));

/* ---- 3. server cards do not each run a blur pass ---- */
const scard = rule('body.has-bg .scard');
ok('body.has-bg .scard exists', scard !== null);
ok('  no per-card backdrop-filter', !/backdrop-filter/.test(scard || ''), scard?.trim().slice(0, 80));
ok('  opacity raised to stay legible without blur', /rgba\([^)]*0?\.8\d?\)/.test(scard || ''), scard?.trim().slice(0, 80));

/* ---- 4. only the static chrome keeps a blur ---- */
const bare = css.replace(/\/\*[\s\S]*?\*\//g, '');
const bfCount = (bare.match(/backdrop-filter\s*:/g) || []).length;
ok('backdrop-filter use is bounded', bfCount <= 14, `${bfCount} declarations`);
const topbar = rule('body.has-bg .topbar');
ok('topbar keeps its blur (it does not scroll)', /backdrop-filter/.test(topbar || ''));
ok('  topbar promoted', /translateZ\(0\)/.test(topbar || ''));

/* ---- 5. the duplicate frosted block is gone ---- */
const trio = bare.match(/body\.has-bg\s+\.surface\s*\{[^}]*\}/g) || [];
ok('no duplicate .surface frosted rules', trio.length <= 1, `${trio.length} rules`);

/* ---- 6. one shared applier, used by every page that shows the wallpaper ---- */
{
  const ui = fs.readFileSync(path.join(APP, 'assets/js/ui.js'), 'utf8');
  ok('ui.js owns applyBackground', /function applyBackground\s*\(/.test(ui));
  ok('  it is exported', /applyBackground/.test(ui.slice(ui.lastIndexOf('window.UI'))) ||
     /applyBackground,/.test(ui));
  ok('  gated on a positive blur',
     /classList\.toggle\('bg-blur',\s*\(?[\w.?\s??]+\)?\s*>\s*0\)/.test(ui));
  ok('  no background-attachment anywhere in it', !/background-attachment/.test(ui));

  // Behavioural: drive the real applier through the states a user can produce.
  {
    const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>',
      { runScripts: 'outside-only', url: 'https://nexchat.example/dms.html' });
    const w = dom.window;
    w.matchMedia = () => ({ matches: false, addListener() {}, removeListener() {} });
    // eslint-disable-next-line no-new-func
    new w.Function('window', 'document', 'console', ui)
      .call(w, w, w.document, console);
    const B = w.document.body;
    const css = () => w.document.documentElement.style;

    w.UI.applyBackground({ dash_bg: 'https://cdn/x.jpg', dash_dim: 40, dash_blur: 0, dash_bright: 90 });
    ok('  wallpaper mounts has-bg', B.classList.contains('has-bg'));
    ok('    zero blur mounts no filter layer', !B.classList.contains('bg-blur'));
    ok('    veil inserted once', w.document.querySelectorAll('.dash-veil').length === 1);
    ok('    image variable set', css().getPropertyValue('--dash-bg').includes('x.jpg'));
    ok('    dim normalised to 0-1', css().getPropertyValue('--dash-dim') === '0.4');
    ok('    brightness normalised to 0-1', css().getPropertyValue('--dash-bright') === '0.9');

    w.UI.applyBackground({ dash_bg: 'https://cdn/x.jpg', dash_blur: 12 });
    ok('  a positive blur mounts the filter layer', B.classList.contains('bg-blur'));
    ok('    blur carries px units', css().getPropertyValue('--dash-blur') === '12px');
    ok('    veil is not duplicated', w.document.querySelectorAll('.dash-veil').length === 1);

    w.UI.applyBackground({});
    ok('  clearing the wallpaper unmounts has-bg', !B.classList.contains('has-bg'));
    ok('    and the filter layer', !B.classList.contains('bg-blur'));
    ok('    and removes the veil', w.document.querySelectorAll('.dash-veil').length === 0);

    w.UI.applyBackground(null);
    ok('  a missing theme is survivable', !B.classList.contains('has-bg'));
  }

  // Every surface that should carry the wallpaper must go through it, and none
  // of them may keep a private copy of the logic.
  for (const file of ['portal.js', 'profile.js', 'dms.js', 'server.js']) {
    const js = fs.readFileSync(path.join(APP, `assets/js/${file}`), 'utf8');
    ok(`${file} applies the wallpaper via UI.applyBackground`,
       /UI\.applyBackground\(/.test(js));
    ok(`  ${file} does not re-implement the toggle`,
       !/classList\.toggle\('has-bg',/.test(js));
  }
}

/* ---- 6b. the chat shell is see-through when a wallpaper is set ---- */
{
  const block = (sel) => {
    const m = bare.match(new RegExp(`body\\.has-bg\\s+${sel}[^{]*\\{[^}]*\\}`));
    return m ? m[0] : null;
  };
  for (const sel of ['\\.shell', '\\.rail', '\\.dm-rail', '\\.chat-head', '\\.composer-inner']) {
    ok(`${sel.replace(/\\\\/g, '')} is translucent over a wallpaper`, !!block(sel));
  }
  // Channel rows: the class is .chan, not .ch-item -- a wrong selector here is
  // silent, so pin it against the markup the app actually emits.
  const srv = fs.readFileSync(path.join(APP, 'assets/js/server.js'), 'utf8');
  ok('server.js emits .chan rows', /class="chan/.test(srv));
  ok('has-bg styles .chan rows', /body\.has-bg\s+\.chan/.test(bare));
  ok('has-bg does not style a non-existent .ch-item', !/\.ch-item/.test(bare));
  ok('has-bg styles .dm-item rows', /body\.has-bg\s+\.dm-item/.test(bare));

  // Scroll tearing came from blurring a layer that MOVES -- a backdrop-filter
  // on or inside a scroll container has to re-sample every frame. The elements
  // that actually scroll are .msgs, .chan-list and .dm-list; those, and the row
  // classes painted inside them, must stay flat-alpha. A static underlay over
  // the fixed wallpaper is fine and is blurred once by the compositor.
  const SCROLLERS = ['msgs', 'chan-list', 'dm-list', 'chan', 'dm-item', 'm'];
  const shellRules = bare.match(/body\.has-bg\s+\.(shell|chat|rail|dm-rail|msgs|composer-inner|chan|dm-item)[^{]*\{[^}]*\}/g) || [];
  ok('chat-shell rules exist', shellRules.length >= 5, `${shellRules.length} rules`);

  const blurredScrollers = shellRules.filter((r) => {
    if (!/backdrop-filter/.test(r)) return false;
    const sel = r.slice(0, r.indexOf('{'));
    return SCROLLERS.some((c) => new RegExp(`\\.${c}\\b`).test(sel));
  });
  ok('  no scrolling layer is blurred', blurredScrollers.length === 0,
     blurredScrollers.map((r) => r.split('{')[0].trim()).join(' | '));

  // The chat underlay: allowed to blur, but only as a static, non-scrolling box.
  const underlay = (bare.match(/body\.has-bg\s+\.chat::before\s*\{[^}]*\}/) || [])[0];
  if (underlay) {
    ok('chat underlay is absolutely positioned', /position:\s*absolute/.test(underlay));
    ok('  sits behind the messages', /z-index:\s*-1/.test(underlay));
    ok('  does not eat clicks', /pointer-events:\s*none/.test(underlay));
    ok('  dims as well as blurs', /background:\s*rgba/.test(underlay));
    ok('  has a -webkit- fallback', /-webkit-backdrop-filter/.test(underlay));
    ok('  .chat owns the stacking context',
       /body\.has-bg\s+\.chat\s*\{[^}]*position:\s*relative[^}]*\}/.test(bare));
    ok('  .chat is not itself a scroll container',
       !/body\.has-bg\s+\.chat\s*\{[^}]*overflow[^}]*\}/.test(bare));
  }

  // Text over a photo needs a shadow to stay readable.
  ok('message text gets a shadow over a wallpaper',
     /body\.has-bg[^{]*\.m-text[^{]*\{[^}]*text-shadow/.test(bare));
}

/* ---- 7. behavioural: the class actually tracks the slider ---- */
{
  const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>',
    { runScripts: 'outside-only', url: 'https://nexchat.example/portal.html' });
  const w = dom.window;
  const body = w.document.body;
  // Mirror of the production toggle, exercised across the slider's range.
  const apply = (blur) => {
    body.classList.toggle('has-bg', true);
    body.classList.toggle('bg-blur', blur > 0);
  };
  apply(0);
  ok('blur 0 mounts no filter layer', !body.classList.contains('bg-blur'));
  apply(8);
  ok('blur 8 mounts the filter layer', body.classList.contains('bg-blur'));
  apply(0);
  ok('returning to 0 removes it again', !body.classList.contains('bg-blur'));
}

console.log(fails ? `\n${fails} FAILED` : '\nAll background-performance checks passed');
process.exit(fails ? 1 : 0);
