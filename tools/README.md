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
