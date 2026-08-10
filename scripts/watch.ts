/**
 * シグナル監視 & 通知
 *
 *   npm run watch                          # 5分ごとに判定して通知（常駐）
 *   npm run watch -- --once                # 1回だけ判定（cron / GitHub Actions 用）
 *   npm run watch -- --symbols USDJPY,GBPJPY --interval 300
 *   npm run watch -- --dry-run             # 送信せず標準出力に出す
 *   npm run watch -- --once --allow-synthetic  # Webhookの疎通確認（偽のシグナルを送る）
 *
 * 通知先は環境変数 SIGNAL_WEBHOOK_URL に Discord か Slack の Webhook URL を入れる。
 * 未設定なら送信せず標準出力に出す。
 *
 * 状態は --state で指定したファイル（既定 .signal-state.json）に保存し、
 * 前回と変わったときだけ通知する。cronで回す場合もこのファイルが引き継がれるよう
 * 永続化された場所を指定すること。
 */
import { generateSignal } from "../lib/autoSignalEngine";
import { fetchMarketData, getSymbolSpec, SYMBOLS } from "../lib/marketData";
import { buildTradePlan } from "../lib/tradePlan";
import { loadStrategyConfig, type StrategyConfig } from "../lib/strategyConfig";
import {
  ensureStateWritable,
  loadSignalState,
  saveSignalState,
} from "../lib/signalState";
import {
  createConsoleNotifier,
  createWebhookNotifier,
  diffSignals,
  type EvaluationInput,
  type Notifier,
} from "../lib/notifier";

interface Args {
  symbols: string[];
  once: boolean;
  intervalSeconds: number;
  statePath: string;
  dryRun: boolean;
  allowSynthetic: boolean;
}

function parseArgs(argv: string[]): Args {
  const map = new Map<string, string>();
  const flags = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith("--")) continue;
    const name = token.slice(2);
    const eq = name.indexOf("=");
    if (eq !== -1) {
      map.set(name.slice(0, eq), name.slice(eq + 1));
      continue;
    }
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) flags.add(name);
    else {
      map.set(name, next);
      i++;
    }
  }

  const requested = map.get("symbols");
  const symbols = requested
    ? requested.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean)
    : SYMBOLS.map((s) => s.id);

  for (const symbol of symbols) {
    if (!SYMBOLS.some((s) => s.id === symbol)) {
      throw new Error(
        `未対応のシンボルです: ${symbol}（指定できるのは ${SYMBOLS.map((s) => s.id).join(", ")}）`,
      );
    }
  }

  const interval = Number(map.get("interval") ?? 300);
  if (!Number.isFinite(interval) || interval < 30) {
    throw new Error("--interval は30秒以上で指定してください");
  }

  return {
    symbols,
    once: flags.has("once"),
    intervalSeconds: interval,
    statePath: map.get("state") ?? ".signal-state.json",
    dryRun: flags.has("dry-run"),
    allowSynthetic: flags.has("allow-synthetic"),
  };
}

async function evaluateAll(
  symbolIds: string[],
  allowSynthetic: boolean,
  strategy: StrategyConfig,
): Promise<EvaluationInput[]> {
  const evaluations: EvaluationInput[] = [];

  for (const symbolId of symbolIds) {
    const spec = getSymbolSpec(symbolId);
    try {
      const market = await fetchMarketData(spec.id);
      if (market.source === "synthetic" && !allowSynthetic) {
        // 合成データのシグナルで通知を出すと誤解を招くので送らない
        console.warn(`${spec.label}: 実データを取得できないため通知を見送ります（${market.note}）`);
        continue;
      }

      const result = generateSignal(
        market.candles1H, market.candles4H, market.candlesDaily, market.candles8H,
        { thresholds: strategy.thresholds },
      );
      evaluations.push({
        symbolId: spec.id,
        // 合成データを通した場合は通知本文で分かるようにする
        symbolLabel: market.source === "synthetic" ? `${spec.label}（テスト）` : spec.label,
        digits: spec.digits,
        pipSize: spec.pipSize,
        result,
        tradePlan: buildTradePlan(
          result.signal, result.analysis.currentPrice, result.analysis.currentATR, spec.pipSize,
          {
            atrStopMultiplier: strategy.atrStopMultiplier,
            riskRewardRatio: strategy.riskRewardRatio,
          },
        ),
        barTime: market.candles1H.at(-1)?.timestamp ?? Date.now(),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`${spec.label}: 判定に失敗しました: ${message}`);
    }
  }

  return evaluations;
}

async function runOnce(args: Args, notifier: Notifier, strategy: StrategyConfig): Promise<void> {
  const stamp = new Date().toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" });
  const evaluations = await evaluateAll(args.symbols, args.allowSynthetic, strategy);

  const summary = evaluations
    .map((e) => `${e.symbolId}=${e.result.signal}`)
    .join(" ");
  console.log(`[${stamp}] ${summary || "判定できた銘柄がありません"}`);

  if (evaluations.length === 0) return;

  const { state: previous, problem } = loadSignalState(args.statePath);
  if (problem !== null) {
    console.warn(
      `状態ファイルを読めませんでした（${args.statePath}）: ${problem}。初回として扱います。`,
    );
  }
  const { notifications, nextState } = diffSignals(previous, evaluations);

  if (notifications.length === 0) {
    // 変化が無くても、最後に見た足の時刻は更新しておく
    saveSignalState(args.statePath, nextState);
    return;
  }

  let allSent = true;
  for (const notification of notifications) {
    try {
      await notifier.send(notification);
    } catch (error) {
      allSent = false;
      const message = error instanceof Error ? error.message : String(error);
      console.error(`通知の送信に失敗しました（${notification.title}）: ${message}`);
    }
  }

  // 送信に失敗したものがあれば状態を進めず、次回もう一度通知を試みる
  if (allSent) saveSignalState(args.statePath, nextState);
  else console.error("状態を更新しませんでした。次回の実行で再送を試みます。");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const webhookUrl = process.env.SIGNAL_WEBHOOK_URL;
  const { config: strategy, overrides, warnings } = loadStrategyConfig();
  for (const warning of warnings) console.warn(`戦略設定: ${warning}`);

  const notifier =
    args.dryRun || !webhookUrl ? createConsoleNotifier() : createWebhookNotifier(webhookUrl);

  if (!webhookUrl && !args.dryRun) {
    console.warn("SIGNAL_WEBHOOK_URL が未設定です。標準出力に出力します。");
  }

  // 最初のシグナルが出た瞬間に初めて失敗するのを避け、起動時に確かめる
  ensureStateWritable(args.statePath);

  console.log(`監視対象  : ${args.symbols.join(", ")}`);
  if (args.allowSynthetic) {
    console.warn("--allow-synthetic: 合成データでも通知します。疎通確認専用です。");
  }
  console.log(`状態ファイル: ${args.statePath}`);
  console.log(
    overrides.length > 0 ? `戦略設定  : ${overrides.join(" ")}` : "戦略設定  : 既定値",
  );
  console.log(
    args.once ? "1回だけ判定します。" : `${args.intervalSeconds}秒ごとに判定します（Ctrl+Cで終了）。`,
  );

  if (args.once) {
    await runOnce(args, notifier, strategy);
    return;
  }

  let stopping = false;
  process.on("SIGINT", () => {
    stopping = true;
    console.log("\n終了します。");
    process.exit(0);
  });

  // 起動直後に1回走らせ、以降は間隔をあけて繰り返す。
  // 1周期の失敗で監視ごと止まると、以降のシグナルを黙って取りこぼす。
  // 失敗は記録して次の周期で立て直す。
  let consecutiveFailures = 0;
  while (!stopping) {
    try {
      await runOnce(args, notifier, strategy);
      consecutiveFailures = 0;
    } catch (error) {
      consecutiveFailures++;
      const message = error instanceof Error ? error.message : String(error);
      console.error(
        `判定に失敗しました（連続${consecutiveFailures}回）: ${message}。次の周期で再試行します。`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, args.intervalSeconds * 1000));
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
