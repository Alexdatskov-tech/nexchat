/* The halo example chips in the profile editor hand users CSS to copy, so each
   one must survive UI.haloCss's sanitiser and parse as real CSS -- otherwise a
   chip would offer a snippet that is rejected the moment it is saved. Also
   re-checks that the sanitiser still blocks what it is meant to. */
const fs = require('fs');
const { JSDOM } = require('jsdom');

const APP = '/home/user/nexchat';
let fails = 0;
const ok = (n, c, extra) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${extra ? '  ' + extra : ''}`); if (!c) fails++; };

const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', { runScripts: 'outside-only' });
const w = dom.window;
global.window = w; global.document = w.document;
w.eval(fs.readFileSync(`${APP}/assets/js/ui.js`, 'utf8'));

const src = fs.readFileSync(`${APP}/assets/js/profile.js`, 'utf8');
const block = (src.match(/const HALO_EGS = \[([\s\S]*?)\n {2}\];/) || [])[1] || '';
const egs = [...block.matchAll(/\{ n: '([^']+)',\s*css: '([^']+)' \}/g)].map((m) => ({ n: m[1], css: m[2] }));

ok('halo examples found', egs.length >= 4, `${egs.length} examples`);

for (const eg of egs) {
  const passes = !!w.UI.haloCss({ theme: { dev_mode: true, halo_css: eg.css } });
  ok(`${eg.n}: allowed by the sanitiser`, passes);

  // Every declaration must actually parse -- a typo'd property silently vanishes.
  const probe = w.document.createElement('div');
  probe.style.cssText = eg.css;
  const declared = eg.css.split(';').map((d) => d.split(':')[0].trim()).filter(Boolean);
  const dropped = declared.filter((prop) => probe.style.getPropertyValue(prop) === '');
  ok(`  ${eg.n}: all ${declared.length} declarations parse`, dropped.length === 0, dropped.join(','));

  // Only animations theme.css actually defines can be referenced: custom halo
  // CSS cannot carry @keyframes, since braces are rejected.
  const anim = /animation:\s*([a-zA-Z-]+)/.exec(eg.css);
  if (anim) {
    const css = fs.readFileSync(`${APP}/assets/css/theme.css`, 'utf8');
    ok(`  ${eg.n}: @keyframes ${anim[1]} exists`,
       new RegExp(`@keyframes\\s+${anim[1]}\\b`).test(css));
  }
}

/* ---- the sanitiser must still reject the dangerous shapes ---- */
const evil = [
  ["url() payload", "background: url('//evil/a.png')"],
  ['selector escape', 'color: red } body { display: none'],
  ['@import', '@import url(x)'],
  ['behavior', 'behavior: url(#x)'],
  ['over length', 'color: red;'.repeat(60)],
];
for (const [name, css] of evil) {
  ok(`blocked: ${name}`, !w.UI.haloCss({ theme: { dev_mode: true, halo_css: css } }));
}
ok('blocked when dev mode is off',
   !w.UI.haloCss({ theme: { dev_mode: false, halo_css: 'background: red;' } }));

console.log(fails ? `\n${fails} FAILED` : '\nAll halo-example checks passed');
process.exit(fails ? 1 : 0);
