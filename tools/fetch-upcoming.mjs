#!/usr/bin/env node
// 抓「即将上线」+ 带 Demo 的游戏，写进 data/upcoming.json（前端「探索游戏 → 即将上线」用）
// 数据源：store.steampowered.com/search/results 的 infinite=1 JSON 接口
//   - filter=comingsoon：还没发售、能加愿望单的
//   - filter=demos：带试玩版的（含已发售的，用 soon 字段区分）
// 只能在海外网络跑通，所以由 GitHub Actions 定时执行
//
// 用法：node tools/fetch-upcoming.mjs [--pages=5] [--count=100]
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'data', 'upcoming.json');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

const argv = process.argv.slice(2);
const PAGES = Number((argv.find((a) => a.startsWith('--pages=')) || '').split('=')[1]) || 5;
const COUNT = Math.min(100, Number((argv.find((a) => a.startsWith('--count=')) || '').split('=')[1]) || 100);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function jget(url, retries = 3) {
  let last;
  for (let i = 0; i <= retries; i += 1) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 25000);
      const res = await fetch(url, {
        signal: ctrl.signal,
        headers: { 'User-Agent': UA, Accept: 'application/json, text/javascript, */*; q=0.01' },
      });
      clearTimeout(t);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return JSON.parse((await res.text()).replace(/^\uFEFF/, ''));
    } catch (e) {
      last = e;
      await sleep(900 * (i + 1));
    }
  }
  throw last;
}

const decodeEntities = (s) =>
  String(s || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'");

/** 把 Steam 的中文发售日期串转成 2026-03 / 2026 这种可排序的键 */
function releaseKey(text) {
  const s = String(text || '');
  const full = s.match(/(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/);
  if (full) return `${full[1]}-${String(full[2]).padStart(2, '0')}-${String(full[3]).padStart(2, '0')}`;
  const ym = s.match(/(\d{4})\s*年\s*(\d{1,2})\s*月/);
  if (ym) return `${ym[1]}-${String(ym[2]).padStart(2, '0')}`;
  const y = s.match(/(\d{4})/);
  if (y) return y[1];
  return null;
}

function parseRows(html) {
  const out = [];
  const chunks = String(html || '').split('<a ').slice(1);
  for (const chunk of chunks) {
    const open = chunk.slice(0, chunk.indexOf('>') + 1);
    const body = chunk.slice(chunk.indexOf('>') + 1, chunk.indexOf('</a>') >= 0 ? chunk.indexOf('</a>') : chunk.length);
    const idm = open.match(/data-ds-appid="(\d+)"/);
    if (!idm) continue;
    const id = Number(idm[1]);
    if (!id) continue;

    const nameM = body.match(/<span class="title">([\s\S]*?)<\/span>/);
    // 新版搜索页的 class 没有 col 前缀，这里都用宽松匹配
    const relM = body.match(/<div class="search_released[^"]*">([\s\S]*?)<\/div>/);
    const priceM =
      body.match(/<div class="discount_final_price">([\s\S]*?)<\/div>/) ||
      body.match(/<div class="search_price[^"]*">([\s\S]*?)<\/div>/);

    const name = decodeEntities(nameM ? nameM[1] : '').trim();
    if (!name) continue;

    const release = decodeEntities(relM ? relM[1].replace(/<[^>]+>/g, '') : '').trim();
    const price = decodeEntities((priceM ? priceM[1] : '').replace(/<[^>]+>/g, '')).trim();

    out.push({
      id,
      name,
      release: release || null,
      key: releaseKey(release),
      price: price || null,
      // 统一用 header.jpg，比搜索页那份 capsule_231x87 清楚
      header: `https://cdn.akamai.steamstatic.com/steam/apps/${id}/header.jpg`,
    });
  }
  return out;
}

async function fetchSearch({ filter, sortBy, pages, note }) {
  const rows = [];
  for (let p = 0; p < pages; p += 1) {
    const start = p * COUNT;
    const url =
      'https://store.steampowered.com/search/results/?query&start=' + start +
      '&count=' + COUNT + '&dynamic_data=&sort_by=' + encodeURIComponent(sortBy) +
      '&specials=0&filter=' + filter + '&infinite=1&cc=CN&l=schinese';
    try {
      const data = await jget(url);
      const got = parseRows(data.results_html);
      rows.push(...got);
      console.log(`  ${note} 第 ${p + 1}/${pages} 页：${got.length} 条（累计 ${rows.length}）`);
      if (got.length < COUNT / 2) break; // 翻到底了
    } catch (e) {
      console.log(`  ${note} 第 ${p + 1} 页失败：${e.message}`);
    }
    await sleep(600);
  }
  return rows;
}

/** 批量补类型标签 + 精确发售日（appdetails 一次最多几十个 appid） */
async function enrichGenres(items) {
  const ids = items.map((x) => x.id);
  const chunks = [];
  for (let i = 0; i < ids.length; i += 40) chunks.push(ids.slice(i, i + 40));
  const info = new Map();
  for (let i = 0; i < chunks.length; i += 1) {
    const url =
      'https://store.steampowered.com/api/appdetails?appids=' + chunks[i].join(',') + '&l=schinese&cc=CN';
    try {
      const data = await jget(url);
      for (const [id, node] of Object.entries(data || {})) {
        if (!node || !node.success || !node.data) continue;
        const d = node.data;
        const genres = (d.genres || []).map((g) => String(g.description || '').trim()).filter(Boolean);
        const rd = d.release_date || {};
        info.set(Number(id), {
          genres: genres.slice(0, 3),
          release: rd.coming_soon ? rd.date || null : rd.date || null,
          free: !!d.is_free,
        });
      }
      console.log(`  appdetails ${i + 1}/${chunks.length} 批：已补 ${info.size} 条`);
    } catch (e) {
      console.log(`  appdetails 第 ${i + 1} 批失败：${e.message}`);
    }
    await sleep(700);
  }
  for (const it of items) {
    const extra = info.get(it.id);
    if (!extra) continue;
    if (extra.genres.length) it.genres = extra.genres;
    if (extra.release && /^\d{4}/.test(extra.release)) {
      it.release = extra.release;
      it.key = releaseKey(extra.release) || it.key;
    }
    if (extra.free) it.price = '免费';
  }
  return items;
}

async function main() {
  const now = new Date();
  const soonRows = await fetchSearch({
    filter: 'comingsoon',
    sortBy: 'Released_ASC',
    pages: PAGES,
    note: '即将发售',
  });
  const demoRows = await fetchSearch({
    filter: 'demos',
    sortBy: 'Released_DESC',
    pages: Math.max(2, Math.ceil(PAGES / 2)),
    note: '带 Demo',
  });

  const map = new Map();
  const put = (row, patch) => {
    const cur = map.get(row.id) || { id: row.id, name: row.name, release: null, key: null, price: null, header: null, demo: false, soon: false };
    map.set(row.id, {
      ...cur,
      name: row.name || cur.name,
      release: row.release || cur.release,
      key: row.key || cur.key,
      price: row.price || cur.price,
      header: row.header || cur.header,
      ...patch,
    });
  };

  const today = now.toISOString().slice(0, 10);
  const curMonth = today.slice(0, 7);
  const isDemoName = (n) => /试玩版|试玩$|Demo$|Playtest/i.test(String(n || ''));
  // 原声带 / 设定集 / 扩展包 这些不是游戏本体，别混进榜单
  const isJunk = (n) => /soundtrack|原声带|原声集|\bost\b|artbook|art book|设定集|画集|壁纸|扩展包|资料片|季票|通行证|额外奖励|season pass|bundle/i.test(String(n || ''));
  const isFuture = (key) => {
    if (!key) return false;
    if (key.length >= 10) return key >= today;
    if (key.length === 7) return key > curMonth;
    return false;
  };

  for (const r of soonRows) {
    if (isDemoName(r.name) || isJunk(r.name)) continue; // 试玩版归到「带 Demo」那一栏
    put(r, { soon: true });
  }
  for (const r of demoRows) {
    if (isJunk(r.name)) continue;
    put(r, { demo: true, soon: isFuture(r.key) });
  }

  const items = [...map.values()]
    .filter((x) => x.soon || x.demo)
    .sort((a, b) => {
      const ka = a.soon ? a.key || '9999' : '9999-99';
      const kb = b.soon ? b.key || '9999' : '9999-99';
      if (ka !== kb) return ka < kb ? -1 : 1;
      return a.name.localeCompare(b.name, 'zh');
    });

  const out = {
    built: now.toISOString(),
    cc: 'CN',
    pages: PAGES,
    counts: { soon: items.filter((x) => x.soon).length, demo: items.filter((x) => x.demo).length },
    items,
  };

  // 补类型标签（用于「即将上线」页的类型筛选）
  await enrichGenres(out.items);
  const genreCount = new Map();
  for (const it of out.items) for (const g of it.genres || []) genreCount.set(g, (genreCount.get(g) || 0) + 1);
  out.genres = [...genreCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 16).map(([name, n]) => ({ name, n }));

  await fs.mkdir(path.dirname(OUT), { recursive: true });
  await fs.writeFile(OUT, JSON.stringify(out), 'utf8');
  const size = (await fs.stat(OUT)).size;
  console.log(
    `upcoming.json：即将发售 ${out.counts.soon} · 带 Demo ${out.counts.demo}（共 ${items.length} 条，${(size / 1024).toFixed(1)} KB）`
  );
}

main().catch((e) => {
  console.error('抓取失败:', e.message);
  process.exit(1);
});
