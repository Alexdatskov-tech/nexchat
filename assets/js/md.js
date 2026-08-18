/* Full markdown renderer. Everything is HTML-escaped before any rule runs,
   so user text can never inject markup. */
window.MD = (function () {
  const esc = (s) => (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  function inline(t) {
    t = t.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g,
      '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
    t = t.replace(/\|\|([\s\S]+?)\|\|/g, '<span class="spoil">$1</span>');
    t = t.replace(/\*\*\*([^\n*]+)\*\*\*/g, '<strong><em>$1</em></strong>');
    t = t.replace(/\*\*([^\n*]+)\*\*/g, '<strong>$1</strong>');
    t = t.replace(/__([^\n_]+)__/g, '<u>$1</u>');
    t = t.replace(/~~([^\n~]+)~~/g, '<del>$1</del>');
    t = t.replace(/(^|[^*])\*([^\n*]+)\*/g, '$1<em>$2</em>');
    t = t.replace(/(^|\s)_([^\n_]+)_(?=\s|$|[.,!?])/g, '$1<em>$2</em>');
    t = t.replace(/(^|[^"=\]])(https?:\/\/[^\s<]+)/g,
      '$1<a href="$2" target="_blank" rel="noopener noreferrer">$2</a>');
    return t;
  }

  function render(raw) {
    if (!raw) return '';
    let src = esc(raw);

    // Pull fenced code out first so nothing else touches its contents.
    const fences = [];
    src = src.replace(/```([a-zA-Z0-9+#-]*)\n?([\s\S]*?)```/g, (_, lang, code) => {
      const i = fences.push({ lang: lang.toLowerCase(), code: code.replace(/\n$/, '') }) - 1;
      return `\u0000F${i}\u0000`;
    });
    const codes = [];
    src = src.replace(/`([^`\n]+)`/g, (_, c) => `\u0000C${codes.push(c) - 1}\u0000`);

    const lines = src.split('\n');
    let out = '', list = null, quote = false, table = null;

    const closeList = () => { if (list) { out += `</${list}>`; list = null; } };
    const closeQuote = () => { if (quote) { out += '</blockquote>'; quote = false; } };
    const closeTable = () => {
      if (table) {
        out += '<table class="md-table"><thead><tr>' +
          table.head.map((h) => `<th>${inline(h)}</th>`).join('') + '</tr></thead><tbody>' +
          table.rows.map((r) => '<tr>' + r.map((c) => `<td>${inline(c)}</td>`).join('') + '</tr>').join('') +
          '</tbody></table>';
        table = null;
      }
    };
    const closeAll = () => { closeList(); closeQuote(); closeTable(); };

    for (let i = 0; i < lines.length; i++) {
      const ln = lines[i];
      const cells = (s) => s.replace(/^\||\|$/g, '').split('|').map((c) => c.trim());

      // Table: a header row followed by a |---|---| separator
      if (/^\s*\|.*\|\s*$/.test(ln) && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1] || '')) {
        closeList(); closeQuote();
        table = { head: cells(ln.trim()), rows: [] };
        i++;
        while (/^\s*\|.*\|\s*$/.test(lines[i + 1] || '')) table.rows.push(cells(lines[++i].trim()));
        closeTable();
        continue;
      }

      if (/^\s*(---|\*\*\*|___)\s*$/.test(ln)) { closeAll(); out += '<hr class="md-hr">'; continue; }

      const h = ln.match(/^(#{1,6})\s+(.*)$/);
      if (h) { closeAll(); out += `<h${h[1].length} class="md-h">${inline(h[2])}</h${h[1].length}>`; continue; }

      const q = ln.match(/^&gt;\s?(.*)$/);
      if (q) {
        closeList(); closeTable();
        if (!quote) { out += '<blockquote>'; quote = true; }
        out += inline(q[1]) + '<br>';
        continue;
      }
      closeQuote();

      const ul = ln.match(/^\s*[-*+]\s+(.*)$/);
      const ol = ln.match(/^\s*\d+[.)]\s+(.*)$/);
      if (ul || ol) {
        closeTable();
        const want = ul ? 'ul' : 'ol';
        if (list !== want) { closeList(); out += `<${want} class="md-list">`; list = want; }
        out += `<li>${inline((ul || ol)[1])}</li>`;
        continue;
      }
      closeList();

      if (!ln.trim()) { out += '<br>'; continue; }
      out += `<div>${inline(ln)}</div>`;
    }
    closeAll();

    out = out.replace(/\u0000C(\d+)\u0000/g, (_, i) => `<code>${codes[+i]}</code>`);
    out = out.replace(/\u0000F(\d+)\u0000/g, (_, i) => {
      const f = fences[+i];
      return `<pre class="md-pre"${f.lang ? ` data-lang="${f.lang}"` : ''}><code>${f.code}</code></pre>`;
    });
    return out;
  }

  return { render, esc };
})();
