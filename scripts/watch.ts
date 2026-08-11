/**
 * シグナル監視 & 通知
 *
 *   npm run watch                          # 5分ごとに判定して通知（常駐）
 *   npm run watch -- --once                # 1回だけ判定（cron / GitHub Actions 用）
 *   npm run watch -- --symbols USDJPY,GBPJPY --interval 300
 *   npm run watch -- --dry-run             # 送信せず標準出力に出す
 *   npm run watch -- --test-notification       # 送信先の設定を確かめる（1件送って終了）
 *   npm run watch -- --heartbeat 12            # 12時間無音なら「動いています」を送る
 *   npm run watch -- --heartbeat 0             # 生存確認を送らない
 *
 * 出したシグナルは --log のファイル（既定 .signal-log.jsonl）に追記する。
 * 後で `npm run reconcile` を実行すると、実際の値動きと突き合わせて
 * フォワードテストの成績が出せる。
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
import { appendSignalRecord } from "../lib/signalLog";
import {
  diffHealth,
  markNotified,
  INITIAL_HEALTH,
  type CycleOutcome,
  type HealthState,
} from "../lib/health";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import {
  createConsoleNotifier,
  createWebhookNotifier,
  diffSignals,
  systemNotification,
  type EvaluationInput,
  type Notifier,
} from "../lib/notifier";

interface Args {
  symbols: string[];
  once: boolean;
  intervalSeconds: number;
  statePath: string;
  logPath: string;
  dryRun: boolean;
  allowSynthetic: boolean;
  /** 何も送らないままこの時間が過ぎたら生存を知らせる（時間）。0で無効 */
  heartbeatHours: number;
  /** 疎通確認の1件だけ送って終わる */
  testNotification: boolean;
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
    logPath: map.get("log") ?? ".signal-log.jsonl",
    dryRun: flags.has("dry-run"),
    allowSynthetic: flags.has("allow-synthetic"),
    heartbeatHours: (() => {
      const raw = map.get("heartbeat");
      if (raw === undefined) return 24;
      const parsed = Number(raw);
      if (!Number.isFinite(parsed) || parsed < 0) {
        throw new Error(`--heartbeat は0以上の数値で指定してください: ${raw}`);
      }
      return parsed;
    })(),
    testNotification: flags.has("test-notification"),
  };
}

async function evaluateAll(
  symbolIds: string[],
  allowSynthetic: boolean,
  strategy: StrategyConfig,
): Promise<{ evaluations: EvaluationInput[]; outcome: CycleOutcome }> {
  const evaluations: EvaluationInput[] = [];
  // 「静か」と「壊れている」を区別するために、失敗の内訳を数える
  let noRealData = 0;
  let failed = 0;

  for (const symbolId of symbolIds) {
    const spec = getSymbolSpec(symbolId);
    try {
      const market = await fetchMarketData(spec.id);
      if (market.source === "synthetic" && !allowSynthetic) {
        // 合成データのシグナルで通知を出すと誤解を招くので送らない
        console.warn(`${spec.label}: 実データを取得できないため通知を見送ります（${market.note}）`);
        noRealData++;
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
      failed++;
    }
  }

  return {
    evaluations,
    outcome: {
      total: symbolIds.length,
      evaluated: evaluations.length,
      noRealData,
      failed,
    },
  };
}

/**
 * 監視の健康状態を、シグナルの状態とは別のファイルに置く。
 *
 * `SignalState` は銘柄IDを鍵にした形なので、そこへ特別な鍵を混ぜると
 * 銘柄と区別がつかなくなる。小さいので独立したファイルにする。
 */
function healthPathFor(statePath: string): string {
  return statePath.replace(/\.json$/, "") + ".health.json";
}

function loadHealth(path: string): HealthState {
  if (!existsSync(path)) return INITIAL_HEALTH;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<HealthState>;
    if (
      (parsed.status === "ok" || parsed.status === "no_data" || parsed.status === "failing") &&
      typeof parsed.since === "number" &&
      typeof parsed.lastNotifiedAt === "number"
    ) {
      return { status: parsed.status, since: parsed.since, lastNotifiedAt: parsed.lastNotifiedAt };
    }
  } catch {
    // 壊れていれば初期状態から数え直す。ここで落として監視ごと止めない
  }
  return INITIAL_HEALTH;
}

function saveHealth(path: string, state: HealthState): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2), "utf8");
  renameSync(tmp, path);
}

async function runOnce(args: Args, notifier: Notifier, strategy: StrategyConfig): Promise<void> {
  const stamp = new Date().toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" });
  const { evaluations, outcome } = await evaluateAll(args.symbols, args.allowSynthetic, strategy);

  const summary = evaluations
    .map((e) => `${e.symbolId}=${e.result.signal}`)
    .join(" ");
  console.log(`[${stamp}] ${summary || "判定できた銘柄がありません"}`);

  /*
   * 監視そのものの状態を先に片付ける。
   *
   * ここを判定できた場合だけに置くと、**全滅したときに何も起きない**という
   * いちばん知らせたい状況で黙ることになる。以前がその作りだった。
   */
  const healthPath = healthPathFor(args.statePath);
  const previousHealth = loadHealth(healthPath);
  const now = Date.now();
  const { notice, nextState: nextHealth } = diffHealth(previousHealth, outcome, {
    heartbeatMs: args.heartbeatHours * 3_600_000,
    now,
  });

  let healthToSave = nextHealth;
  if (notice) {
    try {
      await notifier.send(systemNotification(notice.kind, notice.title, notice.body));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`監視状態の通知に失敗しました: ${message}`);
      // 送れていないなら時計を進めない。次の周期でもう一度試す
      healthToSave = { ...nextHealth, lastNotifiedAt: previousHealth.lastNotifiedAt };
    }
  }

  if (evaluations.length === 0) {
    saveHealth(healthPath, healthToSave);
    return;
  }

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
    saveHealth(healthPath, healthToSave);
    return;
  }

  // 実際に出したシグナルを記録する。後で `npm run reconcile` で値動きと
  // 突き合わせ、バックテストの成績と一致するかを確かめるため。
  // 通知の成否とは切り離す（送信に失敗しても判定した事実は残す）。
  for (const notification of notifications) {
    if (notification.kind !== "entry") continue;
    const evaluation = evaluations.find((e) => e.symbolId === notification.symbolId);
    if (!evaluation?.tradePlan) continue;

    try {
      appendSignalRecord(args.logPath, {
        barTime: evaluation.barTime,
        recordedAt: Date.now(),
        symbolId: evaluation.symbolId,
        signal: notification.signal as "BUY" | "SELL",
        price: evaluation.tradePlan.entry,
        stopLoss: evaluation.tradePlan.stopLoss,
        takeProfit: evaluation.tradePlan.takeProfit,
        confidence: evaluation.result.confidence,
        session: evaluation.result.analysis.timeSession,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`シグナルの記録に失敗しました（${notification.title}）: ${message}`);
    }
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

  // シグナルを送ったなら、生存確認の時計も進める。
  // 直後に「動いています」が来るのは無意味なため
  saveHealth(healthPath, allSent ? markNotified(healthToSave, now) : healthToSave);
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

  /*
   * 疎通確認。
   *
   * これが無いと、Webhookのアドレスを打ち間違えても気づくのは最初の
   * シグナルが出たとき——平均4日後になる。`--allow-synthetic` は
   * 疎通確認用と書いてあったが、シグナルが出なければ何も送らないので
   * 確認の役に立っていなかった。
   */
  if (args.testNotification) {
    const target = webhookUrl ? "Webhook" : "標準出力";
    console.log(`疎通確認の通知を1件送ります（送信先: ${target}）。`);
    try {
      await notifier.send(
        systemNotification(
          "test",
          "疎通確認",
          "この通知が届いていれば、送信先の設定は正しく動いています。" +
            "実際のシグナルは1銘柄あたり平均4.3日に1回しか出ません。" +
            "静かな状態が続くのは正常です。",
        ),
      );
      console.log("送信しました。届いているか確認してください。");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`送信に失敗しました: ${message}`);
      process.exitCode = 1;
    }
    return;
  }

  // 最初のシグナルが出た瞬間に初めて失敗するのを避け、起動時に確かめる
  ensureStateWritable(args.statePath);

  console.log(`監視対象  : ${args.symbols.join(", ")}`);
  if (args.allowSynthetic) {
    console.warn("--allow-synthetic: 合成データでも通知します。疎通確認専用です。");
  }
  console.log(`状態ファイル: ${args.statePath}`);
  console.log(`記録ファイル: ${args.logPath}`);
  console.log(
    args.heartbeatHours > 0
      ? `生存確認    : ${args.heartbeatHours}時間 何も送らなければ「動いています」を送る`
      : "生存確認    : 無効（--heartbeat 0）",
  );
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
