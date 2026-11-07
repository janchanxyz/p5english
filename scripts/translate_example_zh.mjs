#!/usr/bin/env node
/**
 * Batch-translate example → exampleZh via POST /api/example-zh
 * Usage: node scripts/translate_example_zh.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DATA = path.join(ROOT, 'src', 'words-data.json');
const REPORT = path.join(ROOT, 'scripts', 'example-zh-report.json');

const BASE = process.env.BASE_URL || 'https://p5english.chanplanet.workers.dev';
const SECRET = process.env.ZH_SECRET || 'p4-example-zh-2026';
const BATCH = Number(process.env.BATCH || 8);
const CONCURRENCY = Number(process.env.CONCURRENCY || 3);
const RETRIES = 4;

const SIMPLIFIED_TELLTALES =
  '国发这说时对还会来开关车门动书语长马风东为个从问见现点经应实学爱听买卖飞观农乐传优儿兰兴兽册写军冲决况冻净凭凯击凿刚创剂剑剧劝办务励劲劳势医华协单卖厅历压厌厨县参叠叶号吨启员团园围图圆坝坟坠垦垫墙壳壶处备复头夹夺奋奖妆妇妈孙宁宝宠审宪宫宽寝寻导寿尔尘尝层屿岁岂岗岚岛岭峦弃异庆庐库开录归彻径忆忧态总恋恳恶恼悬悯惯愤慑惨惭慎慧慨懂懒戏战户扑执扩扫扬扰报抛抠抡抢护抵担拆拢拣拥拦拧拨择挂挠挡挣挤挥捞损捡换捣据掳掷掸掺揉扬揽搀搁搂搅摄摆摇摈摊撵敌敛数斋斩无旧旷显晖暂暧术机杀杂权杨杰极构枫栏树栖样桥桦桧桨桩检栈栋枪电脑气钱银铁铜钢铅锡镇钟铃锤镜链锁钥闪闭问闲间闯闻阁阅队阶阳阴陆陈险随隐雾电';

function looksSimplified(zh) {
  const s = String(zh || '').trim();
  if (!s || s.length > 80) return true;
  if (/[A-Za-z]{3,}/.test(s)) return true;
  for (const ch of s) {
    if (SIMPLIFIED_TELLTALES.includes(ch)) return true;
  }
  return false;
}

function validZh(zh) {
  const s = String(zh || '').trim();
  if (!s || s.length < 2 || s.length > 80) return false;
  if (!/[\u4e00-\u9fff]/.test(s)) return false;
  if (looksSimplified(s)) return false;
  return true;
}

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function postBatch(items) {
  let lastErr = null;
  for (let attempt = 0; attempt < RETRIES; attempt++) {
    try {
      const res = await fetch(`${BASE}/api/example-zh`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-P5-Admin': SECRET,
        },
        body: JSON.stringify({ items }),
      });
      const text = await res.text();
      let json;
      try {
        json = JSON.parse(text);
      } catch {
        throw new Error(`non-JSON ${res.status}: ${text.slice(0, 200)}`);
      }
      if (!res.ok || !json.ok) {
        throw new Error(`HTTP ${res.status}: ${json.error || text.slice(0, 200)}`);
      }
      return json;
    } catch (err) {
      lastErr = err;
      await sleep(700 * (attempt + 1) * (attempt + 1));
    }
  }
  throw lastErr;
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function mapPool(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return results;
}

async function main() {
  const words = JSON.parse(fs.readFileSync(DATA, 'utf8'));
  if (!Array.isArray(words)) throw new Error('words-data.json must be an array');
  console.log(`Loaded ${words.length} words → ${BASE}`);

  const need = words.filter((w) => w.example && !validZh(w.exampleZh));
  console.log(`Need translation: ${need.length}`);

  const map = {};
  // keep already-good ones
  for (const w of words) {
    if (validZh(w.exampleZh)) map[w.word] = w.exampleZh.trim();
  }

  const batches = chunk(
    need.map((w) => ({ word: w.word, example: w.example })),
    BATCH,
  );
  let modelUsed = '';

  await mapPool(batches, CONCURRENCY, async (batch, idx) => {
    try {
      const json = await postBatch(batch);
      if (json.model) modelUsed = json.model;
      const got = json.translations || {};
      let hit = 0;
      for (const item of batch) {
        const zh = got[item.word];
        if (validZh(zh)) {
          map[item.word] = String(zh).trim();
          hit++;
        }
      }
      console.log(`[batch ${idx + 1}/${batches.length}] ok ${hit}/${batch.length}`);
    } catch (err) {
      console.error(`[batch ${idx + 1}/${batches.length}] FAIL`, err.message || err);
    }
  });

  // retry missing one-by-one
  const missing = need.filter((w) => !map[w.word]);
  if (missing.length) {
    console.log(`Retrying ${missing.length} missing…`);
    await mapPool(
      missing.map((m) => [{ word: m.word, example: m.example }]),
      CONCURRENCY,
      async (batch) => {
        try {
          const json = await postBatch(batch);
          if (json.model) modelUsed = json.model;
          const w = batch[0].word;
          const zh = json.translations?.[w];
          if (validZh(zh)) map[w] = String(zh).trim();
        } catch (err) {
          console.error(`  fail ${batch[0].word}:`, err.message || err);
        }
      },
    );
  }

  let filled = 0;
  const samples = [];
  const failures = [];
  for (const w of words) {
    if (map[w.word]) {
      w.exampleZh = map[w.word];
      filled++;
      if (samples.length < 20) {
        samples.push({ word: w.word, example: w.example, exampleZh: w.exampleZh });
      }
    } else {
      w.exampleZh = w.exampleZh || '';
      failures.push({ word: w.word, example: w.example });
    }
  }

  fs.writeFileSync(DATA, JSON.stringify(words, null, 2) + '\n');
  const report = {
    at: new Date().toISOString(),
    base: BASE,
    model: modelUsed,
    total: words.length,
    filled,
    failures,
    samples,
  };
  fs.writeFileSync(REPORT, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ model: modelUsed, filled, failures: failures.length, samples: samples.slice(0, 8), report: REPORT }, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
