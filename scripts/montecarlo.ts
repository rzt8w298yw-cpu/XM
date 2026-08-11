/**
 * モンテカルロ・シミュレーション
 *
 *   npm run montecarlo -- --paths 20 --bars 8000
 *
 * ドル円に似た統計的性質を持つ値動きを多数生成し、そのそれぞれで
 * 戦略とランダムエントリーを走らせて分布を比べる。
 *
 * これが答えられるのは「同じ値動きに対して、この判定ロジックはランダムに
 * 入るより成績が良いか」であって、「過去のドル円で儲かったか」ではない。
 * 実際の相場の成績を知るには実データが要る（`npm run backtest -- --csv-1h ...`）。
 *
 * ⚠ **そしてこのスクリプトの結論は、実データで再現しなかった。**
 * 以前ここは20系列中17系列で戦略が優位と出していたが、実際のドル円では
 * 勝率35.0%・ランダム（30.9〜37.3%）と区別がつかなかった。合成系列に
 * 持続的なトレンドがあり、トレンド追随がそれを拾えていただけだった。
 * 出力の末尾にもこの断りを出す。READMEを読まずにここだけ見た人が、
 * 撤回済みの結論を受け取らないようにするため。
 */
import {
  runBacktest,
  runRandomEntryControl,
  type BacktestStats,
} from "../lib/backtest";
import { createSimulator } from "../lib/priceSimulator";
import { aggregate } from "../lib/marketData";
import { calculateATR } from "../lib/technicalAnalysis";

interface Args {
  paths: number;
  bars: number;
  spreadPips: number;
  stopSlippagePips: number;
  windowSize: number;
  seed: number;
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
  return {
    paths: num("paths", 20),
    bars: num("bars", 8000),
    spreadPips: num("spread", 1.0),
    stopSlippagePips: num("slippage", 0.5),
    windowSize: num("window", 1000),
    seed: num("seed", 1),
  };
}

interface PathOutcome {
  strategy: BacktestStats;
  control: BacktestStats;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function quantile(values: number[], q: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

function fmt(value: number, digits = 1): string {
  if (!Number.isFinite(value)) return "∞";
  return value.toFixed(digits);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const pipSize = 0.01; // ドル円

  console.log("=".repeat(74));
  console.log("モンテカルロ・シミュレーション");
  console.log("=".repeat(74));
  console.log(`値動き        : ドル円に似た性質の合成系列（GARCH型ボラティリティ +`);
  console.log(`                セッション別ボラ + 週末の空白 + 緩やかなレジーム転換）`);
  console.log(`試行           : ${args.paths}本の独立した価格系列 × 各${args.bars}本の1H足`);
  console.log(`コスト         : スプレッド ${args.spreadPips} pips / 滑り ${args.stopSlippagePips} pips / 損切り 1.5ATR / RR 1:2`);
  console.log("");
  console.log("⚠ これは実際のドル円の歴史ではありません。答えを出せるのは");
  console.log("  「同じ値動きに対して判定ロジックがランダムエントリーより優れているか」");
  console.log("  であって、過去の実績ではありません。");
  console.log("=".repeat(74));
  console.log("");

  const outcomes: PathOutcome[] = [];
  const config = {
    pipSize,
    spreadPips: args.spreadPips,
    stopSlippagePips: args.stopSlippagePips,
    windowSize: args.windowSize,
    atrStopMultiplier: 1.5,
    riskRewardRatio: 2,
    maxHoldingBars: 120,
  };

  for (let path = 0; path < args.paths; path++) {
    const started = Date.now();
    const seed = args.seed + path * 7919;
    const candles1H = createSimulator(seed, { bars: args.bars });
    const candlesDaily = aggregate(candles1H, 24);

    const strategy = runBacktest(candles1H, candlesDaily, config);
    const atrSeries = calculateATR(candles1H, 14);
    const control = runRandomEntryControl(
      candles1H, atrSeries, strategy.stats.trades, seed + 104729, config,
    );

    outcomes.push({ strategy: strategy.stats, control: control.stats });
    console.log(
      `  系列 ${String(path + 1).padStart(2)}/${args.paths}: ` +
        `戦略 ${String(strategy.stats.trades).padStart(3)}件 勝率 ${fmt(strategy.stats.winRate).padStart(5)}% ` +
        `${fmt(strategy.stats.netPips).padStart(8)}pips　｜　` +
        `ランダム 勝率 ${fmt(control.stats.winRate).padStart(5)}% ${fmt(control.stats.netPips).padStart(8)}pips ` +
        `(${((Date.now() - started) / 1000).toFixed(1)}秒)`,
    );
  }

  console.log("");
  console.log("=".repeat(74));
  console.log("集計");
  console.log("=".repeat(74));

  report("戦略", outcomes.map((o) => o.strategy));
  console.log("");
  report("ランダムエントリー（対照）", outcomes.map((o) => o.control));
  console.log("");
  reportByDirection(outcomes.map((o) => o.strategy));

  console.log("");
  console.log("-".repeat(74));

  const strategyNet = outcomes.map((o) => o.strategy.netPips);
  const controlNet = outcomes.map((o) => o.control.netPips);
  const wins = outcomes.filter((o) => o.strategy.netPips > o.control.netPips).length;

  console.log(
    `戦略がランダムを上回った系列: ${wins}/${outcomes.length}` +
      `（${fmt((wins / outcomes.length) * 100)}%）`,
  );
  console.log(
    `損益の中央値の差: ${fmt(median(strategyNet) - median(controlNet))} pips`,
  );
  console.log("");
  console.log("判定の目安: 上回った系列が半数前後なら、この値動きに対して判定ロジックは");
  console.log("ランダムエントリーと区別できません。明確に優位なら7割以上に寄ります。");

  console.log("");
  console.log("=".repeat(74));
  console.log("⚠ この結果は実データでは再現しませんでした");
  console.log("=".repeat(74));
  console.log("ここで戦略がランダムを上回っても、それはこの合成系列の性質を測った");
  console.log("だけかもしれません。実際、以前このスクリプトは20系列中17系列で");
  console.log("戦略が優位と出していましたが、実際のドル円で確かめると消えました。");
  console.log("");
  console.log("  実ドル円 2012-11〜2022-03（440トレード）");
  console.log("    戦略        勝率 35.0%  PF 1.05");
  console.log("    ランダム    勝率 30.9〜37.3%（5種）  ← 戦略はこの中");
  console.log("");
  console.log("合成系列には持続的なトレンドがあり、トレンド追随がそれを拾えていた");
  console.log("だけでした。**この画面の数字を戦略の成績として読まないでください。**");
  console.log("確かめられるのは実装が動くことだけです。成績は実データで測ります:");
  console.log("");
  console.log("  npx tsx scripts/fetchRealData.ts --out data");
  console.log("  npm run backtest -- --csv-1h data/usdjpy_h1_utc.csv --csv-daily data/usdjpy_d1_utc.csv");
}

/**
 * 方向別の成績を系列をまたいで見る。
 *
 * 単一の系列では「BUYだけ負けている」といった偏りが出るが、それが
 * 戦略の性質なのかその値動きに固有なのかは1本では区別できない。
 * 系列をまたいで集計し、どちらが優勢だった系列の数も併記する。
 */
function reportByDirection(stats: BacktestStats[]) {
  const sum = (pick: (s: BacktestStats) => number) => stats.reduce((t, s) => t + pick(s), 0);

  const buyTrades = sum((s) => s.byDirection.BUY.trades);
  const sellTrades = sum((s) => s.byDirection.SELL.trades);
  const buyWins = sum((s) => s.byDirection.BUY.wins);
  const sellWins = sum((s) => s.byDirection.SELL.wins);
  const buyPips = sum((s) => s.byDirection.BUY.netPips);
  const sellPips = sum((s) => s.byDirection.SELL.netPips);

  const buyBetter = stats.filter(
    (s) => s.byDirection.BUY.netPips > s.byDirection.SELL.netPips,
  ).length;

  console.log("方向別（全系列の合計）");
  console.log(
    `  BUY : ${String(buyTrades).padStart(4)}件  勝率 ${fmt(buyTrades === 0 ? 0 : (buyWins / buyTrades) * 100).padStart(5)}%  ${fmt(buyPips).padStart(9)} pips`,
  );
  console.log(
    `  SELL: ${String(sellTrades).padStart(4)}件  勝率 ${fmt(sellTrades === 0 ? 0 : (sellWins / sellTrades) * 100).padStart(5)}%  ${fmt(sellPips).padStart(9)} pips`,
  );
  console.log(`  BUYがSELLを上回った系列: ${buyBetter}/${stats.length}`);

  if (buyBetter > 0 && buyBetter < stats.length) {
    console.log("  → どちらが勝つかは系列によって入れ替わります。1本の結果だけで");
    console.log("     「片方だけ機能しない」と判断しないでください");
  }
}

function report(label: string, stats: BacktestStats[]) {
  const trades = stats.map((s) => s.trades);
  const winRates = stats.filter((s) => s.trades > 0).map((s) => s.winRate);
  const netPips = stats.map((s) => s.netPips);
  const profitFactors = stats
    .filter((s) => s.trades > 0 && Number.isFinite(s.profitFactor))
    .map((s) => s.profitFactor);
  const drawdowns = stats.map((s) => s.maxDrawdownPips);
  const profitable = stats.filter((s) => s.netPips > 0).length;

  console.log(`${label}`);
  console.log(`  トレード数    中央値 ${fmt(median(trades), 0)}　範囲 ${fmt(Math.min(...trades), 0)}〜${fmt(Math.max(...trades), 0)}`);
  console.log(`  勝率          中央値 ${fmt(median(winRates))}%　5〜95パーセンタイル ${fmt(quantile(winRates, 0.05))}%〜${fmt(quantile(winRates, 0.95))}%`);
  console.log(`  損益          中央値 ${fmt(median(netPips))} pips　5〜95パーセンタイル ${fmt(quantile(netPips, 0.05))}〜${fmt(quantile(netPips, 0.95))} pips`);
  console.log(`  PF            中央値 ${fmt(median(profitFactors), 2)}`);
  console.log(`  最大DD        中央値 ${fmt(median(drawdowns))} pips`);
  console.log(`  プラスで終えた系列: ${profitable}/${stats.length}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
