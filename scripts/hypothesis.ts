/**
 * エントリー仮説の検証
 *
 *   npx tsx scripts/hypothesis.ts --csv-1h data/usdjpy_h1_utc.csv
 *   npx tsx scripts/hypothesis.ts --csv-1h data/usdjpy_h1_utc.csv --rule bb_reversion
 *
 * 実データで、入り方の異なるルールを同じ土俵に並べる。
 *
 * 手順は3つ。どれか1つでも省くと、偶然を実力と読み違える。
 *
 * 1. **期間を分ける。** 前半60%で見て、後半40%は触らない。前半で良かったものが
 *    後半でも良いかを、後から確かめるためにとっておく。
 *
 * 2. **2種類の対照を置く。**
 *    - 時刻ランダム: 同じ本数だけ、でたらめな時刻に入る。「入る時刻を選べているか」
 *    - 向きランダム: **同じ時刻で**向きだけコインで決める。「向きを当てられているか」
 *    向きランダムのほうが厳しい。時間帯の性質で勝っているだけのルールはここで落ちる。
 *
 * 3. **試した数を数える。** 7つ試せば、対照を上回るものが1つ出るのは普通のこと。
 *    後半期間でも残ったものだけを候補として扱う。
 */
import { readFileSync } from "node:fs";
import {
  simulateFromSignals,
  summarize,
  simulateTrade,
  type BacktestConfig,
  type BacktestStats,
  type Trade,
} from "../lib/backtest";
import { parseCandleCsv } from "../lib/csv";
import { ALL_RULES, buildContext, scanRule, type EntryRule, type RuleContext } from "../lib/hypotheses";
import {
  calculateATR,
  getTimeSessionFromTimestamp,
  type OHLC,
} from "../lib/technicalAnalysis";

const SEEDS = [11, 22, 33, 44, 55];

interface Args {
  csv1H: string;
  rule?: string;
  splitRatio: number;
  spreadPips: number;
  stopSlippagePips: number;
}

function parseArgs(argv: string[]): Args {
  const map = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith("--")) continue;
    const eq = token.indexOf("=");
    if (eq !== -1) map.set(token.slice(2, eq), token.slice(eq + 1));
    else map.set(token.slice(2), argv[++i] ?? "");
  }
  const csv1H = map.get("csv-1h");
  if (!csv1H) throw new Error("--csv-1h を指定してください（実データが要ります）");
  const num = (key: string, fallback: number) => {
    const raw = map.get(key);
    if (raw === undefined) return fallback;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) throw new Error(`--${key} は数値で指定してください: ${raw}`);
    return parsed;
  };
  return {
    csv1H,
    rule: map.get("rule"),
    splitRatio: num("split", 0.6),
    spreadPips: num("spread", 1.0),
    stopSlippagePips: num("slippage", 0.5),
  };
}

function fmt(v: number, d = 1): string {
  return Number.isFinite(v) ? v.toFixed(d) : "∞";
}

/** backtest.ts と同型の小さな乱数（あちらの実装は非公開なのでここに置く） */
function makeRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 時刻ランダムの対照。ルールと同じように前へ進みながら、確率で入る。
 *
 * `runRandomEntryControl` は候補足からくじ引きし、既存の保有と重なったら
 * 引き直す。件数が多いとこれが効いて、**長く持つトレードほど棄却される**。
 * 損切りは利確より近いので、長く持つのは勝ちに向かっている側になりやすく、
 * 結果として対照の勝率が実際より低く出る。実データで2380件を引かせると
 * 勝率23.4%まで落ちた（理屈の上では1:2なので33%前後になるはず）。
 * 対照が弱くなると、ルールが不当に良く見える。
 *
 * ここでは棄却をやめて、保有中は入らないだけにする。長いトレードは
 * 後続の機会を潰すが、それは戦略側でも同じ扱いなので偏りにならない。
 */
function randomTimeControl(
  candles: OHLC[],
  atrSeries: number[],
  targetTrades: number,
  from: number,
  to: number,
  seed: number,
  cfg: BacktestConfig,
): BacktestStats {
  const candidates: number[] = [];
  for (let i = Math.max(from, 250); i < Math.min(to, candles.length - 1); i++) {
    const atr = atrSeries[i];
    if (atr === undefined || !Number.isFinite(atr) || atr <= 0) continue;
    const session = getTimeSessionFromTimestamp(candles[i].timestamp);
    if (session !== "LONDON" && session !== "NY") continue;
    candidates.push(i);
  }
  if (candidates.length === 0 || targetTrades === 0) return summarize([]);

  const run = (probability: number): Trade[] => {
    const rand = makeRandom(seed);
    const trades: Trade[] = [];
    let occupiedUntil = -1;
    for (const index of candidates) {
      if (index <= occupiedUntil) continue;
      if (rand() >= probability) continue;
      const direction = rand() < 0.5 ? "BUY" : "SELL";
      const trade = simulateTrade(candles, index, direction, atrSeries[index], 50, cfg);
      if (!trade) continue;
      trades.push(trade);
      occupiedUntil = index + trade.holdingBars;
    }
    return trades;
  };

  // 保有で塞がるぶん実際の件数は減るので、確率を数回だけ調整して件数を合わせる
  let probability = Math.min(targetTrades / candidates.length, 1);
  let trades = run(probability);
  for (let attempt = 0; attempt < 4 && trades.length > 0; attempt++) {
    if (Math.abs(trades.length - targetTrades) <= Math.max(2, targetTrades * 0.05)) break;
    probability = Math.min(probability * (targetTrades / trades.length), 1);
    trades = run(probability);
  }
  return summarize(trades);
}

/**
 * 同じ時刻で向きだけコインで決める対照。
 * 入る時刻はルールのまま残すので、「向きを当てられているか」だけが問われる。
 */
function randomDirectionControl(
  hits: { index: number; atr: number }[],
  candles: OHLC[],
  seed: number,
  cfg: BacktestConfig,
): BacktestStats {
  const rand = makeRandom(seed);

  const trades: Trade[] = [];
  let freeFrom = -1;
  for (const hit of hits) {
    if (hit.index <= freeFrom) continue; // 同時に1ポジションだけ
    const direction = rand() < 0.5 ? "BUY" : "SELL";
    const trade = simulateTrade(candles, hit.index, direction, hit.atr, 50, cfg);
    if (!trade) continue;
    trades.push(trade);
    freeFrom = hit.index + trade.holdingBars;
  }
  return summarize(trades);
}

interface Outcome {
  label: string;
  stats: BacktestStats;
  randomTimeWinRates: number[];
  randomDirWinRates: number[];
  randomTimeNet: number[];
  randomDirNet: number[];
}

function evaluate(
  rule: EntryRule,
  ctx: RuleContext,
  candles: OHLC[],
  atrSeries: number[],
  from: number,
  to: number,
  cfg: BacktestConfig,
  label: string,
): Outcome {
  const scan = scanRule(rule, ctx, from, to);
  const stats = simulateFromSignals(scan, candles, cfg).stats;

  const randomTimeWinRates: number[] = [];
  const randomTimeNet: number[] = [];
  const randomDirWinRates: number[] = [];
  const randomDirNet: number[] = [];

  if (stats.trades > 0) {
    for (const seed of SEEDS) {
      const control = randomTimeControl(candles, atrSeries, stats.trades, from, to, seed, cfg);
      randomTimeWinRates.push(control.winRate);
      randomTimeNet.push(control.netPips);

      const flipped = randomDirectionControl(scan.hits, candles, seed, cfg);
      randomDirWinRates.push(flipped.winRate);
      randomDirNet.push(flipped.netPips);
    }
  }

  return { label, stats, randomTimeWinRates, randomDirWinRates, randomTimeNet, randomDirNet };
}

function median(values: number[]): number {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/** 対照の散らばりの外に出ているか。中にあれば「区別がつかない」 */
function verdict(actual: number, controls: number[]): string {
  if (controls.length === 0) return "—";
  const max = Math.max(...controls);
  const min = Math.min(...controls);
  if (actual > max) return "上回る";
  if (actual < min) return "下回る";
  return "区別なし";
}

function printOutcome(o: Outcome): void {
  const s = o.stats;
  if (s.trades === 0) {
    console.log(`  ${o.label.padEnd(6)} トレードなし`);
    return;
  }
  console.log(
    `  ${o.label.padEnd(6)} ${String(s.trades).padStart(5)}件  勝率 ${fmt(s.winRate).padStart(5)}%  ` +
      `${fmt(s.netPips).padStart(9)} pips  PF ${fmt(s.profitFactor, 2).padStart(5)}  ` +
      `DD ${fmt(s.maxDrawdownPips).padStart(7)}`,
  );
  console.log(
    `         時刻ランダム 勝率中央値 ${fmt(median(o.randomTimeWinRates)).padStart(5)}% ` +
      `[${fmt(Math.min(...o.randomTimeWinRates))}〜${fmt(Math.max(...o.randomTimeWinRates))}] → ${verdict(s.winRate, o.randomTimeWinRates)}`,
  );
  console.log(
    `         向きランダム 勝率中央値 ${fmt(median(o.randomDirWinRates)).padStart(5)}% ` +
      `[${fmt(Math.min(...o.randomDirWinRates))}〜${fmt(Math.max(...o.randomDirWinRates))}] → ${verdict(s.winRate, o.randomDirWinRates)}`,
  );
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const candles = parseCandleCsv(readFileSync(args.csv1H, "utf8")).candles;
  const atrSeries = calculateATR(candles, 14);
  const ctx = buildContext(candles);

  const cfg: BacktestConfig = {
    pipSize: 0.01,
    spreadPips: args.spreadPips,
    stopSlippagePips: args.stopSlippagePips,
    windowSize: 1000,
    atrStopMultiplier: 1.5,
    riskRewardRatio: 2,
    maxHoldingBars: 120,
  };

  const split = Math.floor(candles.length * args.splitRatio);
  const rules = args.rule
    ? ALL_RULES.filter((r) => r.id === args.rule)
    : ALL_RULES;
  if (rules.length === 0) {
    throw new Error(`--rule が不正です（指定できるのは ${ALL_RULES.map((r) => r.id).join(", ")}）`);
  }

  const first = new Date(candles[0].timestamp).toISOString().slice(0, 10);
  const mid = new Date(candles[split].timestamp).toISOString().slice(0, 10);
  const last = new Date(candles[candles.length - 1].timestamp).toISOString().slice(0, 10);

  console.log("=".repeat(78));
  console.log("エントリー仮説の検証");
  console.log("=".repeat(78));
  console.log(`データ    : ${args.csv1H}  ${candles.length}本  ${first} 〜 ${last}`);
  console.log(`学習期間  : ${first} 〜 ${mid}（${split}本）`);
  console.log(`検証期間  : ${mid} 〜 ${last}（${candles.length - split}本・ここは選定に使わない）`);
  console.log(`コスト    : スプレッド ${args.spreadPips} pips / 滑り ${args.stopSlippagePips} pips / 損切り 1.5ATR / RR 1:2`);
  console.log(`試すルール: ${rules.length}件`);
  console.log("");
  console.log("※ ルールを7つ試せば、対照を上回るものが1つ出るのは普通のことです。");
  console.log("  学習期間で上回っただけのものは候補ではありません。検証期間で残ったものだけを見てください。");

  const survivors: string[] = [];

  for (const rule of rules) {
    console.log("");
    console.log("-".repeat(78));
    console.log(`${rule.name}（${rule.id}）`);
    console.log(`  ねらい: ${rule.idea}`);

    const inSample = evaluate(rule, ctx, candles, atrSeries, 250, split, cfg, "学習");
    const outSample = evaluate(rule, ctx, candles, atrSeries, split, candles.length, cfg, "検証");
    printOutcome(inSample);
    printOutcome(outSample);

    const beatsBoth = (o: Outcome) =>
      o.stats.trades >= 30 &&
      verdict(o.stats.winRate, o.randomTimeWinRates) === "上回る" &&
      verdict(o.stats.winRate, o.randomDirWinRates) === "上回る";

    if (beatsBoth(inSample) && beatsBoth(outSample)) {
      survivors.push(rule.id);
      console.log("  → 学習・検証の両方で、2種類の対照を上回りました");
    } else if (beatsBoth(inSample)) {
      console.log("  → 学習期間だけ。検証期間では対照を上回っていません（偶然の可能性）");
    }
  }

  console.log("");
  console.log("=".repeat(78));
  console.log(
    survivors.length === 0
      ? `${rules.length}件すべて、対照実験と区別がつきませんでした。`
      : `残ったもの: ${survivors.join(", ")}（${rules.length}件中）`,
  );
  if (survivors.length === 0) {
    console.log("");
    console.log("この結果に対して閾値を調整すると数字は良くなりますが、それは");
    console.log("このデータへの当てはめです。対照を上回らないルールは、当てはめる前から");
    console.log("拾うものがありません。");
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
