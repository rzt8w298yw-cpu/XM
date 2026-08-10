/**
 * フォワードテストの照合
 *
 *   npm run reconcile
 *   npm run reconcile -- --log /var/lib/xm/signals.jsonl
 *   npm run reconcile -- --csv-1h data/usdjpy_1h.csv --symbol USDJPY
 *
 * `npm run watch` が記録したシグナルを、その後の実際の値動きと突き合わせる。
 *
 * バックテストが良くても実運用が同じになるとは限らない。ここで出る数字は
 * 「実際に出したシグナルがどうなったか」なので、バックテストの成績と
 * 食い違うなら、その差の原因を調べる価値がある。
 */
import { readFileSync } from "node:fs";
import { parseCandleCsv } from "../lib/csv";
import { fetchMarketData, getSymbolSpec } from "../lib/marketData";
import {
  readSignalLog,
  reconcileSignal,
  summarizeForwardTest,
  type ReconciledSignal,
  type SignalRecord,
} from "../lib/signalLog";
import type { OHLC } from "../lib/technicalAnalysis";

interface Args {
  logPath: string;
  csv1H?: string;
  symbolFilter?: string;
  maxHoldingBars: number;
  showTrades: number;
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
    logPath: map.get("log") ?? ".signal-log.jsonl",
    csv1H: map.get("csv-1h"),
    symbolFilter: map.get("symbol"),
    maxHoldingBars: num("max-holding", 120),
    showTrades: num("show", 15),
  };
}

function fmt(value: number, digits = 1): string {
  if (!Number.isFinite(value)) return "∞";
  return value.toFixed(digits);
}

async function candlesForSymbol(
  symbolId: string,
  csv1H: string | undefined,
): Promise<{ candles: OHLC[]; source: string }> {
  if (csv1H) {
    return { candles: parseCandleCsv(readFileSync(csv1H, "utf8")).candles, source: `CSV(${csv1H})` };
  }
  const market = await fetchMarketData(symbolId);
  return {
    candles: market.candles1H,
    source: market.source === "yahoo" ? "Yahoo Finance" : `合成データ（${market.note}）`,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const { records, malformed } = readSignalLog(args.logPath);

  console.log("=".repeat(76));
  console.log("フォワードテストの照合");
  console.log("=".repeat(76));
  console.log(`記録ファイル: ${args.logPath}`);
  console.log(`記録件数    : ${records.length}件${malformed > 0 ? `（読めなかった行 ${malformed}）` : ""}`);

  if (records.length === 0) {
    console.log("");
    console.log("照合できる記録がありません。");
    console.log("`npm run watch` を動かしてシグナルが記録されるのを待ってください。");
    return;
  }

  const symbolFilter = args.symbolFilter?.toUpperCase();
  const targets = symbolFilter
    ? records.filter((r) => r.symbolId === symbolFilter)
    : records;

  const bySymbol = new Map<string, SignalRecord[]>();
  for (const record of targets) {
    const list = bySymbol.get(record.symbolId);
    if (list) list.push(record);
    else bySymbol.set(record.symbolId, [record]);
  }

  const span = targets.length > 0
    ? `${new Date(Math.min(...targets.map((r) => r.barTime))).toISOString().slice(0, 16).replace("T", " ")} 〜 ` +
      `${new Date(Math.max(...targets.map((r) => r.barTime))).toISOString().slice(0, 16).replace("T", " ")}`
    : "なし";
  console.log(`対象期間    : ${span}（UTC）`);
  console.log("=".repeat(76));

  const all: ReconciledSignal[] = [];

  for (const [symbolId, group] of bySymbol) {
    const spec = getSymbolSpec(symbolId);
    let candles: OHLC[];
    let source: string;
    try {
      ({ candles, source } = await candlesForSymbol(symbolId, args.csv1H));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.log(`\n${spec.label}: 値動きを取得できませんでした: ${message}`);
      continue;
    }

    const results = group.map((record) =>
      reconcileSignal(record, candles, spec.pipSize, args.maxHoldingBars),
    );
    all.push(...results);

    const summary = summarizeForwardTest(results);
    console.log("");
    console.log(`${spec.label}  （値動き: ${source}）`);
    console.log(
      `  記録 ${summary.total}件 → 決着 ${summary.resolved} / 未決着 ${summary.open} / 照合不能 ${summary.noData}`,
    );
    if (summary.resolved > 0) {
      console.log(
        `  勝率 ${fmt(summary.winRate)}%（${summary.wins}勝 ${summary.losses}敗）　損益 ${fmt(summary.netPips)} pips`,
      );
    }
  }

  const overall = summarizeForwardTest(all);
  console.log("");
  console.log("=".repeat(76));
  console.log("合計");
  console.log("=".repeat(76));
  console.log(`記録 ${overall.total}件 → 決着 ${overall.resolved} / 未決着 ${overall.open} / 照合不能 ${overall.noData}`);

  if (overall.resolved === 0) {
    console.log("");
    console.log("まだ決着したシグナルがありません。");
    console.log("照合不能が多い場合は、記録より後の足が取得できていない可能性があります");
    console.log("（既定のYahoo取得は直近60日ぶんです）。");
    return;
  }

  console.log(`勝率 ${fmt(overall.winRate)}%（${overall.wins}勝 ${overall.losses}敗）`);
  console.log(`損益 ${fmt(overall.netPips)} pips　1件あたり ${fmt(overall.netPips / overall.resolved, 2)} pips`);
  console.log("");
  console.log("※ スプレッドは差し引いていません。バックテストの数字と比べる際は");
  console.log("   `--spread` ぶんだけこちらが有利に出ている点に注意してください。");

  if (overall.resolved < 30) {
    console.log("");
    console.log(`※ 決着 ${overall.resolved}件では勝率の振れ幅が大きく、実力の判断には足りません。`);
  }

  const resolved = all
    .filter((r) => r.outcome === "take_profit" || r.outcome === "stop_loss")
    .slice(-args.showTrades);

  if (resolved.length > 0) {
    console.log("");
    console.log(`直近の決着（最大${args.showTrades}件）:`);
    for (const item of resolved) {
      const when = new Date(item.record.barTime).toISOString().slice(0, 16).replace("T", " ");
      const spec = getSymbolSpec(item.record.symbolId);
      console.log(
        `  ${when}  ${item.record.symbolId.padEnd(7)} ${item.record.signal.padEnd(4)} ` +
          `${item.record.price.toFixed(spec.digits)} → ${fmt(item.pips ?? 0).padStart(7)} pips  ` +
          `${item.outcome === "take_profit" ? "利確" : "損切"}  ${item.barsToResolve}本`,
      );
    }
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
