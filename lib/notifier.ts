/**
 * シグナル通知
 *
 * 判定は毎回走るが、通知は「前回と変わったとき」だけ出す。
 * BUYが続いている間ずっと鳴り続けると通知の意味が無くなるため、
 * 状態の遷移（WAIT→BUY など）を検出して初めて送る。
 *
 * 送信先はWebhook（Discord / Slack）を既定にしているが、`Notifier` を
 * 差し替えればLINEでもメールでも同じ仕組みで使える。
 */
import { requiredAccuracy } from "./edgeMath";
import type { SignalResult, SignalType } from "./autoSignalEngine";
import type { TradePlan } from "./tradePlan";

/** 銘柄ごとに最後に通知した状態 */
export interface SignalState {
  [symbolId: string]: {
    signal: SignalType;
    /** 最後に判定した1H足の時刻 */
    barTime: number;
  };
}

/**
 * 通知の種類。
 *
 * シグナル（entry / cleared）以外に、監視そのものの状態を伝えるものがある。
 * 正常時の98.6%が無音になる作りなので、「静か」と「壊れている」を
 * 受け取る側で区別できるようにするために要る。
 */
export type NotificationKind =
  | "entry"
  | "cleared"
  /** 監視が止まっている */
  | "problem"
  /** 止まっていたものが戻った */
  | "recovered"
  /** 何も起きていないが動いている */
  | "heartbeat"
  /** 疎通確認 */
  | "test";

export interface Notification {
  kind: NotificationKind;
  /** 監視自体の知らせには銘柄が無い */
  symbolId: string | null;
  symbolLabel: string | null;
  signal: SignalType | null;
  previousSignal: SignalType | null;
  title: string;
  body: string;
}

/** 銘柄に紐づかない知らせ（監視の状態・疎通確認）を組み立てる */
export function systemNotification(
  kind: Extract<NotificationKind, "problem" | "recovered" | "heartbeat" | "test">,
  title: string,
  body: string,
): Notification {
  return {
    kind,
    symbolId: null,
    symbolLabel: null,
    signal: null,
    previousSignal: null,
    title,
    body,
  };
}

export interface EvaluationInput {
  symbolId: string;
  symbolLabel: string;
  digits: number;
  pipSize: number;
  result: SignalResult;
  tradePlan: TradePlan | null;
  /** 判定に使った最新1H足の時刻 */
  barTime: number;
  /**
   * 往復のコスト（pips）。損益分岐の的中率を出すのに使う。
   *
   * 通知に入れるため。**通知は画面と違って、注釈を読まずに行動できる。**
   * 深夜に届いた「BUY・損切りここ・利確ここ」だけを見て発注できてしまう
   * ので、その設定で何%当てれば±0なのかを同じ場所に書く。
   */
  costPips: number;
}

/**
 * 前回の状態と比べて、送るべき通知を決める。
 * 状態は書き換えず、次に保存すべき状態を一緒に返す（送信に失敗したら
 * 呼び出し側が保存を見送り、次回もう一度試せるようにするため）。
 */
export function diffSignals(
  previous: SignalState,
  evaluations: EvaluationInput[],
): { notifications: Notification[]; nextState: SignalState } {
  const nextState: SignalState = { ...previous };
  const notifications: Notification[] = [];

  for (const evaluation of evaluations) {
    const before = previous[evaluation.symbolId];
    const previousSignal = before?.signal ?? "WAIT";
    const current = evaluation.result.signal;

    nextState[evaluation.symbolId] = {
      signal: current,
      barTime: evaluation.barTime,
    };

    if (current === previousSignal) continue;

    if (current === "BUY" || current === "SELL") {
      notifications.push({
        kind: "entry",
        symbolId: evaluation.symbolId,
        symbolLabel: evaluation.symbolLabel,
        signal: current,
        previousSignal,
        title: `${evaluation.symbolLabel} ${current}`,
        body: formatEntryBody(evaluation),
      });
    } else if (previousSignal === "BUY" || previousSignal === "SELL") {
      notifications.push({
        kind: "cleared",
        symbolId: evaluation.symbolId,
        symbolLabel: evaluation.symbolLabel,
        signal: current,
        previousSignal,
        title: `${evaluation.symbolLabel} ${previousSignal} 解除`,
        body: `${previousSignal} の条件を満たさなくなりました（現在 WAIT）。`,
      });
    }
  }

  return { notifications, nextState };
}

function formatEntryBody(evaluation: EvaluationInput): string {
  const { result, tradePlan, digits, pipSize } = evaluation;
  const a = result.analysis;

  const lines = [
    `価格 ${a.currentPrice.toFixed(digits)}　信頼度 ${result.confidence}%`,
    `1H ${a.trend1H} / 4H ${a.trend4H} / 日足 ${a.trendDaily}　${a.timeSession}`,
    `RSI ${a.currentRSI.toFixed(1)}　ATR ${(a.currentATR / pipSize).toFixed(1)} pips`,
  ];

  if (tradePlan) {
    lines.push(
      `損切り ${tradePlan.stopLoss.toFixed(digits)} (${tradePlan.stopPips.toFixed(1)} pips) / ` +
        `利確 ${tradePlan.takeProfit.toFixed(digits)} (${tradePlan.targetPips.toFixed(1)} pips)`,
    );
  }

  const met = result.conditions.filter((c) => c.met).length;
  lines.push(`条件 ${met}/${result.conditions.length} 充足`);

  /*
   * 損益分岐の的中率を必ず添える。
   *
   * ここまでの行は「入る根拠」しか書いておらず、シグナル配信の売買推奨と
   * 見分けがつかない。README と画面には「この判定はランダムエントリーと
   * 区別がつかない」と書いてあるが、**通知はそれを読まずに行動できる**。
   *
   * 損切り幅とコストだけで決まる数字なので、相場が何をするかに関係なく
   * 成り立つ。実データで確認できた的中率（35.0%）と並べて出す。
   */
  if (tradePlan && tradePlan.stopPips > 0) {
    const breakEven = requiredAccuracy({
      stopDistancePips: tradePlan.stopPips,
      riskRewardRatio: tradePlan.targetPips / tradePlan.stopPips,
      costPips: evaluation.costPips,
    });
    if (Number.isFinite(breakEven.requiredWinRate)) {
      lines.push(
        `損益±0に必要な的中率 ${breakEven.requiredWinRate.toFixed(1)}%` +
          `（往復${evaluation.costPips} pips込み）`,
      );
    }
  }
  lines.push(
    "※ この判定は実データでランダムエントリーと区別がつきませんでした" +
      "（9年4か月・440件で勝率35.0%）。検証用です。",
  );

  return lines.join("\n");
}

/** 通知の送信先 */
export interface Notifier {
  send(notification: Notification): Promise<void>;
}

/**
 * Discord と Slack の両方に対応したWebhook送信。
 *
 * Discordは `content`、Slackは `text` を読む。両方入れて送ると、
 * それぞれが自分の知っているキーだけを使うので、URLを差し替えるだけで
 * どちらでも動く。
 */
/** 種類が一目で分かるようにする。文字だけだと通知一覧で埋もれる */
function emojiFor(notification: Notification): string {
  switch (notification.kind) {
    case "problem":
      return "🛑";
    case "recovered":
      return "✅";
    case "heartbeat":
      return "💤";
    case "test":
      return "🔔";
    case "cleared":
      return "⚪";
    default:
      return notification.signal === "BUY" ? "🟢" : "🔴";
  }
}

/**
 * `fetch` の失敗を、直せる形の文章にする。
 *
 * Node の `fetch` は接続できなかったとき `fetch failed` としか言わない。
 * 本当の原因（名前解決、接続拒否、証明書、タイムアウト）は `cause` に
 * 入っている。**Webhookの設定を確かめるための命令が「fetch failed」を
 * 返すのでは、何を直せばよいか分からない。**
 *
 * `--test-notification` は利用者が最初に打つ命令なので、ここだけは
 * 原因まで出す。
 */
export function describeFetchFailure(error: unknown): string {
  if (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")) {
    return "送信先が15秒以内に応答しませんでした。URLとネットワークを確認してください。";
  }

  const cause: unknown = error instanceof Error ? error.cause : undefined;
  const code =
    typeof cause === "object" && cause !== null && "code" in cause
      ? String(cause.code)
      : "";

  switch (code) {
    case "ECONNREFUSED":
      return "接続を拒否されました（ECONNREFUSED）。URLのホストとポートを確認してください。";
    case "ENOTFOUND":
    case "EAI_AGAIN":
      return `ホスト名を解決できませんでした（${code}）。URLの綴りとDNSを確認してください。`;
    case "ETIMEDOUT":
      return "接続がタイムアウトしました（ETIMEDOUT）。到達できるネットワークか確認してください。";
    case "CERT_HAS_EXPIRED":
    case "UNABLE_TO_VERIFY_LEAF_SIGNATURE":
    case "SELF_SIGNED_CERT_IN_CHAIN":
      return `証明書を検証できませんでした（${code}）。`;
    default:
      break;
  }

  const detail = cause instanceof Error ? cause.message : "";
  const base = error instanceof Error ? error.message : String(error);
  return detail ? `${base}: ${detail}` : base;
}

export function createWebhookNotifier(url: string): Notifier {
  return {
    async send(notification) {
      const emoji = emojiFor(notification);
      const message = `${emoji} **${notification.title}**\n${notification.body}`;

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15_000);
      try {
        let response: Response;
        try {
          response = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ content: message, text: message }),
            signal: controller.signal,
          });
        } catch (error) {
          // 届かなかった場合。HTTPエラーとは別で、原因が cause に隠れている
          throw new Error(describeFetchFailure(error));
        }
        if (!response.ok) {
          const detail = await response.text().catch(() => "");
          throw new Error(
            `Webhookが HTTP ${response.status} を返しました${detail ? `: ${detail.slice(0, 200)}` : ""}`,
          );
        }
      } finally {
        clearTimeout(timeout);
      }
    },
  };
}

/** 送信せず標準出力に書くだけの通知先。動作確認用 */
export function createConsoleNotifier(): Notifier {
  return {
    // interface を満たすために Promise を返すだけ。await するものは無い
    send(notification) {
      console.log(`[通知] ${notification.title}`);
      console.log(
        notification.body.split("\n").map((line) => `        ${line}`).join("\n"),
      );
      return Promise.resolve();
    },
  };
}
