/**
 * パラメータ探索
 *
 *   npm run optimize -- --min-win-rate 60
 *   npm run optimize -- --csv-1h data/usdjpy_1h.csv --csv-daily data/usdjpy_1d.csv
 *
 * 勝率は「利確を近づける」だけで機械的に上がるので、それ単体を目標にすると
 * 必ず負ける設定に行き着く。ここでは勝率を**制約条件**として置き、
 * 期待値（1トレードあたりの平均pips）で順位をつける。
 *
 * さらに、期間を前半と後半に分けて前半だけで探索し、後半の成績を併記する。
 * 前半で良くて後半で崩れる設定はカーブフィットなので、その差が見えるようにしてある。
 */
import { readFileSync } from "node:fs";
import {
  collectSignals,
  simulateFromSignals,
  type BacktestConfig,
  type BacktestStats,
  type SignalScan,
} from "../lib/backtest";
import { parseCandleCsv } from "../lib/csv";
import { aggregate } from "../lib/marketData";
import { createSimulator } from "../lib/priceSimulator";
import type { OHLC } from "../lib/technicalAnalysis";

interface Args {
  csv1H?: string;
  csvDaily?: string;
  bars: number;
  seed: number;
  pipSize: number;
  spreadPips: number;
  minWinRate: number;
  minTrades: number;
  splitRatio: number;
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
    csv1H: map.get("csv-1h"),
    csvDaily: map.get("csv-daily"),
    bars: num("bars", 12000),
    seed: num("seed", 1),
    pipSize: num("pip-size", 0.01),
    spreadPips: num("spread", 1.0),
    minWinRate: num("min-win-rate", 60),
    minTrades: num("min-trades", 20),
    splitRatio: num("split", 0.6),
  };
}

/** 探索する組み合わせ。判定に関わるものと決済に関わるものを分けている */
const SIGNAL_GRID = {
  buyScoreMin: [0.6, 0.65, 0.7],
  buyRsiMax: [60, 70, 80],
};
const EXIT_GRID = {
  atrStopMultiplier: [1.0, 1.5, 2.0],
  riskRewardRatio: [0.5, 1, 1.5, 2, 3],
};

interface Candidate {
  buyScoreMin: number;
  buyRsiMax: number;
  atrStopMultiplier: number;
  riskRewardRatio: number;
  inSample: BacktestStats;
  outOfSample: BacktestStats;
}

function fmt(value: number, digits = 1): string {
  if (!Number.isFinite(value)) return "∞";
  return value.toFixed(digits);
}

function loadCsvOrThrow(path: string): OHLC[] {
  const { candles } = parseCandleCsv(readFileSync(path, "utf8"));
  return candles;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  let candles1H: OHLC[];
  let candlesDaily: OHLC[];
  let source: string;

  if (args.csv1H && args.csvDaily) {
    candles1H = loadCsvOrThrow(args.csv1H);
    candlesDaily = loadCsvOrThrow(args.csvDaily);
    source = `CSV (${args.csv1H})`;
  } else if (args.csv1H || args.csvDaily) {
    throw new Error("--csv-1h と --csv-daily は両方指定してください");
  } else {
    candles1H = createSimulator(args.seed, { bars: args.bars });
    candlesDaily = aggregate(candles1H, 24);
    source = `合成データ（ドル円に似た性質・seed=${args.seed}）`;
  }

  const splitIndex = Math.floor(candles1H.length * args.splitRatio);
  const splitTime = candles1H[splitIndex].timestamp;

  console.log("=".repeat(78));
  console.log("パラメータ探索");
  console.log("=".repeat(78));
  console.log(`データ        : ${source}`);
  console.log(`1H足          : ${candles1H.length}本`);
  console.log(
    `分割          : 前半 ${splitIndex}本で探索 / 後半 ${candles1H.length - splitIndex}本で検証` +
      `（境界 ${new Date(splitTime).toISOString().slice(0, 10)}）`,
  );
  console.log(`制約          : 勝率 ${args.minWinRate}% 以上、トレード ${args.minTrades}件以上`);
  console.log(`順位づけ      : 検証期間の期待値（pips/トレード）`);
  if (!args.csv1H) {
    console.log("");
    console.log("⚠ 合成データでの探索です。ここで出た数値は戦略の実力を示しません。");
    console.log("  実データで走らせるには --csv-1h / --csv-daily を指定してください。");
  }
  console.log("=".repeat(78));
  console.log("");

  const baseConfig: Partial<BacktestConfig> = {
    pipSize: args.pipSize,
    spreadPips: args.spreadPips,
    windowSize: 1000,
    maxHoldingBars: 120,
  };

  const candidates: Candidate[] = [];

  // 判定に関わるパラメータごとに1回だけ全区間をスキャンし、
  // 決済条件はその結果を使い回す（判定が圧倒的に重いため）
  for (const buyScoreMin of SIGNAL_GRID.buyScoreMin) {
    for (const buyRsiMax of SIGNAL_GRID.buyRsiMax) {
      const started = Date.now();
      const scan = collectSignals(candles1H, candlesDaily, {
        ...baseConfig,
        thresholds: { buyScoreMin, buyRsiMax },
      });

      const inScan: SignalScan = {
        hits: scan.hits.filter((h) => h.index < splitIndex),
        barsEvaluated: scan.barsEvaluated,
      };
      const outScan: SignalScan = {
        hits: scan.hits.filter((h) => h.index >= splitIndex),
        barsEvaluated: scan.barsEvaluated,
      };

      for (const atrStopMultiplier of EXIT_GRID.atrStopMultiplier) {
        for (const riskRewardRatio of EXIT_GRID.riskRewardRatio) {
          const exitConfig = { ...baseConfig, atrStopMultiplier, riskRewardRatio };
          candidates.push({
            buyScoreMin,
            buyRsiMax,
            atrStopMultiplier,
            riskRewardRatio,
            inSample: simulateFromSignals(inScan, candles1H, exitConfig).stats,
            outOfSample: simulateFromSignals(outScan, candles1H, exitConfig).stats,
          });
        }
      }

      console.log(
        `  buyScoreMin=${buyScoreMin} buyRsiMax=${buyRsiMax} → シグナル ${scan.hits.length}件` +
          `（${((Date.now() - started) / 1000).toFixed(1)}秒）`,
      );
    }
  }

  console.log("");
  console.log("=".repeat(78));

  // 制約を満たすもの
  const meetsConstraint = candidates.filter(
    (c) =>
      c.inSample.trades >= args.minTrades &&
      c.inSample.winRate >= args.minWinRate,
  );

  report(
    `勝率${args.minWinRate}%以上を満たす設定（探索期間で判定）`,
    meetsConstraint,
    args,
  );

  const profitable = candidates.filter((c) => c.inSample.trades >= args.minTrades);
  report("制約なしで期待値が高い設定", profitable, args);

  console.log("");
  console.log("-".repeat(78));
  console.log("読み方");
  console.log("-".repeat(78));
  if (meetsConstraint.length === 0) {
    console.log(`勝率${args.minWinRate}%以上を満たす設定は見つかりませんでした。`);
  } else {
    const best = [...meetsConstraint].sort(
      (a, b) => b.outOfSample.expectancyPips - a.outOfSample.expectancyPips,
    )[0];
    const bestOverall = [...profitable].sort(
      (a, b) => b.outOfSample.expectancyPips - a.outOfSample.expectancyPips,
    )[0];
    console.log(
      `勝率制約つきの最良: 勝率 ${fmt(best.outOfSample.winRate)}% / ` +
        `期待値 ${fmt(best.outOfSample.expectancyPips, 2)} pips（検証期間）`,
    );
    console.log(
      `制約なしの最良    : 勝率 ${fmt(bestOverall.outOfSample.winRate)}% / ` +
        `期待値 ${fmt(bestOverall.outOfSample.expectancyPips, 2)} pips（検証期間）`,
    );
    if (bestOverall.outOfSample.expectancyPips > best.outOfSample.expectancyPips) {
      console.log("");
      console.log("勝率の制約を外したほうが期待値は高くなります。勝率は利確幅を狭めれば");
      console.log("上がりますが、その分1回あたりの利益が減るため、目標にすべき指標では");
      console.log("ありません。実際に運用するなら期待値とドローダウンで選んでください。");
    }
  }
  console.log("");
  console.log("探索期間と検証期間で成績が大きく違う設定は、たまたま前半に合っていた");
  console.log("だけの可能性が高いので採用しないでください。");
}

function report(title: string, candidates: Candidate[], args: Args) {
  console.log("");
  console.log(title);
  if (candidates.length === 0) {
    console.log("  条件を満たす設定はありませんでした。");
    return;
  }

  const ranked = [...candidates]
    .sort((a, b) => b.outOfSample.expectancyPips - a.outOfSample.expectancyPips)
    .slice(0, 8);

  const header = [
    "score", "rsi", "atr", "RR",
    "探索:件数", "探索:勝率", "探索:期待値",
    "検証:件数", "検証:勝率", "検証:期待値", "検証:PF",
  ];
  const rows = ranked.map((c) => [
    String(c.buyScoreMin),
    String(c.buyRsiMax),
    String(c.atrStopMultiplier),
    `1:${c.riskRewardRatio}`,
    String(c.inSample.trades),
    `${fmt(c.inSample.winRate)}%`,
    fmt(c.inSample.expectancyPips, 2),
    String(c.outOfSample.trades),
    `${fmt(c.outOfSample.winRate)}%`,
    fmt(c.outOfSample.expectancyPips, 2),
    fmt(c.outOfSample.profitFactor, 2),
  ]);

  const widths = header.map((h, i) =>
    Math.max(h.length, ...rows.map((row) => row[i].length)),
  );
  const line = (cells: string[]) => "  " + cells.map((c, i) => c.padStart(widths[i])).join("  ");

  console.log(line(header));
  console.log("  " + widths.map((w) => "-".repeat(w)).join("  "));
  for (const row of rows) console.log(line(row));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
