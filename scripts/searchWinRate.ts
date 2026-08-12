/**
 * 勝率60%以上で、かつ勝てる組み合わせを総当たりで探す
 *
 *   npx tsx scripts/searchWinRate.ts --dir data
 *   npx tsx scripts/searchWinRate.ts --dir data --target 60 --min-trades 100
 *
 * ## なぜ「勝率60%」だけを目標にしてはいけないか
 *
 * 勝率は利確の置き方でいくらでも上がる。利確を損切りの半分にすれば
 * 勝率62.9%は既に出ている。そして866 pipsの負けになる。**勝率は
 * 判定ロジックの性能ではなく、決済幅の関数である。**
 *
 * 損益が±0になる勝率は次で決まる:
 *
 *     p = (損切り + コスト) / (利確 + 損切り)
 *
 * 利確を近づけるほど p は上がる。勝率が上がっても p がそれ以上に
 * 上がっていれば、勝率60%は負けを意味する。だからここでは
 * **「勝率が目標以上」かつ「損益分岐を超えている」**の両方を課す。
 *
 * ## 探索の設計
 *
 * エントリー判定は決済パラメータに依存しない。だから足の走査は
 * (銘柄 × ルール) につき1回だけ行い、その結果に対して決済条件を
 * 総当たりする。これで探索空間を桁で広げられる。
 *
 * ## 見つけたものを信じる前に
 *
 * 総当たりは必ず何かを見つける。5000通り試して p<0.05 のものが
 * 250個出るのは、優位性ではなく試行回数の帰結である。だから:
 *
 * 1. 前半70%（IS）だけで探し、後半30%（OOS）は探索に一切使わない
 * 2. ISで条件を満たしたものだけをOOSで確かめる
 * 3. 生き残ったものをランダムエントリーと比べる
 * 4. 試行回数を明示し、偶然に期待される件数と比べる
 *
 * この4つを1つでも省くと、偶然を実力と読み違える。
 */
import { readdirSync, readFileSync } from "node:fs";
import {
  compareWithControl,
  runRandomEntryControl,
  simulateFromSignals,
  type BacktestConfig,
  type BacktestStats,
} from "../lib/backtest";
import { parseCandleCsv } from "../lib/csv";
import { ALL_RULES, buildContext, scanRule, type EntryRule } from "../lib/hypotheses";
import type { OHLC } from "../lib/technicalAnalysis";

interface Args {
  dir: string;
  /** 目標勝率（%） */
  target: number;
  /** これ未満の件数は偶然の幅が大きすぎるので採用しない */
  minTrades: number;
  /** IS に使う割合 */
  isShare: number;
  spreadPips: number;
  stopSlippagePips: number;
  symbolFilter?: string;
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
    dir: map.get("dir") ?? "data",
    target: num("target", 60),
    minTrades: num("min-trades", 100),
    isShare: num("is-share", 0.7),
    spreadPips: num("spread", 1.0),
    stopSlippagePips: num("slippage", 0.5),
    symbolFilter: map.get("symbol")?.toUpperCase(),
  };
}

/**
 * 決済条件の格子。
 *
 * 損切り幅（ATR倍率）と利確幅（損切りに対する比）を振る。勝率を
 * 上げたいなら利確を近づける方向（RRを小さく）だが、そこは損益分岐が
 * 急に上がる領域でもある。両方向に十分振って、どこかに窓が空いて
 * いないかを見る。
 */
const STOP_MULTIPLIERS = [0.5, 0.75, 1.0, 1.5, 2.0, 3.0];
const RISK_REWARDS = [0.4, 0.5, 0.6, 0.75, 1.0, 1.25, 1.5, 2.0];

interface Candidate {
  symbol: string;
  rule: EntryRule;
  stopMultiplier: number;
  riskReward: number;
  is: BacktestStats;
  /** その設定で損益が±0になる勝率 */
  breakEvenWinRate: number;
}

function specFromFilename(path: string): { symbol: string; pipSize: number } {
  const symbol = (path.split("/").pop() ?? "").slice(0, 6).toUpperCase();
  if (symbol.startsWith("XAU")) return { symbol, pipSize: 0.1 };
  if (symbol.endsWith("JPY")) return { symbol, pipSize: 0.01 };
  return { symbol, pipSize: 0.0001 };
}

function loadCsv(path: string): OHLC[] {
  return parseCandleCsv(readFileSync(path, "utf8")).candles;
}

function fmt(value: number, digits = 1): string {
  if (!Number.isFinite(value)) return "∞";
  return value.toFixed(digits);
}

/**
 * 実測の平均利益・平均損失から損益分岐勝率を出す。
 *
 * 想定のRRから出すと実態とずれる。利確に届かず時間切れで閉じた
 * トレードがあるぶん、実際の平均利益は利確幅より小さくなるため。
 */
function breakEvenFromStats(stats: BacktestStats): number {
  if (stats.wins === 0 || stats.losses === 0) return NaN;
  const avgWin = stats.grossProfitPips / stats.wins;
  const avgLoss = stats.grossLossPips / stats.losses;
  if (!(avgWin > 0) || !(avgLoss > 0)) return NaN;
  return (avgLoss / (avgWin + avgLoss)) * 100;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  console.log("=".repeat(78));
  console.log("勝率の総当たり探索");
  console.log("=".repeat(78));
  console.log(`目標          : 勝率 ${args.target}% 以上 かつ 損益分岐を超えている`);
  console.log(`最低件数      : ${args.minTrades}件`);
  console.log(`分割          : 前半${(args.isShare * 100).toFixed(0)}%で探索 / 後半${((1 - args.isShare) * 100).toFixed(0)}%は触れない`);
  console.log(`コスト        : スプレッド ${args.spreadPips}pips / 滑り ${args.stopSlippagePips}pips`);
  console.log(
    `決済の格子    : 損切り ${STOP_MULTIPLIERS.length}通り × 利確 ${RISK_REWARDS.length}通り = ${STOP_MULTIPLIERS.length * RISK_REWARDS.length}通り`,
  );
  console.log("");

  const files = readdirSync(args.dir)
    .filter((f) => f.endsWith("_h1_utc.csv") || f.endsWith("_d1_utc.csv"))
    .sort();

  const candidates: Candidate[] = [];
  let combinationsTried = 0;

  for (const file of files) {
    const timeframe = file.endsWith("_d1_utc.csv") ? "daily" : "hourly";
    const { symbol, pipSize } = specFromFilename(file);
    if (args.symbolFilter && symbol !== args.symbolFilter) continue;

    const rules = ALL_RULES.filter((r) => r.timeframe === timeframe);
    if (rules.length === 0) continue;

    const candles = loadCsv(`${args.dir}/${file}`);
    if (candles.length < 500) continue;

    const splitAt = Math.floor(candles.length * args.isShare);
    const ctx = buildContext(candles);

    for (const rule of rules) {
      // 走査は1回だけ。決済条件はこの結果を使い回す
      const scanIS = scanRule(rule, ctx, 0, splitAt);
      if (scanIS.hits.length === 0) continue;

      for (const stopMultiplier of STOP_MULTIPLIERS) {
        for (const riskReward of RISK_REWARDS) {
          combinationsTried++;

          const cfg: BacktestConfig = {
            pipSize,
            atrStopMultiplier: stopMultiplier,
            riskRewardRatio: riskReward,
            spreadPips: args.spreadPips,
            stopSlippagePips: args.stopSlippagePips,
            windowSize: 250,
            maxHoldingBars: timeframe === "daily" ? 20 : 120,
            useStops: true,
            // 日足の足は22:00 UTC固定でロンドン・NYに当たらない。
            // 絞ったままだと対照の候補が空になる
            restrictToSessions: timeframe !== "daily",
          };

          const result = simulateFromSignals(scanIS, candles, cfg);
          const stats = result.stats;
          if (stats.trades < args.minTrades) continue;
          if (stats.winRate < args.target) continue;

          // 勝率だけ満たしても、損益がマイナスなら意味がない
          if (stats.netPips <= 0) continue;

          const breakEvenWinRate = breakEvenFromStats(stats);
          if (!Number.isFinite(breakEvenWinRate)) continue;
          if (stats.winRate <= breakEvenWinRate) continue;

          candidates.push({
            symbol,
            rule,
            stopMultiplier,
            riskReward,
            is: stats,
            breakEvenWinRate,
          });
        }
      }
    }
    process.stdout.write(`  ${symbol} ${timeframe} 走査済み（候補 ${candidates.length}件）\r`);
  }

  console.log(" ".repeat(60) + "\r");
  console.log("-".repeat(78));
  console.log(`試した組み合わせ: ${combinationsTried}通り`);
  console.log(`ISで条件を満たした: ${candidates.length}件`);
  console.log("-".repeat(78));

  if (candidates.length === 0) {
    console.log("");
    console.log(`前半のデータですら、勝率${args.target}%以上で損益分岐を超えるものはありません。`);
    console.log("");
    console.log("これは「探し方が足りない」ではなく、探索空間にそういう点が");
    console.log("無いということです。ISは過学習し放題の条件（後半を隠して");
    console.log("いるだけで、前半については何度でも試せる）なので、ここで");
    console.log("見つからないなら、OOSで見つかることはありません。");
    return;
  }

  // ISの勝率が高い順。ただしこの順位自体に意味は無い（過学習の順位）
  candidates.sort((a, b) => b.is.winRate - a.is.winRate);

  console.log("");
  console.log("ISで条件を満たしたもの（上位20件）:");
  console.log("");
  console.log(
    `  ${"銘柄".padEnd(8)}${"ルール".padEnd(22)}${"損切り".padStart(7)}${"RR".padStart(6)}${"件数".padStart(7)}${"勝率".padStart(8)}${"分岐".padStart(8)}${"損益".padStart(11)}`,
  );
  for (const c of candidates.slice(0, 20)) {
    console.log(
      `  ${c.symbol.padEnd(8)}${c.rule.id.padEnd(22)}${fmt(c.stopMultiplier, 2).padStart(7)}${fmt(c.riskReward, 2).padStart(6)}${String(c.is.trades).padStart(7)}${(fmt(c.is.winRate) + "%").padStart(8)}${(fmt(c.breakEvenWinRate) + "%").padStart(8)}${fmt(c.is.netPips).padStart(11)}`,
    );
  }

  // ------------------------------------------------------------------
  // OOS。ここまで一度も触っていない後半で確かめる
  // ------------------------------------------------------------------
  console.log("");
  console.log("=".repeat(78));
  console.log("標本の外（OOS）で確かめる");
  console.log("=".repeat(78));
  console.log("ここまで一度も探索に使っていない後半のデータです。");
  console.log("");

  interface Survivor {
    candidate: Candidate;
    oos: BacktestStats;
    oosBreakEven: number;
  }
  const survivors: Survivor[] = [];

  for (const c of candidates) {
    const file = files.find(
      (f) =>
        f.toUpperCase().startsWith(c.symbol) &&
        f.endsWith(c.rule.timeframe === "daily" ? "_d1_utc.csv" : "_h1_utc.csv"),
    );
    if (!file) continue;

    const candles = loadCsv(`${args.dir}/${file}`);
    const splitAt = Math.floor(candles.length * args.isShare);
    const ctx = buildContext(candles);
    const scanOOS = scanRule(c.rule, ctx, splitAt, candles.length);
    const { pipSize } = specFromFilename(file);

    const cfg: BacktestConfig = {
      pipSize,
      atrStopMultiplier: c.stopMultiplier,
      riskRewardRatio: c.riskReward,
      spreadPips: args.spreadPips,
      stopSlippagePips: args.stopSlippagePips,
      windowSize: 250,
      maxHoldingBars: c.rule.timeframe === "daily" ? 20 : 120,
      useStops: true,
      restrictToSessions: c.rule.timeframe !== "daily",
    };
    const oos = simulateFromSignals(scanOOS, candles, cfg).stats;
    const oosBreakEven = breakEvenFromStats(oos);

    const held =
      oos.trades >= 20 &&
      oos.winRate >= args.target &&
      oos.netPips > 0 &&
      Number.isFinite(oosBreakEven) &&
      oos.winRate > oosBreakEven;

    if (held) survivors.push({ candidate: c, oos, oosBreakEven });
  }

  console.log(`OOSでも条件を満たした: ${survivors.length} / ${candidates.length}件`);
  console.log("");

  if (survivors.length === 0) {
    console.log("ISで条件を満たしたものは、すべてOOSで崩れました。");
    console.log("");
    console.log(`${combinationsTried}通り試して、前半では ${candidates.length} 件が`);
    console.log("目標を満たしました。そのどれも後半では再現しません。");
    console.log("これは「前半に合わせて選んだ」ことの結果であって、");
    console.log("エントリー判定の性能ではありません。");
    return;
  }

  console.log(
    `  ${"銘柄".padEnd(8)}${"ルール".padEnd(22)}${"損切り".padStart(7)}${"RR".padStart(6)}${"IS勝率".padStart(9)}${"OOS件数".padStart(9)}${"OOS勝率".padStart(9)}${"OOS分岐".padStart(9)}${"OOS損益".padStart(11)}`,
  );
  for (const s of survivors) {
    const c = s.candidate;
    console.log(
      `  ${c.symbol.padEnd(8)}${c.rule.id.padEnd(22)}${fmt(c.stopMultiplier, 2).padStart(7)}${fmt(c.riskReward, 2).padStart(6)}${(fmt(c.is.winRate) + "%").padStart(9)}${String(s.oos.trades).padStart(9)}${(fmt(s.oos.winRate) + "%").padStart(9)}${(fmt(s.oosBreakEven) + "%").padStart(9)}${fmt(s.oos.netPips).padStart(11)}`,
    );
  }

  // ------------------------------------------------------------------
  // 生き残りをランダムと比べる
  // ------------------------------------------------------------------
  console.log("");
  console.log("=".repeat(78));
  console.log("生き残りをランダムエントリーと比べる");
  console.log("=".repeat(78));

  for (const s of survivors) {
    const c = s.candidate;
    const file = files.find(
      (f) =>
        f.toUpperCase().startsWith(c.symbol) &&
        f.endsWith(c.rule.timeframe === "daily" ? "_d1_utc.csv" : "_h1_utc.csv"),
    );
    if (!file) continue;
    const candles = loadCsv(`${args.dir}/${file}`);
    const { pipSize } = specFromFilename(file);
    const cfg: BacktestConfig = {
      pipSize,
      atrStopMultiplier: c.stopMultiplier,
      riskRewardRatio: c.riskReward,
      spreadPips: args.spreadPips,
      stopSlippagePips: args.stopSlippagePips,
      windowSize: 250,
      maxHoldingBars: c.rule.timeframe === "daily" ? 20 : 120,
      useStops: true,
      restrictToSessions: c.rule.timeframe !== "daily",
    };
    const ctx = buildContext(candles);
    const controls: BacktestStats[] = [];
    for (let i = 0; i < 10; i++) {
      controls.push(
        runRandomEntryControl(candles, ctx.atr, s.oos.trades, 1 + i * 7919, cfg).stats,
      );
    }
    const comparison = compareWithControl(s.oos, controls);
    console.log("");
    console.log(`  ${c.symbol} / ${c.rule.id} / 損切り${c.stopMultiplier}ATR / RR 1:${c.riskReward}`);
    console.log(
      `    OOS勝率 ${fmt(s.oos.winRate)}%  ランダム ${fmt(comparison.lowestWinRate)}%〜${fmt(comparison.highestWinRate)}%  判定: ${comparison.verdict}`,
    );
    console.log(`    損益でランダムに並ばれた本数: ${comparison.beatenBy}/${comparison.runs}`);
  }

  // ------------------------------------------------------------------
  // 試行回数の話。ここを書かないと数字が独り歩きする
  // ------------------------------------------------------------------
  console.log("");
  console.log("=".repeat(78));
  console.log("読むときの注意");
  console.log("=".repeat(78));
  console.log(`試した組み合わせは ${combinationsTried} 通りです。`);
  console.log("");
  console.log("これだけ試せば、偶然だけでも条件を満たすものは出ます。");
  console.log("上に残ったものが本物かどうかは、ここから先——実際に前へ");
  console.log("進めて記録すること——でしか決まりません。");
  console.log("");
  console.log("採用する前に必ず確かめること:");
  console.log("  1. 件数は十分か（少ないほど偶然で説明できる）");
  console.log("  2. 勝率は損益分岐を「はっきり」超えているか（1〜2ポイント差は誤差）");
  console.log("  3. ランダムの散らばりの外にあるか");
  console.log("  4. npm run edge で必要トレード数を出し、それだけの実績があるか");
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
