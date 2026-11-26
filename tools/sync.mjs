#!/usr/bin/env node
// 增量同步：找出近年新上架、但语料里还没有的游戏，补进 data/games.json
// 由 .github/workflows/update.yml 每天定时调用（GitHub 的机器在海外，商店页可达）
//
// 数据源 A（稳）：api.steampowered.com 的榜单接口 —— 新作榜 + 在线榜
// 数据源 B（丰）：store.steampowered.com 按标签取「最新发售」第 1 页
// 两者取并集，再用 IStoreBrowseService/GetItems 批量补全标签/好评率/发售日

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GAMES = path.join(ROOT, 'data', 'games.json');
const VERSION = path.join(ROOT, 'data', 'version.json');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const API = 'https://api.steampowered.com';
const STORE = 'https://store.steampowered.com';
const BATCH = 100;

const argv = process.argv.slice(2);
const LIMIT = Number((argv.find((a) => a.startsWith('--limit=')) || '').split('=')[1]) || 1200;
const DRY = argv.includes('--dry');
const TAG_PAGES = Number((argv.find((a) => a.startsWith('--tags=')) || '').split('=')[1]) || 26;
const PAGES_PER_TAG = Number((argv.find((a) => a.startsWith('--pages=')) || '').split('=')[1]) || 1;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function jget(url, retries = 3) {
  let last;
  for (let i = 0; i <= retries; i += 1) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 30000);
      const res = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': UA, Accept: 'application/json,text/html' } });
      clearTimeout(t);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      return text.replace(/^\uFEFF/, '');
    } catch (e) {
      last = e;
      await sleep(800 * (i + 1));
    }
  }
  throw last;
}

/** Valve 商店批量取数 */
async function getItems(ids, retries = 4) {
  const body = encodeURIComponent(
    JSON.stringify({
      ids: ids.map((appid) => ({ appid })),
      context: { language: 'schinese', country_code: 'CN' },
      data_request: {
        include_tag_count: 20,
        include_reviews: true,
        include_assets: false,
        include_release: true,
        include_basic_info: true,
        include_platforms: false,
      },
    })
  );
  const text = await jget(`${API}/IStoreBrowseService/GetItems/v1/?input_json=${body}`, retries);
  try {
    return JSON.parse(text)?.response?.store_items ?? [];
  } catch {
    return [];
  }
}

async function resolveTagNames(ids) {
  const out = {};
  for (let i = 0; i < ids.length; i += BATCH) {
    const chunk = ids.slice(i, i + BATCH);
    try {
      const body = encodeURIComponent(
        JSON.stringify({ ids: chunk.map((tagid) => ({ tagid })), context: { language: 'schinese', country_code: 'CN' }, data_request: { include_tag_count: 1 } })
      );
      const items = JSON.parse(await jget(`${API}/IStoreBrowseService/GetItems/v1/?input_json=${body}`, 3))?.response?.store_items ?? [];
      for (const it of items) if (it?.item_type === 4 && it.name) out[it.id] = it.name;
    } catch {
      /* 标签名缺失不致命 */
    }
    await sleep(150);
  }
  return out;
}

// ---------- 数据源 A：榜单 ----------
async function fromCharts() {
  const ids = new Set();
  const add = (arr) => arr.forEach((x) => x?.appid && ids.add(Number(x.appid)));
  try {
    const j = JSON.parse(await jget(`${API}/ISteamChartsService/GetTopReleasesPages/v1/`));
    for (const p of j?.response?.pages ?? []) add(p.item_ids ?? []);
  } catch (e) {
    console.log('  [A] 新作榜失败:', e.message);
  }
  for (const ep of ['GetMostPlayedGames', 'GetGamesByConcurrentPlayers']) {
    try {
      const j = JSON.parse(await jget(`${API}/ISteamChartsService/${ep}/v1/`));
      add(j?.response?.ranks ?? []);
    } catch (e) {
      console.log(`  [A] ${ep} 失败:`, e.message);
    }
  }
  return ids;
}

// ---------- 数据源 B：标签最新发售页（可多页） ----------
async function fromTags(tagIds, pages = 1) {
  const ids = new Set();
  let failed = 0;
  for (const tag of tagIds) {
    for (let page = 0; page < pages; page += 1) {
      try {
        const url = `${STORE}/search/results/?query&start=${page * 100}&count=100&sort_by=Released_DESC&tags=${tag}&infinite=1&l=schinese&cc=CN`;
        const text = await jget(url, 2);
        const html = JSON.parse(text)?.results_html ?? '';
        const re = /data-ds-appid="(\d+)"/g;
        let m;
        while ((m = re.exec(html))) ids.add(Number(m[1]));
        if (!html) break;
      } catch {
        failed += 1;
        break;
      }
      await sleep(200);
    }
  }
  if (failed) console.log(`  [标签] ${failed} 次请求失败，不影响其它来源`);
  return ids;
}

function stripTags(html) {
  return String(html || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

async function main() {
  const t0 = Date.now();
  const raw = JSON.parse(await fs.readFile(GAMES, 'utf8'));
  const games = raw.games;
  const existing = new Set(games.map((g) => g[0]));
  const tagDict = raw.tagDict || {};
  const labels = raw.labels || [''];

  console.log(`现有 ${games.length} 款 / ${Object.keys(tagDict).length} 标签，目标最多新增 ${LIMIT} 款`);

  // 取出现频次最高的标签，用来扫「最新发售」
  const freq = new Map();
  for (const row of games) for (const t of row[2] || []) freq.set(t[0], (freq.get(t[0]) || 0) + 1);
  const topTags = [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, TAG_PAGES).map(([id]) => id);

  console.log(`扫描榜单 + ${topTags.length} 个标签的最新发售页…`);
  const cand = new Set();
  for (const id of await fromCharts()) cand.add(id);
  for (const id of await fromTags(topTags, PAGES_PER_TAG)) cand.add(id);

  const fresh = [...cand].filter((id) => !existing.has(id));
  console.log(`候选 ${cand.size} 个，其中未收录 ${fresh.length} 个`);

  if (DRY) {
    console.log('dry-run，不写文件。前 12 个 appid:', fresh.slice(0, 12).join(', '));
    return;
  }
  if (!fresh.length) {
    console.log('没有新游戏，结束');
    return;
  }

  const picked = fresh.slice(0, LIMIT);
  const newLabelIdx = new Map(labels.map((l, i) => [l, i]));
  const added = [];
  const newTagIds = new Set();

  for (let i = 0; i < picked.length; i += BATCH) {
    const chunk = picked.slice(i, i + BATCH);
    const items = await getItems(chunk);
    for (const it of items) {
      if (it?.success !== 1 || (it.type !== undefined && it.type !== 0)) continue;
      const tags = (it.tags ?? []).filter((t) => t?.tagid).slice(0, 20).map((t) => [Number(t.tagid), Math.round(Number(t.weight) || 0)]);
      if (!tags.length) continue;
      const rev = it.reviews?.summary_filtered;
      const rel = it.release?.steam_release_date;
      const price = it.best_purchase_option?.formatted_final_price ?? null;
      let label = rev?.review_score_label || '';
      if (!newLabelIdx.has(label)) {
        newLabelIdx.set(label, labels.length);
        labels.push(label);
      }
      added.push([
        Number(it.appid),
        String(it.name || `App ${it.appid}`).trim(),
        tags,
        Number(rev?.review_count) || 0,
        Number(rev?.percent_positive) || 0,
        newLabelIdx.get(label) || 0,
        rel ? new Date(rel * 1000).getUTCFullYear() : null,
        price,
        typeof price === 'string' && /免费|Free/i.test(price) ? 1 : 0,
        null,
        (String(it.basic_info?.short_description || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim() || '').slice(0, 220) || null,
      ]);
      for (const [tid] of tags) if (!tagDict[tid]) newTagIds.add(tid);
    }
    console.log(`  取数 ${Math.min(i + BATCH, picked.length)}/${picked.length}，已通过 ${added.length}`);
    await sleep(200);
  }

  if (newTagIds.size) {
    const names = await resolveTagNames([...newTagIds]);
    for (const [id, name] of Object.entries(names)) tagDict[id] = name;
    for (const id of newTagIds) if (!tagDict[id]) tagDict[id] = `标签${id}`;
  }

  const merged = [...games, ...added].sort((a, b) => (b[3] || 0) - (a[3] || 0));
  const payload = {
    built: new Date().toISOString().slice(0, 10),
    tagDict,
    labels,
    games: merged,
  };
  await fs.writeFile(GAMES, JSON.stringify(payload), 'utf8');
  const size = (await fs.stat(GAMES)).size;
  await fs.writeFile(
    VERSION,
    JSON.stringify({ v: `${payload.built}-${merged.length}-${size}`, built: payload.built, count: merged.length, tags: Object.keys(tagDict).length, bytes: size }),
    'utf8'
  );

  // ---- 更新日志：data/changelog.json + CHANGELOG.md ----
  const stamp = new Date().toISOString().slice(0, 10);
  let log = [];
  try {
    log = JSON.parse(await fs.readFile(path.join(ROOT, 'data', 'changelog.json'), 'utf8'));
  } catch {
    log = [];
  }
  log.unshift({
    date: stamp,
    added: added.length,
    total: merged.length,
    tags: Object.keys(tagDict).length,
  });
  log = log.slice(0, 200);
  await fs.writeFile(path.join(ROOT, 'data', 'changelog.json'), JSON.stringify(log, null, 1), 'utf8');

  const md = [
    '# 更新日志',
    '',
    '> 每次自动更新都会在这里追加一行（新游戏入库后立刻可搜、可当相似种子）。',
    '',
    '| 日期 | 新增 | 语料总量 | 标签 |',
    '| --- | --- | --- | --- |',
    ...log.map((e) => `| ${e.date} | +${e.added} | ${e.total} | ${e.tags} |`),
    '',
  ].join('\n');
  await fs.writeFile(path.join(ROOT, 'CHANGELOG.md'), md, 'utf8');
  console.log(`完成：${games.length} → ${merged.length}（新增 ${added.length} 款，新标签 ${Object.keys(tagDict).length - Object.keys(raw.tagDict || {}).length} 个），用时 ${((Date.now() - t0) / 1000).toFixed(0)}s`);
}

main().catch((e) => {
  console.error('同步失败:', e);
  process.exit(1);
});
