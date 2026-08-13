/**
 * ドル円の勝率を上げるロジックを総当たりで探す
 *
 *   npm run search-usdjpy
 *   npm run search-usdjpy -- --target 60 --spread 2.0 --slippage 1.0
 *
 * テクニカル分析の主要な流派（順張り・逆張り・ブレイクアウト・
 * プライスアクション・価格構造・時間）を、フィルターと決済条件の
 * 全組み合わせで試す。
 *
 * ## 4つの関門
 *
 * 総当たりは必ず何かを見つける。1万通り試せば、優位性がゼロでも
 * 500通りは「5%水準で有意」になる。だから見つけたものを順に落とす:
 *
 * 1. **IS（前半70%）** で勝率が目標以上、かつ損益分岐を超えている
 * 2. **OOS（後半30%）** でも同じ条件を満たす。ここは探索に一切使わない
 * 3. **ランダムエントリー** の散らばりの外にある
 * 4. **信頼区間** — その件数で、勝率が損益分岐を有意に超えている
 *
 * 4つ目が本命。前回12通貨ペアで探したときは、3つ目まで通った4件が
 * すべてここで落ちた。勝率74.2%・損益分岐73.5%・287件は、95%下限が
 * 69.1%で分岐を割る。**「勝っているように見える」と「勝っていると
 * 言える」は別。**
 *
 * ## 試行回数を隠さない
 *
 * 最後に必ず試行回数と、偶然だけで期待される通過数を出す。これを
 * 書かない探索結果は読めない。
 */
import { readFileSync } from "node:fs";
import {
  compareWithControl,
  runRandomEntryControl,
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
  type RuleFilter,
  type WideRule,
} from "../lib/wideRules";
import type { OHLC } from "../lib/technicalAnalysis";

function requireFilter(id: string): RuleFilter {
  const found = FILTERS.find((f) => f.id === id);
  if (!found) throw new Error(`フィルターがありません: ${id}`);
  return found;
}

const NO_FILTER = requireFilter("none");

interface Args {
  csv1H: string;
  csvDaily: string;
  target: number;
  minTrades: number;
  isShare: number;
  spreadPips: number;
  stopSlippagePips: number;
  controlRuns: number;
  show: number;
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
    csv1H: map.get("csv-1h") ?? "data/usdjpy_h1_utc.csv",
    csvDaily: map.get("csv-daily") ?? "data/usdjpy_d1_utc.csv",
    target: num("target", 60),
    minTrades: num("min-trades", 100),
    isShare: num("is-share", 0.7),
    spreadPips: num("spread", 1.0),
    stopSlippagePips: num("slippage", 0.5),
    controlRuns: num("control", 10),
    show: num("show", 25),
  };
}

type Timeframe = "hourly" | "daily";

const PIP_SIZE = 0.01;
const STOP_MULTIPLIERS = [0.5, 0.75, 1.0, 1.5, 2.0, 3.0];

/**
 * 利確幅（損切りに対する比）。
 *
 * 勝率を上げたいなら利確を近づける方向（比を小さく）だが、そこは損益分岐が
 * 急に上がる領域でもある。0.3 から 3.0 まで細かく振って、どこかに窓が
 * 空いていないかを見る。
 */
const RISK_REWARDS = [0.3, 0.4, 0.5, 0.6, 0.7, 0.75, 0.9, 1.0, 1.25, 1.5, 2.0, 3.0];

/**
 * 決済されないまま持ち続ける上限。
 *
 * 損切りにも利確にも触れないまま時間が過ぎた場合にどこで諦めるか。
 * 短く切ると勝率は下がるが1件あたりの損失も小さくなる——ここも
 * 勝率を動かす要因なので、固定せずに振る。
 */
const HOLDING_BARS: Record<Timeframe, number[]> = {
  hourly: [24, 72, 120],
  daily: [5, 10, 20],
};

interface Candidate {
  timeframe: Timeframe;
  rule: WideRule;
  filter: RuleFilter;
  stopMultiplier: number;
  riskReward: number;
  maxHoldingBars: number;
  is: BacktestStats;
  isBreakEven: number;
}

function fmt(value: number, digits = 1): string {
  if (!Number.isFinite(value)) return "∞";
  return value.toFixed(digits);
}

/**
 * 実測の平均利益・平均損失から損益分岐勝率を出す。
 *
 * 想定のリスクリワードから出すとずれる。利確に届かず時間切れで閉じた
 * ぶん、実際の平均利益は利確幅より小さくなるため。
 */
function breakEvenFromStats(stats: BacktestStats): number {
  if (stats.wins === 0 || stats.losses === 0) return NaN;
  const avgWin = stats.grossProfitPips / stats.wins;
  const avgLoss = stats.grossLossPips / stats.losses;
  if (!(avgWin > 0) || !(avgLoss > 0)) return NaN;
  return (avgLoss / (avgWin + avgLoss)) * 100;
}

/**
 * 勝率の95%信頼区間の下限。
 *
 * これが損益分岐を上回って初めて「その件数では偶然で説明できない」と
 * 言える。件数が少ないほど下限は下がるので、勝率だけを見て採用すると
 * 必ずここで足をすくわれる。
 */
function winRateLowerBound(stats: BacktestStats): number {
  if (stats.trades === 0) return NaN;
  const p = stats.winRate / 100;
  const standardError = Math.sqrt((p * (1 - p)) / stats.trades) * 100;
  return stats.winRate - 1.96 * standardError;
}

function configFor(
  timeframe: Timeframe,
  stopMultiplier: number,
  riskReward: number,
  maxHoldingBars: number,
  args: Args,
): BacktestConfig {
  return {
    pipSize: PIP_SIZE,
    atrStopMultiplier: stopMultiplier,
    riskRewardRatio: riskReward,
    spreadPips: args.spreadPips,
    stopSlippagePips: args.stopSlippagePips,
    windowSize: 250,
    maxHoldingBars,
    useStops: true,
    // 日足の足は 22:00 UTC 固定で、ロンドンにもNYにも当たらない。
    // 絞ったままだと対照の候補が空になる
    restrictToSessions: timeframe !== "daily",
  };
}

function loadCsv(path: string): OHLC[] {
  return parseCandleCsv(readFileSync(path, "utf8")).candles;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const series: { timeframe: Timeframe; candles: OHLC[] }[] = [
    { timeframe: "hourly", candles: loadCsv(args.csv1H) },
    { timeframe: "daily", candles: loadCsv(args.csvDaily) },
  ];

  const totalCombinations = series.reduce(
    (sum, { timeframe }) =>
      sum +
      WIDE_RULES.length *
        FILTERS.length *
        STOP_MULTIPLIERS.length *
        RISK_REWARDS.length *
        HOLDING_BARS[timeframe].length,
    0,
  );

  console.log("=".repeat(78));
  console.log("ドル円 — 勝率の総当たり探索");
  console.log("=".repeat(78));
  console.log(`ルール      : ${WIDE_RULES.length}件（順張り・逆張り・ブレイクアウト・値動き・構造・時間）`);
  console.log(`フィルター  : ${FILTERS.length}件`);
  console.log(
    `決済        : 損切り${STOP_MULTIPLIERS.length}通り × 利確${RISK_REWARDS.length}通り × 保有上限3通り`,
  );
  console.log(`足          : 1時間足 ${series[0].candles.length}本 / 日足 ${series[1].candles.length}本`);
  console.log(`組み合わせ  : ${totalCombinations.toLocaleString()}通り`);
  console.log("");
  console.log(`目標        : 勝率 ${args.target}% 以上 かつ 損益分岐超え`);
  console.log(`最低件数    : ${args.minTrades}件`);
  console.log(`コスト      : スプレッド ${args.spreadPips}pips / 滑り ${args.stopSlippagePips}pips`);
  console.log("");

  // ------------------------------------------------------------------
  // 関門1: IS
  // ------------------------------------------------------------------
  const candidates: Candidate[] = [];
  let scanned = 0;
  /** `none` と同じ結果になり、数えても意味がなかった組み合わせ */
  let degenerate = 0;

  for (const { timeframe, candles } of series) {
    const splitAt = Math.floor(candles.length * args.isShare);
    const ctx = buildWideContext(candles, PIP_SIZE);

    for (const rule of WIDE_RULES) {
      for (const filter of FILTERS) {
        scanned++;
        process.stdout.write(
          `  走査 ${scanned}/${series.length * WIDE_RULES.length * FILTERS.length}  ${timeframe} ${rule.id} + ${filter.id}          \r`,
        );

        const scan = scanWideRule(rule, filter, ctx, 0, splitAt);
        if (scan.hits.length < args.minTrades) continue;

        /*
         * 縮退したフィルターを数えない。
         *
         * 日足の足の時刻は 22:00 UTC で固定なので、時間帯フィルターは
         * 「全部通す」か「全部落とす」のどちらかにしかならない。前者は
         * `none` と同じ結果を返し、**同じ検定を2回数えることになる。**
         * 実際、最初の実行では日足の `engulfing + none` と
         * `engulfing + hours_18_24` が1桁まで同じ数字で並んだ。
         *
         * 試行回数を水増しするだけでなく、「複数の条件で確認できた」と
         * 誤読させるので、`none` と同じ結果になるフィルターは飛ばす。
         */
        if (filter.id !== "none") {
          const plain = scanWideRule(rule, NO_FILTER, ctx, 0, splitAt);
          if (plain.hits.length === scan.hits.length) {
            degenerate++;
            continue;
          }
        }

        for (const stopMultiplier of STOP_MULTIPLIERS) {
          for (const riskReward of RISK_REWARDS) {
            for (const maxHoldingBars of HOLDING_BARS[timeframe]) {
              const cfg = configFor(timeframe, stopMultiplier, riskReward, maxHoldingBars, args);
              const stats = simulateFromSignals(scan, candles, cfg).stats;

              if (stats.trades < args.minTrades) continue;
              if (stats.winRate < args.target) continue;
              if (stats.netPips <= 0) continue;

              const isBreakEven = breakEvenFromStats(stats);
              if (!Number.isFinite(isBreakEven)) continue;
              if (stats.winRate <= isBreakEven) continue;

              candidates.push({
                timeframe,
                rule,
                filter,
                stopMultiplier,
                riskReward,
                maxHoldingBars,
                is: stats,
                isBreakEven,
              });
            }
          }
        }
      }
    }
  }

  console.log(" ".repeat(78) + "\r");
  console.log("-".repeat(78));
  if (degenerate > 0) {
    const skipped = degenerate * STOP_MULTIPLIERS.length * RISK_REWARDS.length * 3;
    console.log(
      `縮退して除外      : ${skipped.toLocaleString()}通り（フィルターが none と同じ結果になるもの）`,
    );
  }
  console.log(`関門1（IS 前半70%）  : ${candidates.length} / ${totalCombinations.toLocaleString()} 通過`);

  if (candidates.length === 0) {
    console.log("");
    console.log("前半のデータですら条件を満たすものがありません。");
    console.log("ISは過学習し放題（後半を隠しているだけ）なので、ここで見つからないなら");
    console.log("この探索空間に該当する点はありません。");
    return;
  }

  // ------------------------------------------------------------------
  // 関門2: OOS
  // ------------------------------------------------------------------
  interface Survivor {
    candidate: Candidate;
    oos: BacktestStats;
    oosBreakEven: number;
    lowerBound: number;
  }
  const oosSurvivors: Survivor[] = [];

  // 走査は (足, ルール, フィルター) ごとに1回で済む
  const oosScanCache = new Map<string, ReturnType<typeof scanWideRule>>();
  const contextCache = new Map<Timeframe, ReturnType<typeof buildWideContext>>();
  for (const { timeframe, candles } of series) {
    contextCache.set(timeframe, buildWideContext(candles, PIP_SIZE));
  }

  for (const c of candidates) {
    const entry = series.find((s) => s.timeframe === c.timeframe);
    if (!entry) continue;
    const { candles } = entry;
    const splitAt = Math.floor(candles.length * args.isShare);

    const key = `${c.timeframe}|${c.rule.id}|${c.filter.id}`;
    let scan = oosScanCache.get(key);
    if (!scan) {
      const ctx = contextCache.get(c.timeframe);
      if (!ctx) continue;
      scan = scanWideRule(c.rule, c.filter, ctx, splitAt, candles.length);
      oosScanCache.set(key, scan);
    }

    const cfg = configFor(
      c.timeframe,
      c.stopMultiplier,
      c.riskReward,
      c.maxHoldingBars,
      args,
    );
    const oos = simulateFromSignals(scan, candles, cfg).stats;
    const oosBreakEven = breakEvenFromStats(oos);

    if (oos.trades < 20) continue;
    if (oos.winRate < args.target) continue;
    if (oos.netPips <= 0) continue;
    if (!Number.isFinite(oosBreakEven)) continue;
    if (oos.winRate <= oosBreakEven) continue;

    oosSurvivors.push({
      candidate: c,
      oos,
      oosBreakEven,
      lowerBound: winRateLowerBound(oos),
    });
  }

  console.log(`関門2（OOS 後半30%）: ${oosSurvivors.length} / ${candidates.length} 通過`);

  if (oosSurvivors.length === 0) {
    console.log("");
    console.log("ISで条件を満たしたものは、すべてOOSで崩れました。");
    console.log(`${totalCombinations.toLocaleString()}通り試して前半では ${candidates.length} 件が目標を`);
    console.log("満たしましたが、そのどれも後半では再現しません。これは前半に");
    console.log("合わせて選んだことの結果であって、判定の性能ではありません。");
    return;
  }

  // ------------------------------------------------------------------
  // 関門3: ランダムエントリー
  // ------------------------------------------------------------------
  const beatRandom: Survivor[] = [];
  for (const s of oosSurvivors) {
    const entry = series.find((x) => x.timeframe === s.candidate.timeframe);
    if (!entry) continue;
    const ctx = contextCache.get(s.candidate.timeframe);
    if (!ctx) continue;

    const cfg = configFor(
      s.candidate.timeframe,
      s.candidate.stopMultiplier,
      s.candidate.riskReward,
      s.candidate.maxHoldingBars,
      args,
    );
    const controls: BacktestStats[] = [];
    for (let i = 0; i < args.controlRuns; i++) {
      controls.push(
        runRandomEntryControl(entry.candles, ctx.atr, s.oos.trades, 1 + i * 7919, cfg).stats,
      );
    }
    if (compareWithControl(s.oos, controls).verdict === "above") beatRandom.push(s);
  }

  console.log(`関門3（ランダム超え）: ${beatRandom.length} / ${oosSurvivors.length} 通過`);

  // ------------------------------------------------------------------
  // 関門4: 信頼区間
  // ------------------------------------------------------------------
  const significant = beatRandom.filter((s) => s.lowerBound > s.oosBreakEven);
  console.log(`関門4（信頼区間）    : ${significant.length} / ${beatRandom.length} 通過`);
  console.log("-".repeat(78));

  const shown = (significant.length > 0 ? significant : beatRandom.length > 0 ? beatRandom : oosSurvivors)
    .slice()
    .sort((a, b) => b.lowerBound - b.oosBreakEven - (a.lowerBound - a.oosBreakEven))
    .slice(0, args.show);

  if (shown.length > 0) {
    console.log("");
    console.log(
      significant.length > 0
        ? "4つの関門をすべて通過したもの:"
        : "最後まで残ったもの（関門4は通過していません）:",
    );
    console.log("");
    console.log(
      `  ${"足".padEnd(7)}${"ルール".padEnd(22)}${"フィルター".padEnd(17)}${"損切り".padStart(6)}${"RR".padStart(6)}${"保有".padStart(6)}${"件数".padStart(7)}${"勝率".padStart(8)}${"分岐".padStart(8)}${"95%下限".padStart(9)}${"余裕".padStart(8)}`,
    );
    for (const s of shown) {
      const c = s.candidate;
      const margin = s.lowerBound - s.oosBreakEven;
      console.log(
        `  ${(c.timeframe === "daily" ? "日足" : "1H").padEnd(7)}${c.rule.id.padEnd(22)}${c.filter.id.padEnd(17)}` +
          `${fmt(c.stopMultiplier, 2).padStart(6)}${fmt(c.riskReward, 2).padStart(6)}${String(c.maxHoldingBars).padStart(6)}${String(s.oos.trades).padStart(7)}` +
          `${(fmt(s.oos.winRate) + "%").padStart(8)}${(fmt(s.oosBreakEven) + "%").padStart(8)}` +
          `${(fmt(s.lowerBound) + "%").padStart(9)}${(fmt(margin) + "p").padStart(8)}`,
      );
    }
  }

  // ------------------------------------------------------------------
  // 試行回数の話
  // ------------------------------------------------------------------
  console.log("");
  console.log("=".repeat(78));
  console.log("試行回数");
  console.log("=".repeat(78));
  console.log(`試した組み合わせ: ${totalCombinations.toLocaleString()}通り`);
  console.log("");

  // 関門3は「10本のランダム全部を上回る」なので、優位性ゼロでも
  // 1/11 の確率で通る。関門2を通った数に掛ければ、偶然の期待値が出る
  const expectedByChance = oosSurvivors.length / (args.controlRuns + 1);
  console.log(
    `関門3を偶然だけで通る期待数: ${expectedByChance.toFixed(1)}件（実際 ${beatRandom.length}件）`,
  );
  console.log("  ランダム10本の最大値を超える確率は、優位性が無くても 1/11 あります。");
  console.log("");

  if (significant.length === 0) {
    console.log("**勝率が損益分岐を有意に超えるものは、1つもありませんでした。**");
    console.log("");
    console.log("勝率だけなら目標を超えるものは見つかります。しかしその勝率で");
    console.log("損益分岐を超えているか、そしてその件数でそう言えるかまで見ると、");
    console.log("残りません。勝率は利確の置き方で決まる数字で、近づければ上がり、");
    console.log("同時に損益分岐も上がるからです。");
  } else {
    console.log("上に残ったものも、これで確定ではありません。");
    console.log(`${totalCombinations.toLocaleString()}通り試したうちの ${significant.length} 件です。`);
    console.log("実際に前へ進めて記録するまで、偶然の可能性は消えません。");
    console.log("");
    console.log("  npm run edge -- --win-rate <勝率> --avg-win <平均利益> --avg-loss <平均損失>");
    console.log("  で必要トレード数を出し、それだけの実績を貯めてから判断してください。");
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
