const fs = require('fs'), { JSDOM } = require('jsdom');
const REPO = '/home/user/nexchat';
const css = fs.readFileSync(`${REPO}/assets/css/theme.css`, 'utf8');

function page(file) {
  const html = fs.readFileSync(`${REPO}/${file}`, 'utf8')
    .replace(/<link[^>]*>/g, '').replace(/<script[^>]*>\s*<\/script>/g, '');
  const dom = new JSDOM(html.replace('</head>', `<style>${css}</style></head>`), { pretendToBeVisual: true, runScripts: 'outside-only' });
  return dom.window;
}

/* jsdom does not resolve var(), so read the cascade manually: find the winning
   declaration for a property, then resolve custom properties from :root plus
   any inline override on <html>. */
function rootVars(w) {
  const out = {};
  for (const sheet of w.document.styleSheets) {
    for (const r of sheet.cssRules || []) {
      if (r.selectorText === ':root') {
        for (const p of r.style) if (p.startsWith('--')) out[p] = r.style.getPropertyValue(p).trim();
      }
    }
  }
  for (const p of w.document.documentElement.style) {
    if (p.startsWith('--')) out[p] = w.document.documentElement.style.getPropertyValue(p).trim();
  }
  return out;
}
function deref(val, vars, depth = 0) {
  if (!val || depth > 6) return val;
  const m = val.match(/^var\((--[^,)]+)(?:,\s*(.+))?\)$/);
  if (!m) return val;
  const got = vars[m[1].trim()];
  return deref(got !== undefined && got !== '' ? got : (m[2] || ''), vars, depth + 1);
}
function winning(w, el, prop) {
  let best = null, bestSpec = -1;
  for (const sheet of w.document.styleSheets) {
    for (const r of sheet.cssRules || []) {
      if (!r.selectorText) continue;
      for (const sel of r.selectorText.split(',')) {
        const s = sel.trim();
        let matches = false;
        try { matches = el.matches(s); } catch { }
        if (!matches) continue;
        const v = r.style.getPropertyValue(prop);
        if (!v) continue;
        const spec = (s.match(/#/g) || []).length * 100 + (s.match(/\./g) || []).length * 10 + (s.match(/[a-z]/i) ? 1 : 0);
        if (spec >= bestSpec) { bestSpec = spec; best = v.trim(); }
      }
    }
  }
  return best;
}
const resolved = (w, el, prop) => deref(winning(w, el, prop), rootVars(w));

let pass = 0, fail = 0;
const check = (label, got, want) => {
  const ok = String(got).toLowerCase() === String(want).toLowerCase();
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}  got=${JSON.stringify(got)}${ok ? '' : ` want=${JSON.stringify(want)}`}`);
  ok ? pass++ : fail++;
};

console.log('--- portal server card (the invisible-black bug) ---');
{
  const w = page('portal.html');
  const btn = w.document.createElement('button');
  btn.className = 'scard';
  btn.innerHTML = '<div class="scard-body"><div class="scard-name"><span>My Server</span></div></div>';
  w.document.body.appendChild(btn);
  // A <button> does not inherit colour, so .scard itself must declare one.
  check('.scard declares an explicit colour', !!winning(w, btn, 'color'), true);
  check('.scard colour is not black', resolved(w, btn, 'color') !== '#000000' && resolved(w, btn, 'color') !== 'black', true);
  const nm = btn.querySelector('.scard-name');
  check('.scard-name colour', resolved(w, nm, 'color'), '#FFFFFF');
  check('.scard-name font is configurable', /Bricolage/.test(resolved(w, nm, 'font-family')), true);
}

console.log('\n--- server sidebar name ---');
{
  const w = page('server.html');
  const b = w.document.getElementById('srvName');
  check('#srvName colour defaults white', resolved(w, b, 'color'), '#FFFFFF');
  check('#srvName font var applied', /Bricolage/.test(resolved(w, b, 'font-family')), true);

  // Now apply a server theme the way server.js does.
  w.eval(fs.readFileSync(`${REPO}/assets/js/ui.js`, 'utf8'));
  w.UI.applyServerName({ name_color: '#E8B04B', name_font: 'mono' });
  check('after theme -> colour', resolved(w, b, 'color'), '#E8B04B');
  check('after theme -> font', /JetBrains/.test(resolved(w, b, 'font-family')), true);

  // Garbage or missing values must fall back to white, never to nothing.
  w.UI.applyServerName({ name_color: 'javascript:alert(1)', name_font: 'nope' });
  check('bad colour falls back white', resolved(w, b, 'color'), '#FFFFFF');
  check('bad font falls back display', /Bricolage/.test(resolved(w, b, 'font-family')), true);
  w.UI.applyServerName(undefined);
  check('no theme at all -> white', resolved(w, b, 'color'), '#FFFFFF');
}

console.log('\n--- settings controls exist and round-trip ---');
{
  const w = page('server-settings.html');
  for (const id of ['sNameColor', 'sNameHex', 'sNameFont', 'sNameReset', 'sNameSwatches', 'sNamePreview']) {
    check(`#${id} present`, !!w.document.getElementById(id), true);
  }
  const src = fs.readFileSync(`${REPO}/assets/js/server-settings.js`, 'utf8');
  check('save persists name_color', /name_color:\s*\$\('sNameColor'\)\.value/.test(src), true);
  check('save persists name_font', /name_font:\s*nameFont/.test(src), true);
  check('hydrate restores name_color', /srv\.theme\?\.name_color/.test(src), true);
}

console.log(`\n===== ${pass} passed, ${fail} failed =====`);
process.exit(fail ? 1 : 0);
