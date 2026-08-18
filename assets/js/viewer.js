/* Attachment rendering: images, Ace code/text preview, custom audio + video players. */
window.Viewer = (function () {
  const ACE_CDN = 'https://cdnjs.cloudflare.com/ajax/libs/ace/1.32.6';
  const ACE_MODE = {
    js:'javascript',mjs:'javascript',jsx:'jsx',ts:'typescript',tsx:'typescript',json:'json',
    html:'html',htm:'html',vue:'html',svelte:'html',xml:'xml',svg:'xml',
    css:'css',scss:'scss',sass:'sass',less:'less',
    py:'python',rb:'ruby',php:'php',go:'golang',rs:'rust',java:'java',kt:'kotlin',swift:'swift',
    c:'c_cpp',h:'c_cpp',cpp:'c_cpp',cc:'c_cpp',cxx:'c_cpp',hpp:'c_cpp',cs:'csharp',
    sh:'sh',bash:'sh',zsh:'sh',ps1:'powershell',bat:'batchfile',
    sql:'sql',yml:'yaml',yaml:'yaml',toml:'ini',ini:'ini',cfg:'ini',conf:'ini',env:'ini',
    md:'markdown',markdown:'markdown',txt:'text',log:'text',csv:'text',
    dockerfile:'dockerfile',makefile:'makefile',lua:'lua',r:'r',pl:'perl',scala:'scala',dart:'dart',
  };
  const LABEL = {
    js:'JavaScript',ts:'TypeScript',jsx:'JSX',tsx:'TSX',py:'Python',rb:'Ruby',php:'PHP',go:'Go',
    rs:'Rust',java:'Java',kt:'Kotlin',swift:'Swift',c:'C',cpp:'C++',cs:'C#',sh:'Shell',sql:'SQL',
    yml:'YAML',yaml:'YAML',json:'JSON',html:'HTML',css:'CSS',md:'Markdown',txt:'Plain text',
  };

  const IMG = ['png','jpg','jpeg','gif','webp','svg','bmp','ico','avif','apng','tif','tiff','heic'];
  const VID = ['mp4','webm','mov','mkv','ogv','m4v','avi','3gp','mpeg','mpg'];
  const AUD = ['mp3','wav','ogg','oga','opus','aac','flac','m4a','weba','aiff','mid'];

  function extOf(n) { return (n.split('.').pop() || '').toLowerCase(); }
  function kindOf(name) {
    const e = extOf(name);
    if (IMG.includes(e)) return 'image';
    if (VID.includes(e)) return 'video';
    if (AUD.includes(e)) return 'audio';
    if (ACE_MODE[e] || e === '') return 'code';
    return 'file';
  }
  function human(b) {
    if (!b) return '0 B';
    const u = ['B','KB','MB','GB']; const i = Math.floor(Math.log(b) / Math.log(1024));
    return (b / Math.pow(1024, i)).toFixed(i ? 1 : 0) + ' ' + u[i];
  }
  const fmt = (s) => {
    if (!isFinite(s)) return '0:00';
    const m = Math.floor(s / 60), x = Math.floor(s % 60);
    return `${m}:${String(x).padStart(2, '0')}`;
  };

  let aceReady = null;
  function loadAce() {
    if (aceReady) return aceReady;
    aceReady = new Promise((res, rej) => {
      if (window.ace) return res();
      const s = document.createElement('script');
      s.src = ACE_CDN + '/ace.js';
      s.onload = () => { window.ace.config.set('basePath', ACE_CDN); res(); };
      s.onerror = () => rej(new Error('editor failed to load'));
      document.head.appendChild(s);
    });
    return aceReady;
  }

  /* ---- audio player ---- */
  function audioPlayer(att) {
    const el = document.createElement('div');
    el.className = 'aplayer';
    el.innerHTML = `
      <button class="ap-play"><i class="fa-solid fa-play"></i></button>
      <div class="ap-mid">
        <div class="ap-name">${MD.esc(att.file_name)}</div>
        <div class="ap-bars">${Array.from({length:34},()=>'<i></i>').join('')}</div>
        <div class="ap-seek"><div class="ap-fill"></div><input type="range" min="0" max="1000" value="0"></div>
        <div class="ap-times"><span class="ap-cur">0:00</span><span class="ap-dur">0:00</span></div>
      </div>
      <div class="ap-right">
        <button class="ap-rate">1×</button>
        <button class="ap-mute"><i class="fa-solid fa-volume-high"></i></button>
        <a class="ap-dl" href="${att.url}" download title="Download"><i class="fa-solid fa-download"></i></a>
      </div>
      <audio preload="metadata" src="${att.url}"></audio>`;

    const a = el.querySelector('audio'), play = el.querySelector('.ap-play');
    const seek = el.querySelector('input'), fill = el.querySelector('.ap-fill');
    const cur = el.querySelector('.ap-cur'), dur = el.querySelector('.ap-dur');
    const bars = el.querySelector('.ap-bars');
    let rates = [1, 1.25, 1.5, 2, 0.75], ri = 0;

    play.onclick = () => {
      document.querySelectorAll('audio, video').forEach((o) => { if (o !== a) o.pause(); });
      a.paused ? a.play() : a.pause();
    };
    a.onplay = () => { play.innerHTML = '<i class="fa-solid fa-pause"></i>'; bars.classList.add('on'); };
    a.onpause = () => { play.innerHTML = '<i class="fa-solid fa-play"></i>'; bars.classList.remove('on'); };
    a.onended = () => { play.innerHTML = '<i class="fa-solid fa-play"></i>'; bars.classList.remove('on'); };
    a.onloadedmetadata = () => { dur.textContent = fmt(a.duration); };
    a.ontimeupdate = () => {
      if (!a.duration) return;
      const p = a.currentTime / a.duration;
      seek.value = Math.round(p * 1000);
      fill.style.width = (p * 100) + '%';
      cur.textContent = fmt(a.currentTime);
    };
    seek.oninput = () => { if (a.duration) a.currentTime = (seek.value / 1000) * a.duration; };
    el.querySelector('.ap-mute').onclick = (e) => {
      a.muted = !a.muted;
      e.currentTarget.innerHTML = `<i class="fa-solid fa-volume-${a.muted ? 'xmark' : 'high'}"></i>`;
    };
    el.querySelector('.ap-rate').onclick = (e) => {
      ri = (ri + 1) % rates.length; a.playbackRate = rates[ri];
      e.currentTarget.textContent = rates[ri] + '×';
    };
    return el;
  }

  /* ---- video player ---- */
  function videoPlayer(att) {
    const el = document.createElement('div');
    el.className = 'vplayer';
    el.innerHTML = `
      <video preload="metadata" src="${att.url}" playsinline></video>
      <div class="vp-center"><button class="vp-big"><i class="fa-solid fa-play"></i></button></div>
      <div class="vp-bar">
        <div class="vp-seek"><div class="vp-buf"></div><div class="vp-fill"></div><input type="range" min="0" max="1000" value="0"></div>
        <div class="vp-ctl">
          <button class="vp-play"><i class="fa-solid fa-play"></i></button>
          <span class="vp-time">0:00 / 0:00</span>
          <span style="flex:1"></span>
          <button class="vp-mute"><i class="fa-solid fa-volume-high"></i></button>
          <button class="vp-rate">1×</button>
          <button class="vp-pip" title="Picture in picture"><i class="fa-solid fa-clone"></i></button>
          <button class="vp-fs"><i class="fa-solid fa-expand"></i></button>
        </div>
      </div>`;

    const v = el.querySelector('video'), big = el.querySelector('.vp-big');
    const play = el.querySelector('.vp-play'), seek = el.querySelector('input');
    const fill = el.querySelector('.vp-fill'), buf = el.querySelector('.vp-buf');
    const time = el.querySelector('.vp-time');
    let rates = [1, 1.25, 1.5, 2, 0.5], ri = 0;

    const toggle = () => {
      document.querySelectorAll('audio, video').forEach((o) => { if (o !== v) o.pause(); });
      v.paused ? v.play() : v.pause();
    };
    big.onclick = toggle; play.onclick = toggle; v.onclick = toggle;
    v.onplay = () => { el.classList.add('playing'); play.innerHTML = big.innerHTML = '<i class="fa-solid fa-pause"></i>'; };
    v.onpause = () => { el.classList.remove('playing'); play.innerHTML = big.innerHTML = '<i class="fa-solid fa-play"></i>'; };
    v.ontimeupdate = () => {
      if (!v.duration) return;
      const p = v.currentTime / v.duration;
      seek.value = Math.round(p * 1000);
      fill.style.width = (p * 100) + '%';
      time.textContent = `${fmt(v.currentTime)} / ${fmt(v.duration)}`;
      if (v.buffered.length) buf.style.width = (v.buffered.end(v.buffered.length - 1) / v.duration * 100) + '%';
    };
    v.onloadedmetadata = () => { time.textContent = `0:00 / ${fmt(v.duration)}`; };
    seek.oninput = () => { if (v.duration) v.currentTime = (seek.value / 1000) * v.duration; };
    el.querySelector('.vp-mute').onclick = (e) => {
      v.muted = !v.muted;
      e.currentTarget.innerHTML = `<i class="fa-solid fa-volume-${v.muted ? 'xmark' : 'high'}"></i>`;
    };
    el.querySelector('.vp-rate').onclick = (e) => {
      ri = (ri + 1) % rates.length; v.playbackRate = rates[ri];
      e.currentTarget.textContent = rates[ri] + '×';
    };
    el.querySelector('.vp-pip').onclick = () => { if (v.requestPictureInPicture) v.requestPictureInPicture().catch(() => {}); };
    el.querySelector('.vp-fs').onclick = () => {
      if (document.fullscreenElement) document.exitFullscreen();
      else el.requestFullscreen?.();
    };
    return el;
  }

  /* ---- code / text preview (Ace, read-only, dark, no print margin) ---- */
  function codeBlock(att) {
    const e = extOf(att.file_name);
    const el = document.createElement('div');
    el.className = 'cblock';
    el.innerHTML = `
      <div class="cb-head">
        <span class="cb-name"><i class="fa-solid fa-file-code"></i> ${MD.esc(att.file_name)}</span>
        <span class="cb-lang">${LABEL[e] || (e ? e.toUpperCase() : 'Text')}</span>
        <span style="flex:1"></span>
        <span class="cb-size">${human(att.file_size)}</span>
        <button class="cb-copy" title="Copy"><i class="fa-regular fa-copy"></i></button>
        <a class="cb-dl" href="${att.url}" download title="Download"><i class="fa-solid fa-download"></i></a>
        <button class="cb-toggle" title="Collapse"><i class="fa-solid fa-chevron-up"></i></button>
      </div>
      <div class="cb-body"><div class="cb-editor">Loading…</div></div>`;

    const host = el.querySelector('.cb-editor');
    let text = '';

    (async () => {
      try {
        text = await window.__nx_tp.getText(att.storage_key || att.url_key || att.file_name);
      } catch {
        try { text = await (await fetch(att.url)).text(); }
        catch { host.textContent = 'Could not load this file.'; return; }
      }
      try {
        await loadAce();
        host.textContent = '';
        const ed = window.ace.edit(host, {
          mode: 'ace/mode/' + (ACE_MODE[e] || 'text'),
          theme: 'ace/theme/tomorrow_night',
          readOnly: true,
          showPrintMargin: false,   // no vertical reference line down the middle
          highlightActiveLine: false,
          showGutter: true,
          useWorker: false,
          fontSize: 12.5,
          wrap: true,
          maxLines: 26,
          minLines: 3,
          tabSize: 2,
        });
        ed.setValue(text, -1);
        ed.renderer.$cursorLayer.element.style.display = 'none'; // read-only: hide caret
        ed.container.style.background = 'transparent';
      } catch {
        host.innerHTML = `<pre class="cb-plain">${MD.esc(text)}</pre>`;
      }
    })();

    el.querySelector('.cb-copy').onclick = () => {
      navigator.clipboard.writeText(text).then(() => UI.toast('Copied to clipboard.'));
    };
    el.querySelector('.cb-toggle').onclick = (ev) => {
      const b = el.querySelector('.cb-body');
      const hid = b.classList.toggle('hidden');
      ev.currentTarget.innerHTML = `<i class="fa-solid fa-chevron-${hid ? 'down' : 'up'}"></i>`;
    };
    return el;
  }

  function lightbox(url, name) {
    const ov = document.createElement('div');
    ov.className = 'lightbox';
    ov.innerHTML = `<img src="${url}" alt="${MD.esc(name)}">
      <div class="lb-bar"><span>${MD.esc(name)}</span>
      <a href="${url}" download class="btn btn-ghost btn-sm"><i class="fa-solid fa-download"></i> Download</a>
      <button class="btn btn-ghost btn-sm lb-x"><i class="fa-solid fa-xmark"></i></button></div>`;
    document.body.appendChild(ov);
    const close = () => ov.remove();
    ov.onclick = (e) => { if (e.target === ov) close(); };
    ov.querySelector('.lb-x').onclick = close;
    document.addEventListener('keydown', function esc(e) {
      if (e.key === 'Escape') { close(); document.removeEventListener('keydown', esc); }
    });
  }

  /* Renders one attachment into a DOM node. */
  function render(att) {
    const kind = kindOf(att.file_name);
    if (kind === 'image') {
      const w = document.createElement('div');
      w.className = 'att-img';
      w.innerHTML = `<img src="${att.url}" alt="${MD.esc(att.file_name)}" loading="lazy">`;
      w.querySelector('img').onclick = () => lightbox(att.url, att.file_name);
      return w;
    }
    if (kind === 'audio') return audioPlayer(att);
    if (kind === 'video') return videoPlayer(att);
    if (kind === 'code' && att.file_size <= 512 * 1024) return codeBlock(att);

    const f = document.createElement('a');
    f.className = 'att-file';
    f.href = att.url; f.download = att.file_name; f.target = '_blank';
    f.innerHTML = `<div class="af-ico"><i class="fa-solid fa-file-arrow-down"></i></div>
      <div class="af-mid"><b>${MD.esc(att.file_name)}</b><small>${human(att.file_size)}</small></div>`;
    return f;
  }

  return { render, kindOf, human, lightbox };
})();
