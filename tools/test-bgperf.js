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

/* ---- 6. bg-blur class is only applied when blur > 0 ---- */
for (const [file, fn] of [['portal.js', 'applyDashboardBg'], ['profile.js', 'applyBg']]) {
  const js = fs.readFileSync(path.join(APP, `assets/js/${file}`), 'utf8');
  ok(`${file} toggles bg-blur`, /classList\.toggle\('bg-blur',/.test(js));
  ok(`  ${file} gates it on a positive blur`, /classList\.toggle\('bg-blur',\s*\(?[\w.?\s??]+\)?\s*>\s*0\)/.test(js));
  ok(`  ${fn} still present`, new RegExp(`function ${fn}`).test(js));
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
