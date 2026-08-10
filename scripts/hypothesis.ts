/**
 * エントリー仮説の検証
 *
 *   npx tsx scripts/hypothesis.ts --timeframe daily --dir data
 *   npx tsx scripts/hypothesis.ts --timeframe daily --dir data --rule donchian20
 *   npx tsx scripts/hypothesis.ts --timeframe hourly --csv data/usdjpy_h1_utc.csv
 *
 * 実データで、入り方の異なるルールを同じ土俵に並べる。決済とコストは
 * 既存のバックテストと同じ経路を通すので、差が出るのは入り方だけになる。
 *
 * 手順は4つ。どれか1つでも省くと、偶然を実力と読み違える。
 *
 * 1. **期間を分ける。** 前半60%で見て、後半40%は選定に使わない。
 *
 * 2. **対照を2種類置く。**
 *    - 時刻ランダム: 同じ本数だけ、でたらめな時刻に入る → 「入る時刻を選べているか」
 *    - 向きランダム: **同じ時刻で**向きだけコインで決める → 「向きを当てられているか」
 *    向きランダムのほうが厳しい。時間帯の性質で勝っているだけのルールはここで落ちる。
 *
 * 3. **銘柄をまたぐ。** 1銘柄で良く見えるのは珍しくない。同じ発想が
 *    複数の通貨ペアで同時に成り立つかを見る。これが日足に移した一番の利点で、
 *    12ペアぶんの独立に近い証拠が同じ手間で手に入る。
 *
 * 4. **試した数を数える。** 7つ試せば、対照を上回るものが1つ出るのは普通のこと。
 */
import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import {
  simulateFromSignals,
  simulateTrade,
  summarize,
  type BacktestConfig,
  type BacktestStats,
  type Trade,
} from "../lib/backtest";
import { parseCandleCsv } from "../lib/csv";
import {
  DAILY_RULES,
  HOURLY_RULES,
  buildContext,
  scanRule,
  type EntryRule,
  type RuleContext,
} from "../lib/hypotheses";
import {
  calculateATR,
  getTimeSessionFromTimestamp,
  type OHLC,
} from "../lib/technicalAnalysis";

const SEEDS = [11, 22, 33, 44, 55];

type Timeframe = "hourly" | "daily";

interface Args {
  timeframe: Timeframe;
  files: string[];
  rule?: string;
  splitRatio: number;
  spreadPips: number;
  stopSlippagePips: number;
  maxHoldingBars: number;
}

/** ファイル名から銘柄とpipの大きさを決める。桁を取り違えると損益が10倍ずれる */
function specFromFilename(path: string): { symbol: string; pipSize: number } {
  const symbol = basename(path).split("_")[0].toUpperCase();
  if (symbol.startsWith("XAU")) return { symbol, pipSize: 0.1 };
  if (symbol.endsWith("JPY")) return { symbol, pipSize: 0.01 };
  return { symbol, pipSize: 0.0001 };
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
  const num = (key: string, fallback: number) => {
    const raw = map.get(key);
    if (raw === undefined) return fallback;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) throw new Error(`--${key} は数値で指定してください: ${raw}`);
    return parsed;
  };

  const timeframe = (map.get("timeframe") ?? "daily") as Timeframe;
  if (timeframe !== "hourly" && timeframe !== "daily") {
    throw new Error("--timeframe は hourly か daily で指定してください");
  }

  const suffix = timeframe === "daily" ? "_d1_utc.csv" : "_h1_utc.csv";
  let files: string[];
  const dir = map.get("dir");
  const csv = map.get("csv") ?? map.get("csv-1h");
  if (dir) {
    files = readdirSync(dir)
      .filter((name) => name.endsWith(suffix))
      .sort()
      .map((name) => join(dir, name));
    if (files.length === 0) {
      throw new Error(`${dir} に ${suffix} で終わるファイルがありません`);
    }
  } else if (csv) {
    files = [csv];
  } else {
    throw new Error("--dir か --csv を指定してください（実データが要ります）");
  }

  return {
    timeframe,
    files,
    rule: map.get("rule"),
    splitRatio: num("split", 0.6),
    spreadPips: num("spread", 1.0),
    stopSlippagePips: num("slippage", 0.5),
    maxHoldingBars: num("max-holding", timeframe === "daily" ? 60 : 120),
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
 * 以前は候補足からくじを引き、既存の保有と重なったら引き直していた。
 * 件数が多いとこれが効いて、**長く持つトレードほど棄却される**。損切りは
 * 利確より近いので、長く持つのは勝ちに向かっている側になりやすく、対照の
 * 勝率が実際より低く出る（1時間足で2380件を引かせたら23.4%まで落ちた。
 * 1:2なら33%前後になるはず）。対照が弱くなると、ルールが不当に良く見える。
 *
 * 棄却をやめて、保有中は入らないだけにする。長いトレードが後続の機会を
 * 潰すのは戦略側でも同じなので、偏りにならない。
 */
function randomTimeControl(
  candles: OHLC[],
  atrSeries: number[],
  targetTrades: number,
  from: number,
  to: number,
  seed: number,
  cfg: BacktestConfig,
  timeframe: Timeframe,
): BacktestStats {
  const candidates: number[] = [];
  for (let i = Math.max(from, 250); i < Math.min(to, candles.length - 1); i++) {
    const atr = atrSeries[i];
    if (atr === undefined || !Number.isFinite(atr) || atr <= 0) continue;
    // 日足に時間帯の区別は無い。1時間足のときだけ戦略と同じ時間帯に揃える
    if (timeframe === "hourly") {
      const session = getTimeSessionFromTimestamp(candles[i].timestamp);
      if (session !== "LONDON" && session !== "NY") continue;
    }
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
  let occupiedUntil = -1;
  for (const hit of hits) {
    if (hit.index <= occupiedUntil) continue;
    const direction = rand() < 0.5 ? "BUY" : "SELL";
    const trade = simulateTrade(candles, hit.index, direction, hit.atr, 50, cfg);
    if (!trade) continue;
    trades.push(trade);
    occupiedUntil = hit.index + trade.holdingBars;
  }
  return summarize(trades);
}

interface PairOutcome {
  symbol: string;
  trades: Trade[];
  stats: BacktestStats;
  /** seed ごとの対照。銘柄をまたいで足し上げるためトレードそのものを持つ */
  randomTime: BacktestStats[];
  randomDir: BacktestStats[];
}

interface Dataset {
  symbol: string;
  candles: OHLC[];
  atr: number[];
  ctx: RuleContext;
  pipSize: number;
  split: number;
}

function evaluatePair(
  rule: EntryRule,
  data: Dataset,
  from: number,
  to: number,
  baseCfg: Omit<BacktestConfig, "pipSize">,
  timeframe: Timeframe,
): PairOutcome {
  const cfg: BacktestConfig = { ...baseCfg, pipSize: data.pipSize };
  const scan = scanRule(rule, data.ctx, from, to);
  const result = simulateFromSignals(scan, data.candles, cfg);

  const randomTime: BacktestStats[] = [];
  const randomDir: BacktestStats[] = [];
  if (result.stats.trades > 0) {
    for (const seed of SEEDS) {
      randomTime.push(
        randomTimeControl(data.candles, data.atr, result.stats.trades, from, to, seed, cfg, timeframe),
      );
      randomDir.push(randomDirectionControl(scan.hits, data.candles, seed, cfg));
    }
  }

  return {
    symbol: data.symbol,
    trades: result.trades,
    stats: result.stats,
    randomTime,
    randomDir,
  };
}

/** 銘柄ごとの結果を1つにまとめる。pipsは銘柄をまたいで足せる単位 */
function pool(outcomes: PairOutcome[]): {
  stats: BacktestStats;
  randomTimeWinRates: number[];
  randomDirWinRates: number[];
} {
  const stats = summarize(outcomes.flatMap((o) => o.trades));

  const poolBySeed = (pick: (o: PairOutcome) => BacktestStats[]) =>
    SEEDS.map((_, s) => {
      let wins = 0;
      let trades = 0;
      for (const o of outcomes) {
        const seedStats = pick(o)[s];
        if (!seedStats) continue;
        wins += seedStats.wins;
        trades += seedStats.trades;
      }
      return trades === 0 ? NaN : (wins / trades) * 100;
    }).filter(Number.isFinite);

  return {
    stats,
    randomTimeWinRates: poolBySeed((o) => o.randomTime),
    randomDirWinRates: poolBySeed((o) => o.randomDir),
  };
}

/** 対照の散らばりの外に出ているか。中にあれば「区別がつかない」 */
function verdict(actual: number, controls: number[]): "上回る" | "下回る" | "区別なし" | "—" {
  if (controls.length === 0) return "—";
  if (actual > Math.max(...controls)) return "上回る";
  if (actual < Math.min(...controls)) return "下回る";
  return "区別なし";
}

function printPeriod(
  label: string,
  outcomes: PairOutcome[],
  showPairs: boolean,
): { beatsBoth: boolean; positivePairs: number; totalPairs: number } {
  const { stats, randomTimeWinRates, randomDirWinRates } = pool(outcomes);
  if (stats.trades === 0) {
    console.log(`  ${label}  トレードなし`);
    return { beatsBoth: false, positivePairs: 0, totalPairs: outcomes.length };
  }

  const positivePairs = outcomes.filter((o) => o.stats.netPips > 0).length;
  const withTrades = outcomes.filter((o) => o.stats.trades > 0).length;

  console.log(
    `  ${label}  ${String(stats.trades).padStart(5)}件  勝率 ${fmt(stats.winRate).padStart(5)}%  ` +
      `${fmt(stats.netPips).padStart(9)} pips  PF ${fmt(stats.profitFactor, 2).padStart(5)}  ` +
      `プラスの銘柄 ${positivePairs}/${withTrades}`,
  );
  const timeVerdict = verdict(stats.winRate, randomTimeWinRates);
  const dirVerdict = verdict(stats.winRate, randomDirWinRates);
  console.log(
    `        時刻ランダム ${fmt(Math.min(...randomTimeWinRates))}〜${fmt(Math.max(...randomTimeWinRates))}% → ${timeVerdict}` +
      `　｜　向きランダム ${fmt(Math.min(...randomDirWinRates))}〜${fmt(Math.max(...randomDirWinRates))}% → ${dirVerdict}`,
  );

  if (showPairs) {
    const line = outcomes
      .filter((o) => o.stats.trades > 0)
      .map((o) => `${o.symbol} ${fmt(o.stats.netPips, 0)}`)
      .join(" / ");
    console.log(`        銘柄別: ${line}`);
  }

  return {
    beatsBoth: timeVerdict === "上回る" && dirVerdict === "上回る" && stats.trades >= 30,
    positivePairs,
    totalPairs: withTrades,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const baseCfg: Omit<BacktestConfig, "pipSize"> = {
    spreadPips: args.spreadPips,
    stopSlippagePips: args.stopSlippagePips,
    windowSize: 1000,
    atrStopMultiplier: 1.5,
    riskRewardRatio: 2,
    maxHoldingBars: args.maxHoldingBars,
  };

  const datasets: Dataset[] = args.files.map((path) => {
    const { symbol, pipSize } = specFromFilename(path);
    const candles = parseCandleCsv(readFileSync(path, "utf8")).candles;
    return {
      symbol,
      candles,
      atr: calculateATR(candles, 14),
      ctx: buildContext(candles),
      pipSize,
      split: Math.floor(candles.length * args.splitRatio),
    };
  });

  const catalogue = args.timeframe === "daily" ? DAILY_RULES : HOURLY_RULES;
  const rules = args.rule ? catalogue.filter((r) => r.id === args.rule) : catalogue;
  if (rules.length === 0) {
    throw new Error(`--rule が不正です（指定できるのは ${catalogue.map((r) => r.id).join(", ")}）`);
  }

  const sample = datasets[0];
  const span = (c: OHLC[], i: number) => new Date(c[i].timestamp).toISOString().slice(0, 10);

  console.log("=".repeat(84));
  console.log(`エントリー仮説の検証（${args.timeframe === "daily" ? "日足" : "1時間足"}）`);
  console.log("=".repeat(84));
  console.log(`銘柄      : ${datasets.length}件  ${datasets.map((d) => d.symbol).join(" ")}`);
  console.log(
    `期間      : ${span(sample.candles, 0)} 〜 ${span(sample.candles, sample.candles.length - 1)}` +
      `（各${sample.candles.length}本）`,
  );
  console.log(`学習/検証 : ${span(sample.candles, sample.split)} で分割（検証側は選定に使わない）`);
  console.log(
    `コスト    : スプレッド ${args.spreadPips} pips / 滑り ${args.stopSlippagePips} pips / ` +
      `損切り 1.5ATR / RR 1:2 / 最大保有 ${args.maxHoldingBars}本`,
  );
  console.log(`試すルール: ${rules.length}件`);

  const survivors: string[] = [];

  for (const rule of rules) {
    console.log("");
    console.log("-".repeat(84));
    console.log(`${rule.name}（${rule.id}）`);
    console.log(`  ねらい: ${rule.idea}`);

    const inSample = datasets.map((d) => evaluatePair(rule, d, 250, d.split, baseCfg, args.timeframe));
    const outSample = datasets.map((d) =>
      evaluatePair(rule, d, d.split, d.candles.length, baseCfg, args.timeframe),
    );

    const is = printPeriod("学習", inSample, false);
    const oos = printPeriod("検証", outSample, true);

    if (is.beatsBoth && oos.beatsBoth) {
      survivors.push(rule.id);
      console.log("  → 学習・検証の両方で、2種類の対照を上回りました");
    } else if (is.beatsBoth) {
      console.log("  → 学習期間だけ。検証期間では対照を上回っていません（偶然の可能性）");
    } else if (oos.beatsBoth) {
      console.log("  → 検証期間だけ。学習期間では上回っていないので、順序が逆です");
    }
  }

  console.log("");
  console.log("=".repeat(84));
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
