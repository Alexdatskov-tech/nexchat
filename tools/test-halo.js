/* Nitro halo: default sweep, custom GIF ring, and dev-mode custom CSS,
   including the sanitising that keeps author-supplied CSS to declarations. */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const APP = '/home/user/nexchat';
let fails = 0;
const ok = (n, c, extra) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${extra ? '  ' + extra : ''}`); if (!c) fails++; };

const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>',
  { runScripts: 'outside-only', url: 'https://nexchat.example/portal.html' });
const w = dom.window;
w.matchMedia = () => ({ matches: false, addListener() {}, removeListener() {} });
w.eval(fs.readFileSync(path.join(APP, 'assets/js/ui.js'), 'utf8'));
const UI = w.UI;

const nitro = (extra) => ({ id: 'u1', username: 'ada', is_nitro: true, avatar_url: 'https://cdn.example/a.png', ...extra });

/* ---- exports ---- */
for (const fn of ['haloClass', 'haloStyle', 'haloStyleText', 'haloImage', 'haloCss']) {
  ok(`UI.${fn} exported`, typeof UI[fn] === 'function');
}

/* ---- tier 3: the default sweep ---- */
ok('plain nitro user gets the default halo', UI.haloClass(nitro()) === 'av-halo');
ok('default halo needs no inline style', UI.haloStyle(nitro()) === '');
ok('non-nitro user renders no halo', !/av-halo/.test(UI.avatar({ id: 'u2', username: 'bo' }, 40)));
ok('nitro user renders a halo', /class="av-halo"/.test(UI.avatar(nitro(), 40)));
ok('halo can be suppressed per call', !/av-halo/.test(UI.avatar(nitro(), 40, { halo: false })));

/* ---- tier 2: GIF ring ---- */
const GIF = 'https://cdn.example/rings/loop.gif';
ok('gif URL accepted', UI.haloImage(nitro({ banner_gif_url: GIF })) === GIF);
ok('gif adds the image class', UI.haloClass(nitro({ banner_gif_url: GIF })) === 'av-halo av-halo-img');
ok('gif exposed as a custom property',
   UI.haloStyleText(nitro({ banner_gif_url: GIF })) === `--halo-img:url('${GIF}')`);
ok('gif appears in the rendered avatar',
   /style="--halo-img:url\('https:\/\/cdn\.example\/rings\/loop\.gif'\)"/.test(UI.avatar(nitro({ banner_gif_url: GIF }), 40)));
ok('apng accepted', !!UI.haloImage(nitro({ banner_gif_url: 'https://cdn.example/r.apng' })));
ok('webp accepted', !!UI.haloImage(nitro({ banner_gif_url: 'https://cdn.example/r.webp' })));
ok('query string tolerated', !!UI.haloImage(nitro({ banner_gif_url: 'https://cdn.example/r.gif?v=2' })));
for (const bad of ['javascript:alert(1)', 'data:image/gif;base64,AAA', 'https://cdn.example/script.js',
                   'https://cdn.example/nope', '   ', '']) {
  ok(`rejects halo image ${JSON.stringify(bad)}`, UI.haloImage(nitro({ banner_gif_url: bad })) === null);
}
ok('a rejected image falls back to the default halo',
   UI.haloClass(nitro({ banner_gif_url: 'javascript:alert(1)' })) === 'av-halo');

/* ---- tier 1: dev-mode custom CSS ---- */
const CSS_OK = 'background: linear-gradient(90deg,#f0f,#0ff); animation: spin 2s linear infinite';
ok('custom css ignored without dev mode',
   UI.haloCss(nitro({ theme: { dev_mode: false, halo_css: CSS_OK } })) === null);
ok('custom css honoured in dev mode',
   UI.haloCss(nitro({ theme: { dev_mode: true, halo_css: CSS_OK } })) === CSS_OK);
const customCls = UI.haloClass(nitro({ theme: { dev_mode: true, halo_css: CSS_OK } }));
ok('custom css sets its own class', /^av-halo av-halo-custom av-halo-c[0-9a-z]+$/.test(customCls), customCls);
ok('custom css wins over a gif',
   UI.haloClass(nitro({ banner_gif_url: GIF, theme: { dev_mode: true, halo_css: CSS_OK } })) === customCls);
ok('the same css reuses one key',
   UI.haloClass(nitro({ id: 'other', theme: { dev_mode: true, halo_css: CSS_OK } })) === customCls);
ok('different css gets a different key',
   UI.haloClass(nitro({ theme: { dev_mode: true, halo_css: 'background:red' } })) !== customCls);

/* custom CSS must reach the ring pseudo-element, not the wrapper */
const sheet = w.document.getElementById('nx-halo-styles');
ok('a halo stylesheet is created', !!sheet);
ok('the rule targets ::before', sheet && sheet.textContent.includes(`.${customCls.split(' ').pop()}::before{`));
ok('the rule carries the declarations', sheet && sheet.textContent.includes(CSS_OK));
ok('custom css is not emitted inline',
   UI.haloStyleText(nitro({ theme: { dev_mode: true, halo_css: CSS_OK } })) === '');

/* the sheet is recycled rather than growing per keystroke */
for (let i = 0; i < 200; i++) UI.haloClass(nitro({ theme: { dev_mode: true, halo_css: 'opacity:0.' + i } }));
ok('halo stylesheet stays bounded',
   w.document.getElementById('nx-halo-styles').childNodes.length <= 64,
   'rules=' + w.document.getElementById('nx-halo-styles').childNodes.length);
ok('custom css reaches the rendered markup',
   /av-halo-custom/.test(UI.avatar(nitro({ theme: { dev_mode: true, halo_css: CSS_OK } }), 40)));

for (const bad of [
  'background:red} body{display:none',       // escapes the declaration list
  '} .av { display:none } .x {',             // selector injection
  'background:url(https://evil.example/x)',  // url() payload
  'background:URL(x)',                       // case-shifted url()
  '@import url(x)',
  'behavior: url(x.htc)',
  'background:expression(alert(1))',
  'background:red; </style><script>alert(1)</script>',
  'a'.repeat(401),                           // over the length cap
]) {
  ok(`rejects halo css ${JSON.stringify(bad.slice(0, 42))}`,
     UI.haloCss(nitro({ theme: { dev_mode: true, halo_css: bad } })) === null);
}
ok('quotes in custom css are escaped in the attribute',
   !/style="[^"]*"[^>]*"/.test(UI.avatar(nitro({ theme: { dev_mode: true, halo_css: 'content:"x"' } }), 40)));

/* ---- user popover uses the same tiers ---- */
const ui = fs.readFileSync(path.join(APP, 'assets/js/ui.js'), 'utf8');
ok('popover avatar uses haloClass', /upop-av \$\{p\.is_nitro \? haloClass\(p\)/.test(ui));
ok('popover avatar uses haloStyle', /haloStyle\(p\)/.test(ui));

/* ---- profile page wiring ---- */
const prof = fs.readFileSync(path.join(APP, 'assets/js/profile.js'), 'utf8');
ok('profile preview uses haloClass', /UI\.haloClass\(haloPreview\)/.test(prof));
ok('profile preview uses haloStyleText', /UI\.haloStyleText\(haloPreview\)/.test(prof));
ok('preview reads the live gif field', /banner_gif_url: \$\('fHalo'\)/.test(prof));
ok('preview reads the live css field', /halo_css: \$\('fHaloCss'\)/.test(prof));
ok('halo fields repaint on input', /\$\('fHaloCss'\)\.oninput = \(\) => paint\(\);/.test(prof));
ok('css field gated on dev mode + nitro', /devMode && me\?\.is_nitro/.test(prof));
ok('save validates the css', /UI\.haloCss\(\{ theme: \{ dev_mode: true, halo_css: hc \} \}\)/.test(prof));
ok('save persists halo_css', /patch\.theme\.halo_css = hc \|\| null;/.test(prof));
ok('hydrate restores halo_css', /\$\('fHaloCss'\)\.value = th\.halo_css \|\| ''/.test(prof));
ok('dev toggle re-syncs the field', /syncHaloCssField\(\);\n\s*paint\(\);/.test(prof));

const html = fs.readFileSync(path.join(APP, 'profile.html'), 'utf8');
ok('profile.html has the css field', /id="haloCssField"/.test(html));
ok('css field starts hidden', /id="haloCssField"[^>]*class="field hidden"|class="field hidden" id="haloCssField"/.test(html));
ok('profile.html has the textarea', /id="fHaloCss"/.test(html));

/* ---- styles ---- */
const css = fs.readFileSync(path.join(APP, 'assets/css/theme.css'), 'utf8');
ok('.av-halo-img styled', /\.av-halo-img::before\s*\{/.test(css));
ok('  gif ring uses the custom property', /background:\s*var\(--halo-img\)/.test(css));
ok('  gif ring drops the gradient spin', /\.av-halo-img::before\s*\{[^}]*animation:\s*none/.test(css));
ok('.av-halo-custom styled', /\.av-halo-custom::before\s*\{/.test(css));
ok('reduced motion respected', /prefers-reduced-motion[\s\S]{0,120}\.av-halo::before\s*\{\s*animation:\s*none/.test(css));

console.log(fails ? `\n${fails} FAILED` : '\nAll halo checks passed');
process.exit(fails ? 1 : 0);
