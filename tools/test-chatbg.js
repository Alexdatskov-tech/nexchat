/* The chat-column blur/dim settings: defaults, the class gate that keeps a
   zero blur off the compositor, and the save -> reload round trip. */
const fs = require('fs');
const { JSDOM } = require('jsdom');

const APP = '/home/user/nexchat';
let fails = 0;
const ok = (n, c, extra) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${extra ? '  ' + extra : ''}`); if (!c) fails++; };

const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', { runScripts: 'outside-only' });
const w = dom.window;
global.window = w; global.document = w.document;
w.eval(fs.readFileSync(`${APP}/assets/js/ui.js`, 'utf8'));
const UI = w.UI;
const root = w.document.documentElement;
const cls = () => [...w.document.body.classList];
const varOf = (n) => root.style.getPropertyValue(n);

/* ---- 1. defaults ---- */
ok('UI exports the shared defaults',
   UI.CHAT_BLUR_DEFAULT === 12 && UI.CHAT_DIM_DEFAULT === 42,
   `blur=${UI.CHAT_BLUR_DEFAULT} dim=${UI.CHAT_DIM_DEFAULT}`);

// A profile saved before these keys existed must render as the default.
UI.applyBackground({ dash_bg: "url('x.jpg')" });
ok('legacy profile gets the default blur', varOf('--chat-blur') === '12px', varOf('--chat-blur'));
ok('legacy profile gets the default dim', varOf('--chat-dim') === '0.42', varOf('--chat-dim'));
ok('  and mounts the blur layer', cls().includes('chat-blur'));

/* ---- 2. the gate ---- */
UI.applyBackground({ dash_bg: "url('x.jpg')", chat_blur: 0, chat_dim: 30 });
ok('blur 0 unmounts the filter layer', !cls().includes('chat-blur'));
ok('  but the dim still applies', varOf('--chat-dim') === '0.3', varOf('--chat-dim'));

UI.applyBackground({ dash_bg: "url('x.jpg')", chat_blur: 8, chat_dim: 30 });
ok('blur 8 mounts the filter layer', cls().includes('chat-blur'));
ok('  with the right value', varOf('--chat-blur') === '8px', varOf('--chat-blur'));

/* ---- 3. removing the wallpaper tears everything down ---- */
UI.applyBackground({});
ok('no wallpaper removes has-bg', !cls().includes('has-bg'));
ok('  and removes chat-blur too', !cls().includes('chat-blur'), cls().join(' '));

/* ---- 4. the CSS honours the gate ---- */
const css = fs.readFileSync(`${APP}/assets/css/theme.css`, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const ungated = (css.match(/body\.has-bg \.chat::before\s*\{[^}]*\}/) || [''])[0];
const gated = (css.match(/body\.has-bg\.chat-blur \.chat::before\s*\{[^}]*\}/) || [''])[0];
ok('dim lives on the ungated rule', /background:\s*rgba/.test(ungated));
ok('blur lives only on the gated rule',
   !/backdrop-filter/.test(ungated) && /backdrop-filter:\s*blur/.test(gated));
ok('gated rule keeps the -webkit- prefix', /-webkit-backdrop-filter/.test(gated));

/* ---- 5. the editor round trip ---- */
const html = fs.readFileSync(`${APP}/profile.html`, 'utf8');
for (const id of ['fChatBlur', 'chatBlurV', 'fChatDim', 'chatDimV', 'haloEgs']) {
  ok(`profile.html has #${id}`, new RegExp(`id="${id}"`).test(html));
}
const pj = fs.readFileSync(`${APP}/assets/js/profile.js`, 'utf8');
ok('sliders are wired to oninput',
   /\$\('fChatBlur'\)\.oninput/.test(pj) && /\$\('fChatDim'\)\.oninput/.test(pj));
ok('values are saved to the theme',
   /patch\.theme\.chat_blur = chatBlur/.test(pj) && /patch\.theme\.chat_dim = chatDim/.test(pj));
ok('values are read back on load',
   /chatBlur = th\.chat_blur \?\? UI\.CHAT_BLUR_DEFAULT/.test(pj)
   && /chatDim = th\.chat_dim \?\? UI\.CHAT_DIM_DEFAULT/.test(pj));
ok('the live preview passes them through',
   /chat_blur: chatBlur, chat_dim: chatDim/.test(pj));
// The slider bounds must be able to express the default.
const blurMax = +(/id="fChatBlur"[^>]*max="(\d+)"/.exec(html) || [])[1];
ok('blur slider range covers the default', blurMax >= UI.CHAT_BLUR_DEFAULT, `max=${blurMax}`);

console.log(fails ? `\n${fails} FAILED` : '\nAll chat-background checks passed');
process.exit(fails ? 1 : 0);
