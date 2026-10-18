// 扫描本目录的音频文件，生成 tracks.js 清单。
// 用法：node music/scan.mjs
//
// 只在 file:// 直接打开 index.html 时需要它：浏览器不允许网页列目录，
// 所以清单得先落到磁盘上。用 http 打开时页面会自己解析目录，不读这个文件。

import { readdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const dir = new URL('./', import.meta.url);
const AUDIO = /\.(flac|mp3|m4a|aac|ogg|oga|opus|wav|webm)$/i;

// 和页面里的排序保持同一套规则（按码位），换机器、换 locale 顺序都不变
const files = (await readdir(dir))
  .filter((name) => AUDIO.test(name))
  .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

const body = [
  '/* 由 scan.mjs 生成，勿手改：node music/scan.mjs */',
  'window.__MUSIC__ = ' + JSON.stringify(files, null, 2) + ';',
  '',
].join('\n');

const out = new URL('tracks.js', dir);
await writeFile(out, body, 'utf8');
console.log(`${files.length} 首 -> ${fileURLToPath(out)}`);
