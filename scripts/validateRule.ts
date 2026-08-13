/**
 * 見つけたルールを殺しにいく
 *
 *   npm run validate-rule -- --rule roc_threshold --filter adx_ranging --stop 2.0 --rr 0.5
 *
 * 総当たり探索が残したものに対して、**探索では使えない3つの検証**をかける。
 * どれも「同じデータで測り直す」のではなく、別の軸を当てる。
 *
 * ## なぜ探索の関門だけでは足りないか
 *
 * 28,512通りから選んだものを、選ぶのに使ったのと同じデータで確かめても
 * 循環論法になる。IS/OOS分割も、OOSを見て採否を決めた時点で「2回目のIS」に
 * 変わっている。必要なのは**選定に一切関わっていない軸**での確認。
 *
 * 1. **コスト感応度** — スプレッドを上げていって、どこで優位が消えるか。
 *    実際に払うコストがその手前なら、その優位は存在しない。
 * 2. **取引時刻の分布** — いつ発動しているか。特定の時間帯に偏るなら、
 *    その時間帯の実際のスプレッドで測り直さないと意味がない。
 * 3. **他の通貨ペア** — 市場の性質を捉えているなら、程度の差はあれ
 *    他でも出るはず。1銘柄だけに出るものは、その銘柄の偶然。
 *
 * 3つ目が最も効く。実際、この一式で唯一4関門を通った
 * `roc_threshold + adx_ranging` は、12通貨ペア中ドル円だけで機能し、
 * 他11ペアはすべて損失だった。
 */
import { readdirSync, readFileSync } from "node:fs";
import {
  simulateFromSignals,
  type BacktestConfig,
  type BacktestStats,
} from "../lib/backtest";
import { parseCandleCsv } from "../lib/csv";
import {
  buildWideContext,
  FILTERS,
  scanWideRule,
  WIDE_RULES,
} from "../lib/wideRules";
import type { OHLC } from "../lib/technicalAnalysis";

interface Args {
  ruleId: string;
  filterId: string;
  stopMultiplier: number;
  riskReward: number;
  spreadPips: number;
  stopSlippagePips: number;
  dir: string;
  symbol: string;
  /** どの足で検証するか。日足のルールを1時間足で測っても意味がない */
  timeframe: "hourly" | "daily";
  maxHoldingBars: number;
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
    ruleId: map.get("rule") ?? "",
    filterId: map.get("filter") ?? "none",
    stopMultiplier: num("stop", 1.5),
    riskReward: num("rr", 1.0),
    spreadPips: num("spread", 2.0),
    stopSlippagePips: num("slippage", 1.0),
    dir: map.get("dir") ?? "data",
    symbol: (map.get("symbol") ?? "USDJPY").toUpperCase(),
    timeframe: map.get("timeframe") === "daily" ? "daily" : "hourly",
    maxHoldingBars: num("max-holding", map.get("timeframe") === "daily" ? 20 : 120),
  };
}

function pipSizeFor(symbol: string): number {
  if (symbol.startsWith("XAU")) return 0.1;
  if (symbol.endsWith("JPY")) return 0.01;
  return 0.0001;
}

function fmt(v: number, d = 1): string {
  return Number.isFinite(v) ? v.toFixed(d) : "—";
}

/** 実測の平均利益・平均損失から出す損益分岐勝率 */
function breakEven(stats: BacktestStats): number {
  if (stats.wins === 0 || stats.losses === 0) return NaN;
  const avgWin = stats.grossProfitPips / stats.wins;
  const avgLoss = stats.grossLossPips / stats.losses;
  return (avgLoss / (avgWin + avgLoss)) * 100;
}

/** 勝率の95%信頼区間の下限 */
function lowerBound(stats: BacktestStats): number {
  if (stats.trades === 0) return NaN;
  const p = stats.winRate / 100;
  return stats.winRate - 1.96 * Math.sqrt((p * (1 - p)) / stats.trades) * 100;
}

function suffixFor(timeframe: "hourly" | "daily"): string {
  return timeframe === "daily" ? "_d1_utc.csv" : "_h1_utc.csv";
}

function configFor(args: Args, pipSize: number, spread: number, slippage: number): BacktestConfig {
  return {
    pipSize,
    atrStopMultiplier: args.stopMultiplier,
    riskRewardRatio: args.riskReward,
    spreadPips: spread,
    stopSlippagePips: slippage,
    windowSize: 250,
    maxHoldingBars: args.maxHoldingBars,
    useStops: true,
    // 日足は 22:00 UTC 固定で、ロンドンにもNYにも当たらない
    restrictToSessions: args.timeframe !== "daily",
  };
}

function loadCsv(path: string): OHLC[] {
  return parseCandleCsv(readFileSync(path, "utf8")).candles;
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  const rule = WIDE_RULES.find((r) => r.id === args.ruleId);
  if (!rule) {
    throw new Error(
      `ルールが見つかりません: ${args.ruleId}\n指定できるのは ${WIDE_RULES.map((r) => r.id).join(", ")}`,
    );
  }
  const filter = FILTERS.find((f) => f.id === args.filterId);
  if (!filter) {
    throw new Error(
      `フィルターが見つかりません: ${args.filterId}\n指定できるのは ${FILTERS.map((f) => f.id).join(", ")}`,
    );
  }

  console.log("=".repeat(78));
  console.log(`${rule.id} + ${filter.id} を検証する`);
  console.log("=".repeat(78));
  console.log(`狙い    : ${rule.idea}`);
  console.log(`条件    : ${filter.idea}`);
  console.log(
    `決済    : 損切り ${args.stopMultiplier}ATR / RR 1:${args.riskReward} / 保有上限 ${args.maxHoldingBars}本`,
  );
  console.log(`足      : ${args.timeframe === "daily" ? "日足" : "1時間足"}`);
  console.log("");

  const basePipSize = pipSizeFor(args.symbol);
  const baseCandles = loadCsv(
    `${args.dir}/${args.symbol.toLowerCase()}${suffixFor(args.timeframe)}`,
  );
  const baseCtx = buildWideContext(baseCandles, basePipSize);
  const baseScan = scanWideRule(rule, filter, baseCtx, 0, baseCandles.length);

  // ----------------------------------------------------------------
  // 1. コスト感応度
  // ----------------------------------------------------------------
  console.log("-".repeat(78));
  console.log(`1. コスト感応度（${args.symbol} ${args.timeframe === "daily" ? "日足" : "1時間足"} 全期間）`);
  console.log("-".repeat(78));
  console.log("実際に払うコストで優位が残るか。消える点の手前で運用できなければ意味がない。");
  console.log("");
  console.log(
    `  ${"スプレッド/滑り".padEnd(18)}${"件数".padStart(7)}${"勝率".padStart(9)}${"分岐".padStart(9)}${"95%下限".padStart(10)}${"余裕".padStart(8)}${"損益".padStart(11)}`,
  );

  let survivesTo = 0;
  for (const [spread, slippage] of [
    [1.0, 0.5],
    [2.0, 1.0],
    [3.0, 1.5],
    [5.0, 2.0],
    [8.0, 3.0],
  ]) {
    const stats = simulateFromSignals(
      baseScan,
      baseCandles,
      configFor(args, basePipSize, spread, slippage),
    ).stats;
    const be = breakEven(stats);
    const lb = lowerBound(stats);
    const margin = lb - be;
    if (margin > 0) survivesTo = spread;
    console.log(
      `  ${`${spread}/${slippage}`.padEnd(18)}${String(stats.trades).padStart(7)}${(fmt(stats.winRate) + "%").padStart(9)}` +
        `${(fmt(be) + "%").padStart(9)}${(fmt(lb) + "%").padStart(10)}${(fmt(margin) + "p").padStart(8)}` +
        `${fmt(stats.netPips, 0).padStart(11)}  ${margin > 0 ? "○" : "×"}`,
    );
  }
  console.log("");
  console.log(
    survivesTo > 0
      ? `  → スプレッド ${survivesTo} pips までは優位が残ります。`
      : "  → 最も安いコストでも優位が残りません。",
  );

  // ----------------------------------------------------------------
  // 2. 取引時刻の分布
  // ----------------------------------------------------------------
  console.log("");
  console.log("-".repeat(78));
  console.log("2. いつ発動しているか");
  console.log("-".repeat(78));
  if (args.timeframe === "daily") {
    console.log("日足なので時刻は 22:00 UTC 固定です。曜日の偏りだけを見ます。");
  } else {
    console.log("特定の時間帯に偏るなら、その時間帯の実際のスプレッドで測り直す必要があります。");
  }
  console.log("");

  const byDay = new Map<number, number>();
  const byHour = new Map<number, number>();
  for (const hit of baseScan.hits) {
    const d = new Date(baseCandles[hit.index].timestamp);
    byDay.set(d.getUTCDay(), (byDay.get(d.getUTCDay()) ?? 0) + 1);
    byHour.set(d.getUTCHours(), (byHour.get(d.getUTCHours()) ?? 0) + 1);
  }
  const dayNames = ["日", "月", "火", "水", "木", "金", "土"];
  const topDay = [...byDay.entries()].sort((a, b) => b[1] - a[1]);
  const topHour = [...byHour.entries()].sort((a, b) => b[1] - a[1]);
  const total = baseScan.hits.length;

  console.log(
    `  曜日: ${topDay.map(([d, n]) => `${dayNames[d]}${n}`).join(" ")}`,
  );
  if (args.timeframe !== "daily") {
    console.log(
      `  時刻(UTC): ${topHour.slice(0, 6).map(([h, n]) => `${h}時:${n}`).join(" ")}`,
    );
  }

  const concentration = total > 0 ? ((topDay[0]?.[1] ?? 0) / total) * 100 : 0;
  if (concentration > 60) {
    console.log("");
    console.log(
      `  ⚠ ${((topDay[0]?.[1] ?? 0) / total * 100).toFixed(0)}% が${dayNames[topDay[0][0]]}曜に偏っています。`,
    );
    if (topDay[0][0] === 0) {
      console.log("     日曜は週明けの窓開けで、実際のスプレッドは平常の数倍に開きます。");
      console.log("     上のコスト感応度は、その時間帯の実勢で読んでください。");
    }
  }

  // ----------------------------------------------------------------
  // 3. 他の通貨ペア
  // ----------------------------------------------------------------
  console.log("");
  console.log("-".repeat(78));
  console.log("3. 他の通貨ペアでも出るか");
  console.log("-".repeat(78));
  console.log("市場の性質を捉えているなら、程度の差はあれ他でも出ます。");
  console.log("1銘柄だけに出るものは、その銘柄の偶然です。");
  console.log("");
  console.log(
    `  ${"銘柄".padEnd(9)}${"件数".padStart(7)}${"勝率".padStart(9)}${"分岐".padStart(9)}${"95%下限".padStart(10)}${"余裕".padStart(8)}${"損益".padStart(11)}`,
  );

  const files = readdirSync(args.dir)
    .filter((f) => f.endsWith(suffixFor(args.timeframe)))
    .sort();

  let passed = 0;
  let evaluated = 0;
  for (const file of files) {
    const symbol = file.slice(0, 6).toUpperCase();
    const pipSize = pipSizeFor(symbol);
    const candles = loadCsv(`${args.dir}/${file}`);
    const scan = scanWideRule(rule, filter, buildWideContext(candles, pipSize), 0, candles.length);
    const stats = simulateFromSignals(
      scan,
      candles,
      configFor(args, pipSize, args.spreadPips, args.stopSlippagePips),
    ).stats;

    if (stats.trades < 10) {
      console.log(`  ${symbol.padEnd(9)}${String(stats.trades).padStart(7)}   件数不足`);
      continue;
    }
    evaluated++;
    const be = breakEven(stats);
    const lb = lowerBound(stats);
    const margin = lb - be;
    if (margin > 0) passed++;
    console.log(
      `  ${symbol.padEnd(9)}${String(stats.trades).padStart(7)}${(fmt(stats.winRate) + "%").padStart(9)}` +
        `${(fmt(be) + "%").padStart(9)}${(fmt(lb) + "%").padStart(10)}${(fmt(margin) + "p").padStart(8)}` +
        `${fmt(stats.netPips, 0).padStart(11)}  ${margin > 0 ? "○" : "×"}`,
    );
  }

  console.log("");
  console.log(`  分岐を有意に超えた銘柄: ${passed} / ${evaluated}`);
  console.log("");
  if (passed <= 1 && evaluated > 4) {
    console.log("  → 1銘柄でしか機能していません。**市場の性質ではなく、その銘柄の偶然**");
    console.log("     と考えるべきです。総当たりで選んだものなら、なおさらです。");
  } else if (passed >= Math.ceil(evaluated / 2)) {
    console.log("  → 半数以上の銘柄で機能しています。銘柄固有の偶然では説明しにくい形です。");
    console.log("     ただしこれで確定ではありません。前へ進めて記録してください。");
  } else {
    console.log("  → 一部の銘柄でだけ機能しています。何がその銘柄を特別にしているのか、");
    console.log("     説明がつくまでは採用しないでください。");
  }
}

try {
  main();
} catch (error: unknown) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
