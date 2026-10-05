import { readFileSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs';
const data = JSON.parse(readFileSync('node_modules/@emoji-mart/data/sets/15/twitter.json'));
const coordinates = {};
for (const emoji of Object.values(data.emojis))
  for (const skin of emoji.skins) {
    coordinates[skin.native] = [skin.x, skin.y];
    coordinates[skin.native.replace(/\ufe0f/g, '')] = [skin.x, skin.y];
  }
mkdirSync('src/emoji', { recursive: true });
mkdirSync('public/emoji', { recursive: true });
writeFileSync('src/emoji/coordinates.json', JSON.stringify({ sheet: data.sheet, coordinates }));
copyFileSync(
  'node_modules/emoji-datasource-twitter/img/twitter/sheets-256/64.png',
  'public/emoji/twitter.png',
);
copyFileSync('node_modules/emoji-mart/LICENSE', 'public/emoji/emoji-mart-LICENSE.txt');
copyFileSync('node_modules/@emoji-mart/data/LICENSE', 'public/emoji/emoji-mart-data-LICENSE.txt');
copyFileSync(
  'node_modules/emoji-datasource-twitter/LICENSE',
  'public/emoji/emoji-datasource-LICENSE.txt',
);
writeFileSync(
  'public/emoji/ATTRIBUTION.txt',
  'Emoji picker: Emoji Mart / Missive (MIT).\nEmoji data/sprites: emoji-datasource-twitter 15.0.1.\nTwemoji graphics: Twitter and contributors, CC-BY 4.0.\nhttps://github.com/twitter/twemoji\nhttps://creativecommons.org/licenses/by/4.0/\n',
);
