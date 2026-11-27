#!/usr/bin/env node
// 补齐「系统需求」与「宣传截图」：这两项只能逐款调 store 的 appdetails
// 由 GitHub Actions（海外）每天跑一批，渐进铺满；本地网络可能拿不到，会自动跳过
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GAMES = path.join(ROOT, 'data', 'games.json');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

const argv = process.argv.slice(2);
const LIMIT = Number((argv.find((a) => a.startsWith('--limit=')) || '').split('=')[1]) || 400;
const SHOTS = 5;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const stripHtml = (s) =>
  String(s || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\n· ')
    .replace(/<[^>]*>/g, '')
    .replace(/[\t ]+/g, ' ')
    .replace(/\n{2,}/g, '\n')
    .trim();

async function appdetails(appid) {
  const url = `https://store.steampowered.com/api/appdetails?appids=${appid}&l=schinese&cc=CN`;
  for (let i = 0; i < 2; i += 1) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 15000);
      const res = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': UA, Accept: 'application/json' } });
      clearTimeout(t);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const j = await res.json();
      const node = j?.[String(appid)];
      if (!node?.success) return null;
      return node.data;
    } catch {
      await sleep(500 * (i + 1));
    }
  }
  return null;
}

async function main() {
  const raw = JSON.parse(await fs.readFile(GAMES, 'utf8'));
  const games = raw.games;

  // 缺「系统需求」或「截图」的优先
  const todo = games.filter((r) => {
    const extra = r[11] || [];
    return !extra[2] || !extra[3];
  });
  console.log(`总 ${games.length} 款，缺系统需求/截图 ${todo.length} 款，本轮处理 ${Math.min(LIMIT, todo.length)}`);

  let filled = 0;
  for (const row of todo.slice(0, LIMIT)) {
    const id = row[0];
    const d = await appdetails(id);
    if (!d) {
      await sleep(250);
      continue;
    }
    const reqRaw = d.pc_requirements?.minimum || d.pc_requirements?.required || '';
    const req = stripHtml(reqRaw).slice(0, 700) || null;
    const shots = (d.screenshots || [])
      .map((s) => s.path_full || s.path_thumbnail)
      .filter(Boolean)
      .slice(0, SHOTS);
    const extra = Array.isArray(row[11]) ? row[11] : [null, null, null, null];
    while (extra.length < 4) extra.push(null);
    if (req) extra[2] = req;
    if (shots.length) extra[3] = shots;
    if (d.developers?.[0] && !extra[0]) extra[0] = d.developers[0];
    if (d.publishers?.[0] && !extra[1]) extra[1] = d.publishers[0];
    row[11] = extra;
    filled += 1;
    if (filled % 40 === 0) {
      await fs.writeFile(GAMES, JSON.stringify(raw), 'utf8');
      console.log(`  已补 ${filled}`);
    }
    await sleep(220);
  }

  await fs.writeFile(GAMES, JSON.stringify(raw), 'utf8');
  const withReq = games.filter((r) => r[11]?.[2]).length;
  const withShots = games.filter((r) => r[11]?.[3]).length;
  console.log(`完成：本轮补 ${filled} 款 · 累计有系统需求 ${withReq} · 有截图 ${withShots}`);
}

main().catch((e) => {
  console.error('补全失败:', e.message);
  process.exit(1);
});
