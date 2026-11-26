// 增量抓新游戏并合并进 data/corpus.json（本地/CI 都能跑）
// 数据源：Valve 榜单（稳）+ 商店标签「最新发售」（更全，国内可能被 reset）
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dataPath, writeJson, readJson } from '../server/store.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const API = 'https://api.steampowered.com';
const STORE = 'https://store.steampowered.com';
const SHARED = 'https://shared.akamai.steamstatic.com/store_item_assets/';
const BATCH = 100;

const argv = process.argv.slice(2);
const LIMIT = Number((argv.find((a) => a.startsWith('--limit=')) || '').split('=')[1]) || 800;
const TAG_PAGES = Number((argv.find((a) => a.startsWith('--tags=')) || '').split('=')[1]) || 24;
const DRY = argv.includes('--dry');

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
      return (await res.text()).replace(/^\uFEFF/, '');
    } catch (e) {
      last = e;
      await sleep(700 * (i + 1));
    }
  }
  throw last;
}

function assetUrl(item, field) {
  const a = item?.assets;
  if (!a?.asset_url_format || !a[field]) return null;
  return `${SHARED}${a.asset_url_format.replace('${FILENAME}', a[field])}`;
}

function toRecord(item) {
  if (!item || item.success !== 1) return null;
  if (item.type !== undefined && item.type !== 0) return null;
  const id = Number(item.appid ?? item.id);
  if (!Number.isFinite(id)) return null;
  const tags = (item.tags ?? [])
    .filter((t) => t?.tagid)
    .slice(0, 20)
    .map((t) => ({ id: Number(t.tagid), w: Math.round(Number(t.weight) || 0) }));
  if (!tags.length) return null;
  const rev = item.reviews?.summary_filtered;
  const relTs = item.release?.steam_release_date ?? null;
  const price = item.best_purchase_option?.formatted_final_price ?? null;
  return {
    id,
    name: String(item.name || `App ${id}`).trim(),
    tags,
    rev: rev
      ? { total: Number(rev.review_count) || 0, pct: Number(rev.percent_positive) || 0, label: rev.review_score_label || null, score: Number(rev.review_score) || 0 }
      : null,
    year: relTs ? new Date(relTs * 1000).getUTCFullYear() : null,
    relTs,
    price,
    free: typeof price === 'string' && /免费|Free/i.test(price),
    header: assetUrl(item, 'header') ?? assetUrl(item, 'main_capsule'),
    cover: assetUrl(item, 'library_capsule') ?? assetUrl(item, 'hero_capsule'),
  };
}

async function getItems(ids, retries = 4) {
  const body = encodeURIComponent(
    JSON.stringify({
      ids: ids.map((appid) => ({ appid })),
      context: { language: 'schinese', country_code: 'CN' },
      data_request: { include_tag_count: 20, include_reviews: true, include_assets: true, include_release: true, include_basic_info: false },
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
    } catch {}
    await sleep(150);
  }
  return out;
}

async function fromCharts() {
  const ids = new Set();
  const add = (arr) => arr.forEach((x) => x?.appid && ids.add(Number(x.appid)));
  try {
    const j = JSON.parse(await jget(`${API}/ISteamChartsService/GetTopReleasesPages/v1/`));
    for (const p of j?.response?.pages ?? []) add(p.item_ids ?? []);
  } catch (e) {
    console.log('  [榜单] 新作榜失败:', e.message);
  }
  for (const ep of ['GetMostPlayedGames', 'GetGamesByConcurrentPlayers']) {
    try {
      const j = JSON.parse(await jget(`${API}/ISteamChartsService/${ep}/v1/`));
      add(j?.response?.ranks ?? []);
    } catch (e) {
      console.log(`  [榜单] ${ep} 失败:`, e.message);
    }
  }
  return ids;
}

async function fromTags(tagIds) {
  const ids = new Set();
  let failed = 0;
  let streak = 0;
  for (const tag of tagIds) {
    if (streak >= 4) {
      console.log('  [标签] 连续 4 次失败，判定商店域不可达，跳过剩余标签');
      break;
    }
    try {
      const url = `${STORE}/search/results/?query&start=0&count=100&sort_by=Released_DESC&tags=${tag}&infinite=1&l=schinese&cc=CN`;
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 9000); // 商店域常常不可达，别长等
      const res = await fetch(url, {
        signal: ctrl.signal,
        headers: { 'User-Agent': UA, Accept: 'application/json' },
      });
      clearTimeout(timer);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const html = JSON.parse((await res.text()).replace(/^\uFEFF/, ''))?.results_html ?? '';
      const re = /data-ds-appid="(\d+)"/g;
      let m;
      while ((m = re.exec(html))) ids.add(Number(m[1]));
      streak = 0;
    } catch {
      failed += 1;
      streak += 1;
    }
    await sleep(150);
  }
  if (failed) console.log(`  [标签] ${failed}/${tagIds.length} 个标签页取失败，不影响其它来源`);
  return ids;
}

async function main() {
  const t0 = Date.now();
  const corpus = await readJson(dataPath('corpus.json'), null);
  if (!corpus?.games) throw new Error('缺少 data/corpus.json');
  const games = corpus.games;
  const tagDict = corpus.tagDict || {};
  const before = Object.keys(games).length;

  // 热门标签（按语料里出现频次）
  const freq = new Map();
  for (const g of Object.values(games)) for (const t of g.tags ?? []) freq.set(t.id, (freq.get(t.id) || 0) + 1);
  const topTags = [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, TAG_PAGES).map(([id]) => id);

  console.log(`语料 ${before} 款 · 扫描榜单 + ${topTags.length} 个标签最新页…`);
  const cand = new Set();
  for (const id of await fromCharts()) cand.add(id);
  for (const id of await fromTags(topTags)) cand.add(id);

  const fresh = [...cand].filter((id) => !games[String(id)] && !games[id]);
  console.log(`候选 ${cand.size}，未收录 ${fresh.length}`);

  if (!fresh.length) {
    console.log('没有新游戏');
    return { added: 0, total: before };
  }
  if (DRY) {
    console.log('dry-run，前 10 个:', fresh.slice(0, 10).join(', '));
    return { added: 0, total: before, candidates: fresh.length };
  }

  const picked = fresh.slice(0, LIMIT);
  let added = 0;
  const newTagIds = new Set();
  for (let i = 0; i < picked.length; i += BATCH) {
    const chunk = picked.slice(i, i + BATCH);
    const items = await getItems(chunk);
    for (const it of items) {
      const rec = toRecord(it);
      if (!rec) continue;
      games[rec.id] = rec;
      added += 1;
      for (const t of rec.tags) if (!tagDict[t.id]) newTagIds.add(t.id);
    }
    process.stdout.write(`\r  取数 ${Math.min(i + BATCH, picked.length)}/${picked.length}，新增 ${added}`);
    await sleep(180);
  }
  console.log('');

  if (newTagIds.size) {
    const names = await resolveTagNames([...newTagIds]);
    for (const id of newTagIds) tagDict[id] = { zh: names[id] || `标签${id}`, en: '', count: 0 };
  }

  corpus.games = games;
  corpus.tagDict = tagDict;
  corpus.builtAt = new Date().toISOString();
  await writeJson(dataPath('corpus.json'), corpus);

  console.log(`完成：${before} → ${Object.keys(games).length}（新增 ${added}），用时 ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  return { added, total: Object.keys(games).length };
}

main().catch((e) => {
  console.error('同步失败:', e.message);
  process.exit(1);
});
