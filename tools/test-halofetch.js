/* Custom halos are read off the profile row: halo_css lives in `theme`, and the
   halo GIF in `banner_gif_url`. Any query whose result is handed to UI.avatar
   must therefore select both, or the avatar silently falls back to the default
   gold ring -- which is exactly how the chat message list regressed. */
const fs = require('fs');
const { JSDOM } = require('jsdom');

const APP = '/home/user/nexchat';
let fails = 0;
const ok = (n, c, extra) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${extra ? '  ' + extra : ''}`); if (!c) fails++; };

/* ---- 1. the renderer really does depend on those two columns ---- */
const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', { runScripts: 'outside-only' });
const w = dom.window;
global.window = w; global.document = w.document;
w.eval(fs.readFileSync(`${APP}/assets/js/ui.js`, 'utf8'));
const UI = w.UI;

const full = {
  id: 'u1', username: 'nitro', is_nitro: true, avatar_url: null, accent_color: '#E8B04B',
  banner_gif_url: null,
  theme: { dev_mode: true, halo_css: 'background: linear-gradient(90deg,#8B7CF6,#5AC8D8);' },
};
const stripped = { ...full }; delete stripped.theme; delete stripped.banner_gif_url;

ok('a full profile renders the custom ring', /av-halo-custom/.test(UI.avatar(full, 38)));
ok('a profile without theme falls back to the default ring',
   !/av-halo-custom/.test(UI.avatar(stripped, 38)));

const gif = { ...full, theme: null, banner_gif_url: 'https://x.test/ring.gif' };
ok('a halo GIF needs banner_gif_url', /av-halo-img/.test(UI.avatar(gif, 38)));

/* ---- 2. every avatar-feeding query must select both columns ---- */
// Narrow profile selects, i.e. an explicit column list rather than `*`.
const FILES = ['server.js', 'dms.js', 'notify.js', 'admin.js', 'server-settings.js', 'portal.js', 'presence.js'];
const re = /\.select\(\s*'([^']*(?:username|display_name)[^']*)'/g;

let checked = 0;
for (const f of FILES) {
  const src = fs.readFileSync(`${APP}/assets/js/${f}`, 'utf8');
  const lines = src.split('\n');
  for (const m of src.matchAll(re)) {
    const cols = m[1];
    // `*` pulls everything, so only explicit lists can be missing a column.
    if (cols.includes('*') && !/profiles[!\w]*\(/.test(cols)) continue;
    if (!/avatar_url/.test(cols)) continue;          // not feeding an avatar
    const line = src.slice(0, m.index).split('\n').length;
    // Only the profile column list matters, not the outer table's `*`.
    const profileCols = /profiles[!\w]*\(([^)]*)\)/.exec(cols)?.[1] ?? cols;
    if (!/is_nitro/.test(profileCols)) continue;     // no halo rendered from this row
    checked++;
    ok(`${f}:${line} selects theme`, /\btheme\b/.test(profileCols), profileCols.slice(0, 62));
    ok(`${f}:${line} selects banner_gif_url`, /banner_gif_url/.test(profileCols));
  }
}
ok('found the avatar queries to check', checked >= 10, `${checked} queries`);

console.log(fails ? `\n${fails} FAILED` : '\nAll halo-fetch checks passed');
process.exit(fails ? 1 : 0);
