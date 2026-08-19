# tools

## build-emoji.js

Regenerates `assets/js/emoji-data.js` from the Unicode CLDR data shipped in
the `emojibase-data` package.

```bash
npm i emojibase-data      # not vendored; only needed to regenerate
node tools/build-emoji.js
```

The generated file is committed, so a normal checkout needs no build step
and no npm install.

Two filters are applied deliberately:

- **Unicode <= 15.0.** Newer emoji render as tofu boxes on systems that
  haven't shipped the font update, which looks broken. Raise `MAX_VERSION`
  once the newer sets are widespread.
- **The "component" group is dropped.** Skin-tone modifiers and regional
  indicator letters are combining parts, not standalone emoji, and would
  appear as stray colour swatches and letter tiles in the grid.

Ordering within each group is CLDR order, which is what Android and Windows
use in their own pickers.

## test-*.js

jsdom harnesses, one per feature area. They need `jsdom` on the module path:

```bash
npm i jsdom
node tools/test-halo.js
```

Some are parameterised by a `SOCKET` env var, which decides whether the mocked
Supabase channel delivers realtime events (`live`), stays quiet so the polling
fallback has to cover (`silent`), or is left unset for the default path:

```bash
SOCKET=silent node tools/test-guard.js
```

`test-server`, `test-dms`, `test-rx`, `test-editdel`, `test-presence` and
`test-guard` are the socket-parameterised ones; the rest run single-mode. Each
prints one line per assertion and exits non-zero on the first failure.
