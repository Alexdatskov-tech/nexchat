/* TIFF rendering shim.

   Chrome and Firefox refuse to decode image/tiff in <img>, so a .tif attachment
   would otherwise show as a broken image. This decodes TIFF bytes to a PNG blob
   URL on the client using UTIF (MIT) and swaps it into the <img> in place.

   The decoder is ~118 KB, so it is fetched lazily the first time a TIFF is
   actually shown; pages with no TIFF attachments never pay for it. */
window.Tiff = (function () {
  const VENDOR = 'assets/js/vendor/utif';
  const EXT = /\.tiff?($|\?)/i;

  let loading = null;                 // in-flight decoder load, shared by all callers
  const cache = new Map();            // source URL -> object URL of the decoded PNG

  function isTiff(nameOrUrl) {
    return EXT.test(String(nameOrUrl || ''));
  }

  // Safari decodes TIFF natively; skip the whole detour there.
  function nativeSupport() {
    if (typeof document === 'undefined') return false;
    const ua = navigator.userAgent || '';
    return /^((?!chrome|android|crios|fxios).)*safari/i.test(ua);
  }

  function script(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.onload = resolve;
      s.onerror = () => reject(new Error(`Could not load ${src}`));
      document.head.appendChild(s);
    });
  }

  function loadDecoder() {
    if (window.UTIF) return Promise.resolve();
    if (!loading) {
      // pako first: UTIF binds self.pako at definition time for deflate TIFFs.
      loading = script(`${VENDOR}/pako_inflate.min.js`)
        .then(() => script(`${VENDOR}/utif.js`))
        .catch((e) => { loading = null; throw e; });
    }
    return loading;
  }

  /* Decodes one TIFF URL and resolves to a PNG object URL. */
  async function toPngUrl(url) {
    if (cache.has(url)) return cache.get(url);

    await loadDecoder();
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = await res.arrayBuffer();

    const pages = window.UTIF.decode(buf);
    if (!pages.length) throw new Error('No image data in that TIFF.');
    const page = pages[0];
    window.UTIF.decodeImage(buf, page, pages);
    const rgba = window.UTIF.toRGBA8(page);

    const cv = document.createElement('canvas');
    cv.width = page.width;
    cv.height = page.height;
    const ctx = cv.getContext('2d');
    const id = ctx.createImageData(page.width, page.height);
    id.data.set(rgba);
    ctx.putImageData(id, 0, 0);

    const blob = await new Promise((r) => cv.toBlob(r, 'image/png'));
    if (!blob) throw new Error('Could not convert that TIFF.');
    const out = URL.createObjectURL(blob);
    cache.set(url, out);
    return out;
  }

  /* Point an <img> at a TIFF and this rewrites its src once decoded.
     No-op for non-TIFF sources and on browsers that decode TIFF themselves. */
  function hydrate(img, url) {
    const src = url || img?.getAttribute('src');
    if (!img || !isTiff(src) || nativeSupport()) return;

    img.classList.add('tiff-pending');
    toPngUrl(src)
      .then((png) => { img.src = png; img.classList.remove('tiff-pending'); })
      .catch(() => {
        img.classList.remove('tiff-pending');
        img.classList.add('tiff-failed');
        img.removeAttribute('src');
        img.alt = 'This TIFF could not be displayed.';
      });
  }

  /* Same idea for a File the user just picked, where there is no URL yet and
     the name — not the src — is what identifies it as a TIFF. */
  function hydrateFile(img, file) {
    if (!img || !file || !isTiff(file.name) || nativeSupport()) return;
    const obj = URL.createObjectURL(file);
    img.classList.add('tiff-pending');
    toPngUrl(obj)
      .then((png) => { img.src = png; img.classList.remove('tiff-pending'); })
      .catch(() => {
        img.classList.remove('tiff-pending');
        img.classList.add('tiff-failed');
        img.removeAttribute('src');
        img.alt = 'This TIFF could not be displayed.';
      })
      .finally(() => URL.revokeObjectURL(obj));
  }

  /* Transcodes a picked TIFF into a PNG File, for images that get stored and
     later shown as plain <img> all over the app (avatars, banners, icons,
     wallpapers). Non-TIFF input is returned untouched. Message attachments
     deliberately do NOT go through this — there the original file is the point,
     and hydrate() decodes it at display time instead. */
  async function toPngFile(file) {
    if (!file || !isTiff(file.name)) return file;
    const obj = URL.createObjectURL(file);
    try {
      const png = await toPngUrl(obj);
      const blob = await (await fetch(png)).blob();
      const name = file.name.replace(EXT, '.png');
      return new File([blob], name, { type: 'image/png' });
    } finally {
      URL.revokeObjectURL(obj);
    }
  }

  /* Convenience for containers rendered in one shot. */
  function hydrateAll(root) {
    (root || document).querySelectorAll('img[src]').forEach((img) => {
      if (isTiff(img.getAttribute('src'))) hydrate(img);
    });
  }

  return { isTiff, hydrate, hydrateFile, hydrateAll, toPngUrl, toPngFile, nativeSupport };
})();
