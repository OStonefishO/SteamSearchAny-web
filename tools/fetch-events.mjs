#!/usr/bin/env node
// 抓 Steam 当下的「现场」：特惠 / 新上架 / 即将推出，写进 data/events.json
// 数据源：store.steampowered.com/api/featuredcategories（促销季、新品节期间内容会随之变化）
// 只能在海外网络跑通，所以由 GitHub Actions 每天执行
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'data', 'events.json');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function jget(url, retries = 3) {
  let last;
  for (let i = 0; i <= retries; i += 1) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 20000);
      const res = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': UA, Accept: 'application/json' } });
      clearTimeout(t);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return JSON.parse((await res.text()).replace(/^\uFEFF/, ''));
    } catch (e) {
      last = e;
      await sleep(800 * (i + 1));
    }
  }
  throw last;
}

const mapItem = (it) => ({
  id: Number(it.id),
  name: String(it.name || '').trim(),
  discount: Number(it.discount_percent) || 0,
  final: it.final_price ?? null,
  original: it.original_price ?? null,
  currency: it.currency || 'CNY',
  header: it.header_image || it.large_capsule_image || null,
  platforms: it.platforms || null,
});

async function main() {
  const now = new Date();
  const out = {
    built: now.toISOString(),
    cc: 'CN',
    sections: {},
    sales: [],
  };

  // 1) 特惠 / 新上架 / 即将推出
  const fc = await jget('https://store.steampowered.com/api/featuredcategories?l=schinese&cc=CN');
  const take = (node, n) => (node?.items || []).slice(0, n).map(mapItem).filter((x) => x.id);

  out.sections.specials = take(fc.specials, 40);
  out.sections.newReleases = take(fc.new_releases, 40);
  out.sections.comingSoon = take(fc.coming_soon, 30);
  out.sections.topSellers = take(fc.top_sellers, 30);

  // 2) 正在进行的促销活动（季促 / 厂商周常在这里以 specials 的 v2 结构出现）
  try {
    const feat = await jget('https://store.steampowered.com/api/featured?l=schinese&cc=CN');
    const big = [...(feat.large_capsules || []), ...(feat.featured_win || [])]
      .map((x) => ({ id: Number(x.id), name: String(x.name || '').trim(), header: x.large_capsule_image || x.header_image || null }))
      .filter((x) => x.id && x.name);
    const seen = new Set();
    out.sales = big.filter((x) => (seen.has(x.id) ? false : (seen.add(x.id), true))).slice(0, 12);
  } catch (e) {
    console.log('featured 失败（不影响主体）:', e.message);
  }

  await fs.mkdir(path.dirname(OUT), { recursive: true });
  await fs.writeFile(OUT, JSON.stringify(out), 'utf8');
  const size = (await fs.stat(OUT)).size;
  console.log(
    `events.json：特惠 ${out.sections.specials.length} · 新上架 ${out.sections.newReleases.length} · 即将推出 ${out.sections.comingSoon.length} · 热销 ${out.sections.topSellers.length} · 活动 ${out.sales.length}（${(size / 1024).toFixed(1)} KB）`
  );
}

main().catch((e) => {
  console.error('抓取失败:', e.message);
  process.exit(1);
});
