#!/usr/bin/env node
/**
 * One-shot: retranslate `zh` + generate `example` via POST /api/zh-gloss
 * Usage: node scripts/retranslate_zh.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DATA = path.join(ROOT, 'src', 'words-data.json');
const BACKUP = path.join(ROOT, 'scripts', 'words-data.zh-backup.json');
const REPORT = path.join(ROOT, 'scripts', 'zh-retranslate-report.json');

const BASE = process.env.BASE_URL || 'https://p5english.chanplanet.workers.dev';
const SECRET = process.env.ZH_SECRET || 'p4-zh-retranslate-2026';
const BATCH = Number(process.env.BATCH || 8);
const CONCURRENCY = Number(process.env.CONCURRENCY || 3);
const RETRIES = 3;

const SIMPLIFIED_TELLTALES =
  '国发这说时对还会来开关车门动书语长马风东为个从问见现点经应实学爱听买卖飞观农乐传优儿兰兴兽册写军冲决况冻净凭凯击凿刚创剂剑剧劝办务励劲劳势医华协单卖厅历压厌厨县参叠叶号吨启员团园围图圆坝坟坠垦垫墙壳壶处备复头夹夺奋奖妆妇妈孙宁宝宠审宪宫宽寝寻导寿尔尘尝层屿岁岂岗岚岛岭峦弃异庆庐库开录归彻径忆忧态总恋恳恶恼悬悯惯愤慑惨惭慎慧慨懂懒戏战户扑执扩扫扬扰报抛抠抡抢护抵担拆拢拣拥拦拧拨择挂挠挡挣挤挥捞损捡换捣据掳掷掸掺揉扬揽搀搁搂搅摄摆摇摈摊撵敌敛数斋斩无旧旷显晖暂暧术机杀杂权杨杰极构枫栏树栖样桥桦桧桨桩检栈栋枪电脑气钱银铁铜钢铅锡镇钟铃锤镜链锁钥闪闭问闲间闯闻阁阅队阶阳阴陆陈险随隐雾电';

function looksSimplified(zh) {
  const s = String(zh || '').trim();
  if (!s || s.length > 16) return true;
  if (/[A-Za-z0-9]/.test(s)) return true;
  for (const ch of s) {
    if (SIMPLIFIED_TELLTALES.includes(ch)) return true;
  }
  return false;
}

function validExample(example, word) {
  const s = String(example || '').trim();
  if (!s || s.length < 6 || s.length > 120) return false;
  const re = new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
  return re.test(s) && !/[\u4e00-\u9fff]/.test(s);
}

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function postBatch(words) {
  let lastErr = null;
  for (let attempt = 0; attempt < RETRIES; attempt++) {
    try {
      const res = await fetch(`${BASE}/api/zh-gloss`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-P5-Admin': SECRET,
        },
        body: JSON.stringify({ words }),
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
      await sleep(600 * (attempt + 1) * (attempt + 1));
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
  if (!fs.existsSync(BACKUP)) {
    fs.writeFileSync(BACKUP, JSON.stringify(words, null, 2));
    console.log(`Backup → ${BACKUP}`);
  } else {
    console.log(`Keeping existing backup ${BACKUP}`);
  }
  console.log(`Loaded ${words.length} words`);
  console.log(`Target ${BASE} batch=${BATCH} concurrency=${CONCURRENCY}`);

  const before = Object.fromEntries(words.map((w) => [w.word, { zh: w.zh, example: w.example || '' }]));
  const payloads = words.map((w) => ({ word: w.word, pos: w.pos, theme: w.theme }));
  const batches = chunk(payloads, BATCH);

  const entryMap = {};
  let modelUsed = '';

  await mapPool(batches, CONCURRENCY, async (batch, idx) => {
    try {
      const json = await postBatch(batch);
      if (json.model) modelUsed = json.model;
      const got = json.entries || {};
      // also support legacy { zh: {word: "..."} }
      let hit = 0;
      for (const item of batch) {
        let zh = '';
        let example = '';
        const e = got[item.word];
        if (e && typeof e === 'object') {
          zh = e.zh || '';
          example = e.example || '';
        } else if (typeof e === 'string') {
          zh = e;
        } else if (json.zh && typeof json.zh[item.word] === 'string') {
          zh = json.zh[item.word];
        }
        if (typeof json.zh === 'string' && json.word === item.word) zh = json.zh;
        if (json.example && json.word === item.word) example = json.example;

        if (zh && !looksSimplified(zh)) {
          entryMap[item.word] = {
            zh,
            example: validExample(example, item.word) ? example : '',
          };
          hit++;
        }
      }
      console.log(`[batch ${idx + 1}/${batches.length}] ok ${hit}/${batch.length} model=${json.model || '?'}`);
    } catch (err) {
      console.error(`[batch ${idx + 1}/${batches.length}] FAIL`, err.message || err);
    }
  });

  const missing = words.filter((w) => !entryMap[w.word]).map((w) => ({
    word: w.word,
    pos: w.pos,
    theme: w.theme,
  }));
  if (missing.length) {
    console.log(`Retrying ${missing.length} missing one-by-one…`);
    await mapPool(
      missing.map((m) => [m]),
      CONCURRENCY,
      async (batch) => {
        try {
          const json = await postBatch(batch);
          if (json.model) modelUsed = json.model;
          const w = batch[0].word;
          let zh = '';
          let example = '';
          if (json.entries && json.entries[w]) {
            zh = json.entries[w].zh;
            example = json.entries[w].example || '';
          } else if (json.zh) {
            zh = typeof json.zh === 'string' ? json.zh : json.zh[w];
            example = json.example || '';
          }
          if (zh && !looksSimplified(zh)) {
            entryMap[w] = {
              zh,
              example: validExample(example, w) ? example : '',
            };
          }
        } catch (err) {
          console.error(`  single fail ${batch[0].word}:`, err.message || err);
        }
      },
    );
  }

  // Second pass for missing examples only (words that have zh but no example)
  const needEx = words
    .filter((w) => entryMap[w.word]?.zh && !entryMap[w.word]?.example)
    .map((w) => ({ word: w.word, pos: w.pos, theme: w.theme }));
  if (needEx.length) {
    console.log(`Second pass for ${needEx.length} missing examples…`);
    await mapPool(chunk(needEx, BATCH), CONCURRENCY, async (batch, idx) => {
      try {
        const json = await postBatch(batch);
        if (json.model) modelUsed = json.model;
        const got = json.entries || {};
        for (const item of batch) {
          const e = got[item.word];
          const example = e?.example || (json.word === item.word ? json.example : '');
          if (validExample(example, item.word) && entryMap[item.word]) {
            entryMap[item.word].example = example;
          }
          // also refresh zh if better
          if (e?.zh && !looksSimplified(e.zh) && entryMap[item.word]) {
            entryMap[item.word].zh = e.zh;
          }
        }
        console.log(`[ex-batch ${idx + 1}] done`);
      } catch (err) {
        console.error(`[ex-batch ${idx + 1}] FAIL`, err.message || err);
      }
    });
  }

  let updatedZh = 0;
  let unchangedZh = 0;
  let keptOldZh = 0;
  let withExample = 0;
  const samples = [];
  const failures = [];

  for (const w of words) {
    const neu = entryMap[w.word];
    const oldZh = w.zh;
    if (neu?.zh) {
      if (neu.zh !== oldZh) updatedZh++;
      else unchangedZh++;
      w.zh = neu.zh;
      if (neu.example) {
        w.example = neu.example;
        withExample++;
      } else if (!w.example) {
        w.example = '';
      }
      if (samples.length < 25) {
        samples.push({ word: w.word, before: oldZh, after: w.zh, example: w.example || '' });
      }
    } else {
      keptOldZh++;
      if (!w.example) w.example = '';
      failures.push({ word: w.word, zh: oldZh });
    }
  }

  fs.writeFileSync(DATA, JSON.stringify(words, null, 2) + '\n');
  const spotWords = [
    'strawberry', 'bus', 'taxi', 'computer', 'pizza', 'cookie', 'biscuit',
    'rubbish', 'lift', 'flat', 'subway', 'toilet', 'football', 'apartment', 'candy',
    'actor', 'adult', 'airplane', 'blanket', 'brother',
  ];
  const report = {
    at: new Date().toISOString(),
    base: BASE,
    model: modelUsed,
    total: words.length,
    updatedZh,
    unchangedZh,
    keptOldZh,
    withExample,
    samples,
    failures,
    spotCheck: spotWords.map((word) => {
      const w = words.find((x) => x.word === word);
      return {
        word,
        before: before[word]?.zh,
        after: w?.zh,
        example: w?.example || '',
      };
    }),
  };
  fs.writeFileSync(REPORT, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({
    model: modelUsed,
    updatedZh,
    unchangedZh,
    keptOldZh,
    withExample,
    samples: samples.slice(0, 10),
    report: REPORT,
  }, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
