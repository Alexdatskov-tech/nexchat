/* Verifies the vendored UTIF build decodes the TIFF variants ImageMagick emits,
   and that tiff.js exposes the API the app calls. */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const APP = '/home/user/nexchat';
let fails = 0;
const ok = (n, c, extra) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${extra ? '  ' + extra : ''}`); if (!c) fails++; };

/* ---- 1. the vendored decoder actually decodes ---- */
const sandbox = { self: {}, console, process, require };
sandbox.window = sandbox.self;
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(APP, 'assets/js/vendor/utif/pako_inflate.min.js'), 'utf8'), sandbox);
ok('pako_inflate exposes inflateRaw', typeof sandbox.self.pako?.inflateRaw === 'function');
vm.runInContext(fs.readFileSync(path.join(APP, 'assets/js/vendor/utif/utif.js'), 'utf8'), sandbox);
const UTIF = sandbox.self.UTIF;
ok('UTIF loaded from vendor dir', !!UTIF && typeof UTIF.decode === 'function');

for (const f of ['sample_uncompressed.tif', 'sample_lzw.tif', 'sample_zip.tif']) {
  const buf = fs.readFileSync(path.join(__dirname, f));
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  let pages, rgba, err = null;
  try {
    pages = UTIF.decode(ab);
    UTIF.decodeImage(ab, pages[0], pages);
    rgba = UTIF.toRGBA8(pages[0]);
  } catch (e) { err = e; }
  const p = pages?.[0];
  ok(`decode ${f}`, !err && p?.width === 64 && p?.height === 48,
     err ? String(err.message) : `${p?.width}x${p?.height}`);
  ok(`  RGBA buffer ${f}`, rgba && rgba.length === 64 * 48 * 4, rgba ? `${rgba.length} bytes` : 'none');
  // Top-left of a red->blue gradient must be red-ish, bottom-right blue-ish.
  if (rgba) {
    const last = (64 * 48 - 1) * 4;
    ok(`  pixels look like the gradient ${f}`,
       rgba[0] > 180 && rgba[2] < 80 && rgba[last] < 80 && rgba[last + 2] > 180,
       `first=(${rgba[0]},${rgba[1]},${rgba[2]}) last=(${rgba[last]},${rgba[last + 1]},${rgba[last + 2]})`);
  }
}

/* ---- 2. tiff.js surface + extension matching ---- */
const src = fs.readFileSync(path.join(APP, 'assets/js/tiff.js'), 'utf8');
const s2 = { window: {}, document: undefined, navigator: { userAgent: 'node' }, console };
s2.self = s2.window;
vm.createContext(s2);
vm.runInContext(src, s2);
const T = s2.window.Tiff;
ok('Tiff module defined', !!T);
for (const fn of ['isTiff', 'hydrate', 'hydrateFile', 'hydrateAll', 'toPngUrl', 'toPngFile', 'nativeSupport']) {
  ok(`  Tiff.${fn} exported`, typeof T?.[fn] === 'function');
}
ok('isTiff("a.tif")', T.isTiff('a.tif') === true);
ok('isTiff("a.tiff")', T.isTiff('a.tiff') === true);
ok('isTiff("A.TIFF")', T.isTiff('A.TIFF') === true);
ok('isTiff with query string', T.isTiff('https://x/y/a.tif?token=1') === true);
ok('isTiff("a.png") is false', T.isTiff('a.png') === false);
ok('isTiff("tiffany.png") is false', T.isTiff('tiffany.png') === false);
ok('isTiff(null) is false', T.isTiff(null) === false);

/* ---- 3. call sites are wired ---- */
const viewer = fs.readFileSync(path.join(APP, 'assets/js/viewer.js'), 'utf8');
ok('viewer hydrates inline attachment images', /window\.Tiff\?\.hydrate\(im, att\.url\)/.test(viewer));
ok('viewer hydrates the lightbox image', /window\.Tiff\?\.hydrate\(ov\.querySelector\('img'\), url\)/.test(viewer));

const ui = fs.readFileSync(path.join(APP, 'assets/js/ui.js'), 'utf8');
ok('UI.upload transcodes TIFF to PNG', /Tiff\?\.isTiff\(file\.name\)[\s\S]{0,200}toPngFile/.test(ui));
ok('UI.upload sets an explicit contentType', /contentType/.test(ui));

const prof = fs.readFileSync(path.join(APP, 'assets/js/profile.js'), 'utf8');
ok('wallpaper upload transcodes TIFF', /Tiff\?\.isTiff\(wpFile\.name\)/.test(prof));
ok('wallpaper preview decodes TIFF', /Tiff\.toPngUrl\(URL\.createObjectURL\(f\)\)/.test(prof));

/* ---- 4. every image picker accepts TIFF; decoder is loaded where needed ---- */
for (const [page, ids] of [['portal.html', ['cIcon']],
                           ['profile.html', ['fAvatar', 'fBanner', 'fWallpaper']],
                           ['server-settings.html', ['sIcon', 'sBanner']]]) {
  const h = fs.readFileSync(path.join(APP, page), 'utf8');
  for (const id of ids) {
    const m = h.match(new RegExp(`id="${id}"[^>]*accept="([^"]*)"`));
    ok(`${page} #${id} accepts tiff`, !!m && /\.tiff/.test(m[1]), m?.[1]);
  }
}
for (const page of ['portal.html', 'profile.html', 'server-settings.html', 'dms.html', 'server.html']) {
  const h = fs.readFileSync(path.join(APP, page), 'utf8');
  ok(`${page} loads tiff.js`, /assets\/js\/tiff\.js\?v=\d+/.test(h));
}
// dms/server must load it before viewer.js, which calls into it.
for (const page of ['dms.html', 'server.html']) {
  const h = fs.readFileSync(path.join(APP, page), 'utf8');
  ok(`${page} loads tiff.js before viewer.js`, h.indexOf('tiff.js') < h.indexOf('viewer.js'));
}

/* ---- 5. uploader knows the new mime types ---- */
const tp = fs.readFileSync(path.join(APP, 'assets/js/vendor/core/runtime/net/xhr-transport-polyfill.min.js'), 'utf8');
for (const [ext, mime] of [['tiff', 'image/tiff'], ['woff2', 'font/woff2'], ['woff', 'font/woff'], ['ttf', 'font/ttf'], ['otf', 'font/otf']]) {
  ok(`uploader maps .${ext}`, new RegExp(`${ext}:'${mime.replace('/', '\\/')}'`).test(tp));
}

console.log(fails ? `\n${fails} FAILED` : '\nAll TIFF checks passed');
process.exit(fails ? 1 : 0);
