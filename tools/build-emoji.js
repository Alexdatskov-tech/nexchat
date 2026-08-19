const data = require('emojibase-data/en/data.json');
const messages = require('emojibase-data/en/messages.json');
const scEmojibase = require('emojibase-data/en/shortcodes/emojibase.json');
const scGithub = require('emojibase-data/en/shortcodes/github.json');
const fs = require('fs');

// Anything newer than this renders as a tofu box on a lot of installed
// systems, which looks broken. 15.0 is safely covered by current
// Windows 11 and Android.
const MAX_VERSION = 15.0;
// Group 2 is "component": skin-tone modifiers and regional indicators.
// They are not standalone emoji and must not appear in a picker.
const COMPONENT_GROUP = 2;

const GROUPS = [
  { key: 'smileys-emotion', name: 'Smileys & Emotion', icon: 'fa-face-smile' },
  { key: 'people-body',     name: 'People & Body',     icon: 'fa-hand' },
  { key: 'animals-nature',  name: 'Animals & Nature',  icon: 'fa-paw' },
  { key: 'food-drink',      name: 'Food & Drink',      icon: 'fa-mug-saucer' },
  { key: 'travel-places',   name: 'Travel & Places',   icon: 'fa-plane' },
  { key: 'activities',      name: 'Activities',        icon: 'fa-futbol' },
  { key: 'objects',         name: 'Objects',           icon: 'fa-lightbulb' },
  { key: 'symbols',         name: 'Symbols',           icon: 'fa-heart' },
  { key: 'flags',           name: 'Flags',             icon: 'fa-flag' },
];
const groupOrder = new Map(messages.groups.map((g) => [g.order, g.key]));
const groupIndex = new Map(GROUPS.map((g, i) => [g.key, i]));

const rows = [];
for (const e of data) {
  if (e.group === undefined || e.group === COMPONENT_GROUP) continue;
  if (parseFloat(e.version) > MAX_VERSION) continue;
  const key = groupOrder.get(e.group);
  const gi = groupIndex.get(key);
  if (gi === undefined) continue;

  const shorts = [...(scEmojibase[e.hexcode] || []), ...(scGithub[e.hexcode] || [])];
  // Search terms = CLDR tags + shortcodes, minus words already in the label.
  const inLabel = new Set(e.label.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
  const terms = [...new Set([...(e.tags || []), ...shorts.flat()]
    .map((t) => String(t).toLowerCase().replace(/_/g, ' '))
    .filter((t) => t && !inLabel.has(t)))];

  rows.push({
    u: e.emoji || e.text,
    n: e.label.toLowerCase(),
    g: gi,
    o: e.order == null ? 1e9 : e.order,
    k: terms.join(' '),
  });
}
rows.sort((a, b) => (a.g - b.g) || (a.o - b.o));

// [emoji, name, group, keywords] -- compact positional tuples keep the
// payload small; the picker expands them at runtime.
const list = rows.map((r) => [r.u, r.n, r.g, r.k]);

const out = `/* NexChat emoji catalogue -- GENERATED, do not hand-edit.
   Source: emojibase-data (Unicode CLDR ${require('emojibase-data/package.json').version}).
   Regenerate with tools/build-emoji.js

   ${list.length} emoji, Unicode <= ${MAX_VERSION} so nothing renders as a
   tofu box on current Windows/Android. Skin-tone components and regional
   indicators are excluded. Order within each group is CLDR order, which is
   the same ordering Android and Windows use in their own pickers.

   Each entry: [emoji, name, groupIndex, searchKeywords] */
window.EMOJI = {
  groups: ${JSON.stringify(GROUPS)},
  list: ${JSON.stringify(list)}
};
`;
fs.writeFileSync('/home/user/nexchat/assets/js/emoji-data.js', out);
console.log('emoji written:', list.length);
GROUPS.forEach((g, i) => console.log(' ', g.name, rows.filter((r) => r.g === i).length));
