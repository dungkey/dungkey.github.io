// 扫描本目录的音频文件，生成 tracks.js 清单。
// 用法：node music/scan.mjs
//
// file:// 直接打开 index.html 时需要它：浏览器不允许网页列目录。
// 本地 http 开发时页面会解析目录；GitHub Pages 等静态托管则读取这份清单。

import { readdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const dir = new URL('./', import.meta.url);
const AUDIO = /\.(flac|mp3|m4a|aac|ogg|oga|opus|wav|webm)$/i;

// 和页面里的 sortTracks 保持同一套规则（zh-CN + numeric）
const collate = new Intl.Collator('zh-CN', { numeric: true });
const files = (await readdir(dir))
  .filter((name) => AUDIO.test(name))
  .sort(collate.compare);

const body = [
  '/* 由 scan.mjs 生成，勿手改：node music/scan.mjs */',
  'window.__MUSIC__ = ' + JSON.stringify(files, null, 2) + ';',
  '',
].join('\n');

const out = new URL('tracks.js', dir);
await writeFile(out, body, 'utf8');
console.log(`${files.length} 首 -> ${fileURLToPath(out)}`);
