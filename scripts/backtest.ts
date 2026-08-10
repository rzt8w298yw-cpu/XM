/**
 * バックテスト実行CLI
 *
 *   npm run backtest -- --symbol USDJPY
 *   npm run backtest -- --symbol USDJPY --sweep buyRsiMax=60,65,70,75,80
 *   npm run backtest -- --csv-1h data/usdjpy_1h.csv --csv-daily data/usdjpy_1d.csv
 *
 * CSVは `timestamp,open,high,low,close` のヘッダ付き。timestampはISO文字列か
 * エポック秒/ミリ秒を受け付ける。
 */
import { readFileSync } from "node:fs";
import {
  runBacktest,
  type BacktestStats,
  type Trade,
} from "../lib/backtest";
import { inspectCandles, parseCandleCsv } from "../lib/csv";
import {
  buildEquityCurve,
  calculateConcentration,
  calculateStreaks,
  renderSparkline,
  splitByPeriod,
} from "../lib/equityCurve";
import { DEFAULT_THRESHOLDS, type SignalThresholds } from "../lib/autoSignalEngine";
import { fetchMarketData, getSymbolSpec } from "../lib/marketData";
import type { OHLC } from "../lib/technicalAnalysis";

interface Args {
  symbol: string;
  csv1H?: string;
  csvDaily?: string;
  spreadPips: number;
  stopSlippagePips: number;
  windowSize: number;
  maxHoldingBars: number;
  atrStopMultiplier: number;
  riskRewardRatio: number;
  range1H: string;
  syntheticBars: number;
  sweep?: { key: keyof SignalThresholds; values: number[] };
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

  let sweep: Args["sweep"];
  const sweepRaw = map.get("sweep");
  if (sweepRaw) {
    const [key, list] = sweepRaw.split("=");
    if (!(key in DEFAULT_THRESHOLDS)) {
      throw new Error(
        `--sweep のキーが不正です: ${key} (指定できるのは ${Object.keys(DEFAULT_THRESHOLDS).join(", ")})`,
      );
    }
    const values = (list ?? "").split(",").map(Number);
    if (values.length === 0 || values.some((v) => !Number.isFinite(v))) {
      throw new Error(`--sweep の値が不正です: ${list}`);
    }
    sweep = { key: key as keyof SignalThresholds, values };
  }

  return {
    symbol: map.get("symbol") ?? "USDJPY",
    csv1H: map.get("csv-1h"),
    csvDaily: map.get("csv-daily"),
    spreadPips: num("spread", 1.0),
    stopSlippagePips: num("slippage", 0.5),
    windowSize: num("window", 1000),
    maxHoldingBars: num("max-holding", 120),
    atrStopMultiplier: num("atr-stop", 1.5),
    riskRewardRatio: num("rr", 2),
    range1H: map.get("range") ?? "730d",
    syntheticBars: num("synthetic-bars", 9000),
    sweep,
  };
}

/** ローソク足CSVを読む。形式の判別は lib/csv.ts に任せる */
function loadCsv(path: string, label: string, expectedStepMs: number): OHLC[] {
  let result;
  try {
    result = parseCandleCsv(readFileSync(path, "utf8"));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${path}: ${message}`);
  }

  if (result.skipped > 0) {
    console.log(`  ${label}: ${result.skipped}行を読み飛ばしました（数値として解釈できない行）`);
  }
  for (const note of inspectCandles(result.candles, expectedStepMs)) {
    console.log(`  ${label}: ${note}`);
  }
  return result.candles;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const spec = getSymbolSpec(args.symbol);

  let candles1H: OHLC[];
  let candlesDaily: OHLC[];
  let source: string;

  if (args.csv1H && args.csvDaily) {
    console.log("CSVを読み込んでいます…");
    candles1H = loadCsv(args.csv1H, "1H足", 3_600_000);
    candlesDaily = loadCsv(args.csvDaily, "日足", 24 * 3_600_000);
    source = `CSV (${args.csv1H} / ${args.csvDaily})`;
  } else if (args.csv1H || args.csvDaily) {
    throw new Error("--csv-1h と --csv-daily は両方指定してください");
  } else {
    const market = await fetchMarketData(spec.id, {
      range1H: args.range1H,
      rangeDaily: "10y",
      syntheticBars: args.syntheticBars,
    });
    candles1H = market.candles1H;
    candlesDaily = market.candlesDaily;
    source = market.source === "yahoo" ? "Yahoo Finance（実データ）" : `合成データ — ${market.note}`;
  }

  const span = (candles: OHLC[]) =>
    candles.length === 0
      ? "なし"
      : `${new Date(candles[0].timestamp).toISOString().slice(0, 10)} 〜 ${new Date(candles.at(-1)!.timestamp).toISOString().slice(0, 10)}`;

  console.log("=".repeat(72));
  console.log(`シンボル      : ${spec.label} (1pip = ${spec.pipSize})`);
  console.log(`データ元      : ${source}`);
  console.log(`1H足          : ${candles1H.length}本  ${span(candles1H)}`);
  console.log(`日足          : ${candlesDaily.length}本  ${span(candlesDaily)}`);
  console.log(
    `試行条件      : スプレッド ${args.spreadPips}pips / 滑り ${args.stopSlippagePips}pips / 損切り ${args.atrStopMultiplier}ATR / RR 1:${args.riskRewardRatio} / 最大保有 ${args.maxHoldingBars}本`,
  );
  if (source.startsWith("合成データ")) {
    console.log("");
    console.log("⚠ 合成データはランダムウォークです。値動きに再現可能な優位性は存在しないため、");
    console.log("  以下の数値は基盤の動作確認にしかなりません。戦略の評価には使えません。");
  }
  console.log("=".repeat(72));

  const baseConfig = {
    pipSize: spec.pipSize,
    spreadPips: args.spreadPips,
    stopSlippagePips: args.stopSlippagePips,
    windowSize: args.windowSize,
    maxHoldingBars: args.maxHoldingBars,
    atrStopMultiplier: args.atrStopMultiplier,
    riskRewardRatio: args.riskRewardRatio,
  };

  if (args.sweep) {
    const rows: { label: string; stats: BacktestStats }[] = [];
    for (const value of args.sweep.values) {
      const started = Date.now();
      const result = runBacktest(candles1H, candlesDaily, {
        ...baseConfig,
        thresholds: { [args.sweep.key]: value },
      });
      rows.push({ label: `${args.sweep.key}=${value}`, stats: result.stats });
      console.log(
        `  ${args.sweep.key}=${String(value).padStart(5)} → ${String(result.stats.trades).padStart(4)}件  (${((Date.now() - started) / 1000).toFixed(1)}秒)`,
      );
    }
    console.log("");
    printSweepTable(rows);
  } else {
    const result = runBacktest(candles1H, candlesDaily, baseConfig);
    console.log(`判定した足    : ${result.barsEvaluated}本`);
    console.log(`保有中スキップ: ${result.barsInPosition}本`);
    console.log("");
    printStats(result.stats);
    printQuality(result.trades);
    printRecentTrades(result.trades, spec.digits);
  }
}

function fmt(value: number, digits = 1): string {
  if (!Number.isFinite(value)) return "∞";
  return value.toFixed(digits);
}

function printStats(stats: BacktestStats) {
  if (stats.trades === 0) {
    console.log("トレードが1件も発生しませんでした。");
    return;
  }
  console.log(`トレード数    : ${stats.trades} (勝ち ${stats.wins} / 負け ${stats.losses})`);
  console.log(`勝率          : ${fmt(stats.winRate)}%`);
  console.log(`損益          : ${fmt(stats.netPips)} pips`);
  console.log(`総利益 / 総損失: ${fmt(stats.grossProfitPips)} / ${fmt(stats.grossLossPips)} pips`);
  console.log(`プロフィットファクター: ${fmt(stats.profitFactor, 2)}`);
  console.log(`期待値        : ${fmt(stats.expectancyPips, 2)} pips/トレード`);
  console.log(`最大ドローダウン: ${fmt(stats.maxDrawdownPips)} pips`);
  console.log(`平均保有      : ${fmt(stats.averageHoldingBars)}本`);
  console.log("");
  for (const dir of ["BUY", "SELL"] as const) {
    const d = stats.byDirection[dir];
    console.log(
      `  ${dir.padEnd(4)}: ${String(d.trades).padStart(4)}件  勝率 ${fmt(d.winRate).padStart(5)}%  損益 ${fmt(d.netPips).padStart(8)} pips  PF ${fmt(d.profitFactor, 2)}`,
    );
  }
}

function printSweepTable(rows: { label: string; stats: BacktestStats }[]) {
  const header = ["条件", "件数", "勝率", "損益(pips)", "PF", "期待値", "最大DD"];
  const body = rows.map((r) => [
    r.label,
    String(r.stats.trades),
    `${fmt(r.stats.winRate)}%`,
    fmt(r.stats.netPips),
    fmt(r.stats.profitFactor, 2),
    fmt(r.stats.expectancyPips, 2),
    fmt(r.stats.maxDrawdownPips),
  ]);

  const widths = header.map((h, i) =>
    Math.max(h.length, ...body.map((row) => row[i].length)),
  );
  const line = (cells: string[]) =>
    cells.map((c, i) => c.padStart(widths[i])).join("  ");

  console.log(line(header));
  console.log(widths.map((w) => "-".repeat(w)).join("  "));
  for (const row of body) console.log(line(row));
}

/**
 * 損益の合計だけでは、一定して積み上がったのか一度の大勝ちに
 * 支えられているのかが分からない。その区別がつく情報を出す。
 */
function printQuality(trades: Trade[]) {
  if (trades.length < 2) return;

  const curve = buildEquityCurve(trades);
  const streaks = calculateStreaks(trades);
  const concentration = calculateConcentration(trades);

  console.log("");
  console.log("資産曲線（縦軸は自動スケール）");
  for (const row of renderSparkline(curve, 64, 8)) {
    console.log("  " + row);
  }
  const last = curve[curve.length - 1];
  console.log(`  0件目 ${fmt(0)} pips 〜 ${trades.length}件目 ${fmt(last.equity)} pips`);

  console.log("");
  console.log(`最大連勝 ${streaks.longestWin} / 最大連敗 ${streaks.longestLoss}`);
  console.log(`最大の負け ${fmt(concentration.worstLoss)} pips`);
  console.log(
    `総利益に占める最大の勝ち ${fmt(concentration.topWinShare)}%` +
      `（上位3件で ${fmt(concentration.top3WinShare)}%）`,
  );
  if (concentration.topWinShare > 40) {
    console.log("  ※ 利益が一部のトレードに偏っています。その相場が来なければ成立しません");
  }

  const segments = splitByPeriod(trades, 4);
  if (segments.length > 1) {
    console.log("");
    console.log("期間ごとの偏り:");
    for (const segment of segments) {
      console.log(
        `  ${segment.label.padEnd(14)} ${String(segment.trades).padStart(3)}件  ` +
          `勝率 ${fmt(segment.winRate).padStart(5)}%  ${fmt(segment.netPips).padStart(8)} pips`,
      );
    }
    const positive = segments.filter((s) => s.netPips > 0).length;
    if (positive <= segments.length / 2) {
      console.log("  ※ 一部の期間だけで稼いでいます。相場付きが変わると崩れる可能性があります");
    }
  }
}

function printRecentTrades(trades: Trade[], digits: number) {
  if (trades.length === 0) return;
  console.log("");
  console.log("直近のトレード（最大10件）:");
  for (const trade of trades.slice(-10)) {
    const when = new Date(trade.entryTime).toISOString().slice(0, 16).replace("T", " ");
    console.log(
      `  ${when}  ${trade.direction.padEnd(4)} ${trade.entryPrice.toFixed(digits)} → ${trade.exitPrice.toFixed(digits)}  ` +
        `${fmt(trade.pips).padStart(7)} pips  ${trade.exitReason.padEnd(11)} ${trade.holdingBars}本  ${trade.session}`,
    );
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
