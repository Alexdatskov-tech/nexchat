/* Custom server-name fonts: Google Fonts URL validation, @font-face injection
   for uploaded faces, and the server-settings wiring that saves them. */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const APP = '/home/user/nexchat';
let fails = 0;
const ok = (n, c, extra) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${extra ? '  ' + extra : ''}`); if (!c) fails++; };

const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>',
  { runScripts: 'outside-only', url: 'https://nexchat.example/server-settings.html' });
const w = dom.window;
w.matchMedia = () => ({ matches: false, addListener() {}, removeListener() {} });
w.eval(fs.readFileSync(path.join(APP, 'assets/js/ui.js'), 'utf8'));
const UI = w.UI;

ok('UI.resolveNameFont exported', typeof UI.resolveNameFont === 'function');
ok('UI.googleFontHref exported', typeof UI.googleFontHref === 'function');

/* ---- URL validation: only Google's font hosts, only https ---- */
const GOOD = 'https://fonts.googleapis.com/css2?family=Rubik+Glitch&display=swap';
ok('accepts a fonts.googleapis.com css2 URL', UI.googleFontHref(GOOD) === GOOD);
ok('accepts fonts.gstatic.com', !!UI.googleFontHref('https://fonts.gstatic.com/s/rubik/v1/x.woff2'));
ok('trims surrounding whitespace', UI.googleFontHref(`  ${GOOD}  `) === GOOD);
for (const bad of [
  'http://fonts.googleapis.com/css2?family=Rubik',      // not https
  'https://evil.example/css2?family=Rubik',             // wrong host
  'https://fonts.googleapis.com.evil.example/css2',     // lookalike host
  'javascript:alert(1)',
  '/relative/path.css',
  '',
  null,
]) {
  ok(`rejects ${JSON.stringify(bad)}`, UI.googleFontHref(bad) === null);
}

/* ---- family extraction ---- */
ok('reads the family name', UI.googleFontFamily(GOOD) === 'Rubik Glitch');
ok('strips axis/weight spec',
   UI.googleFontFamily('https://fonts.googleapis.com/css2?family=Inter:wght@400;700&display=swap') === 'Inter');
ok('null when no family param', UI.googleFontFamily('https://fonts.googleapis.com/css2?display=swap') === null);

/* ---- built-in keys still work ---- */
ok('display stack unchanged', UI.resolveNameFont({ name_font: 'display' }) === UI.NAME_FONTS.display.stack);
ok('unknown key falls back to display', UI.resolveNameFont({ name_font: 'nope' }) === UI.NAME_FONTS.display.stack);
ok('empty theme falls back to display', UI.resolveNameFont(undefined) === UI.NAME_FONTS.display.stack);
ok('mono key honoured', UI.resolveNameFont({ name_font: 'mono' }) === UI.NAME_FONTS.mono.stack);

/* ---- google source injects exactly one <link> and returns the family ---- */
const before = w.document.querySelectorAll('link[rel=stylesheet]').length;
const gstack = UI.resolveNameFont({ name_font: 'google', name_font_url: GOOD });
ok('google stack names the family', /^'Rubik Glitch',/.test(gstack), gstack);
const links = [...w.document.querySelectorAll('link[rel=stylesheet]')];
ok('one stylesheet link injected', links.length === before + 1);
ok('link points at the given URL', links[links.length - 1]?.href === GOOD);
UI.resolveNameFont({ name_font: 'google', name_font_url: GOOD });
UI.resolveNameFont({ name_font: 'google', name_font_url: GOOD });
ok('repeat calls do not duplicate the link',
   w.document.querySelectorAll('link[rel=stylesheet]').length === before + 1);
ok('google source with a bad URL falls back',
   UI.resolveNameFont({ name_font: 'google', name_font_url: 'https://evil.example/f.css' }) === UI.NAME_FONTS.display.stack);
ok('google source with no URL falls back',
   UI.resolveNameFont({ name_font: 'google' }) === UI.NAME_FONTS.display.stack);

/* ---- uploaded faces get an @font-face with the right format ---- */
const U1 = 'https://cdn.example/fonts/a.woff2';
const st1 = UI.resolveNameFont({ name_font: 'upload', name_font_file: U1 });
const css1 = [...w.document.querySelectorAll('style')].map((s) => s.textContent).join('\n');
ok('upload stack names a generated family', /^'NexFont\w+',/.test(st1), st1);
ok('@font-face injected', /@font-face/.test(css1));
ok('src points at the file', css1.includes(U1));
ok("format('woff2') declared", /format\('woff2'\)/.test(css1));
ok('font-display swap set', /font-display:\s*swap/.test(css1));

const U2 = 'https://cdn.example/fonts/b.ttf';
const st2 = UI.resolveNameFont({ name_font: 'upload', name_font_file: U2 });
const css2 = [...w.document.querySelectorAll('style')].map((s) => s.textContent).join('\n');
ok("ttf maps to format('truetype')", /format\('truetype'\)/.test(css2));
ok('two different files get two different families', st1.split(',')[0] !== st2.split(',')[0], `${st1.split(',')[0]} vs ${st2.split(',')[0]}`);
ok('same file resolves to the same family',
   UI.resolveNameFont({ name_font: 'upload', name_font_file: U1 }).split(',')[0] === st1.split(',')[0]);
const faceCount = [...w.document.querySelectorAll('style')].filter((s) => s.textContent.includes(U1)).length;
ok('repeat calls do not duplicate @font-face', faceCount === 1, `${faceCount} rules`);
ok('upload with no file falls back',
   UI.resolveNameFont({ name_font: 'upload' }) === UI.NAME_FONTS.display.stack);
ok('non-http font URL rejected',
   UI.resolveNameFont({ name_font: 'upload', name_font_file: 'javascript:alert(1)' }) === UI.NAME_FONTS.display.stack);

/* ---- applyServerName writes both custom properties ---- */
UI.applyServerName({ name_color: '#3B9EF5', name_font: 'google', name_font_url: GOOD });
const rootStyle = w.document.documentElement.style;
ok('applyServerName sets the colour', rootStyle.getPropertyValue('--srv-name-color') === '#3B9EF5');
ok('applyServerName sets a google font', /Rubik Glitch/.test(rootStyle.getPropertyValue('--srv-name-font')));
UI.applyServerName({ name_color: 'red; background:url(x)', name_font: 'display' });
ok('rejects a non-hex colour', rootStyle.getPropertyValue('--srv-name-color') === '#FFFFFF');

/* ---- server-settings wiring ---- */
const ss = fs.readFileSync(path.join(APP, 'assets/js/server-settings.js'), 'utf8');
ok('font select offers a Google option', /value="google"/.test(ss));
ok('font select offers an Upload option', /value="upload"/.test(ss));
ok('google panel toggles with the selection', /sFontGoogle'\)\.classList\.toggle\('hidden', nameFont !== 'google'\)/.test(ss));
ok('upload panel toggles with the selection', /sFontUpload'\)\.classList\.toggle\('hidden', nameFont !== 'upload'\)/.test(ss));
ok('URL input is debounced', /clearTimeout\(urlT\)/.test(ss));
ok('URL input validated through UI.googleFontHref', /UI\.googleFontHref\(/.test(ss));
ok('font file extension checked', /\\\.\(woff2\?\|ttf\|otf\)\$/.test(ss));
ok('font file size capped at 3 MB', /3 \* 1024 \* 1024/.test(ss));
ok('save uploads the pending font file', /fontFileUrl = await UI\.upload\(/.test(ss));
ok('save persists name_font_url', /name_font_url = fontUrl \|\| null/.test(ss));
ok('save persists name_font_file', /name_font_file = fontFileUrl \|\| null/.test(ss));
ok('save refuses google with no URL', /nameFont === 'google' && !fontUrl/.test(ss));
ok('save refuses upload with no file', /nameFont === 'upload' && !fontFile && !fontFileUrl/.test(ss));
ok('hydrate restores the saved URL', /fontUrl = UI\.googleFontHref\(srv\.theme\?\.name_font_url/.test(ss));
ok('reset clears both custom sources', /fontUrl = ''; fontFileUrl = ''; fontFile = null;/.test(ss));

/* ---- portal cards resolve custom fonts too ---- */
const portal = fs.readFileSync(path.join(APP, 'assets/js/portal.js'), 'utf8');
ok('portal cards use resolveNameFont', /UI\.resolveNameFont\(theme\)/.test(portal));
ok('portal no longer uses the plain stack helper', !/UI\.nameFontStack\(theme/.test(portal));

/* ---- markup + styles exist ---- */
const html = fs.readFileSync(path.join(APP, 'server-settings.html'), 'utf8');
for (const id of ['sFontGoogle', 'sFontUpload', 'sNameFontUrl', 'sNameFontFile', 'sFontFileName']) {
  ok(`server-settings.html has #${id}`, new RegExp(`id="${id}"`).test(html));
}
ok('font panels start hidden', /id="sFontGoogle" class="font-src hidden"/.test(html));
ok('font file input accepts webfont types', /id="sNameFontFile"[^>]*accept="[^"]*woff2/.test(html));
const css = fs.readFileSync(path.join(APP, 'assets/css/theme.css'), 'utf8');
ok('.font-src styled', /\.font-src\s*\{/.test(css));
ok('invalid URL state styled', /\.font-src \.input\.bad/.test(css));
ok('tiff-pending styled', /\.tiff-pending/.test(css));
ok('tiff-failed styled', /\.tiff-failed/.test(css));

console.log(fails ? `\n${fails} FAILED` : '\nAll font checks passed');
process.exit(fails ? 1 : 0);
