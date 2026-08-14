/**
 * 通知の判定ロジックの検証。
 *
 * ここが壊れると、同じシグナルで鳴り続けるか、逆に鳴らなくなる。
 * どちらも通知として使い物にならないので、遷移の扱いを固定しておく。
 */
import { describe, expect, it, vi } from "vitest";
import {
  createWebhookNotifier,
  describeFetchFailure,
  diffSignals,
  type EvaluationInput,
  type SignalState,
} from "../lib/notifier";
import type { SignalResult, SignalType } from "../lib/autoSignalEngine";

function evaluation(symbolId: string, signal: SignalType, barTime = 1000): EvaluationInput {
  const result = {
    signal,
    confidence: 72,
    conditions: [
      { id: "trend_1h", name: "1H トレンド確認", category: "trend", met: true, value: "上昇トレンド", weight: 3 },
      { id: "rsi", name: "RSI水準", category: "confirmation", met: false, value: "RSI: 55.0", weight: 2 },
    ],
    analysis: {
      currentPrice: 150.123,
      confidence: 72,
      trend1H: "UP",
      trend4H: "UP",
      trendDaily: "UP",
      currentRSI: 55,
      currentATR: 0.2,
      timeSession: "LONDON",
    },
  } as unknown as SignalResult;

  return {
    symbolId,
    symbolLabel: symbolId,
    digits: 3,
    pipSize: 0.01,
    result,
    tradePlan: {
      entry: 150.123, stopLoss: 149.823, takeProfit: 150.723,
      stopPips: 30, targetPips: 60, riskRewardRatio: 2,
    },
    barTime,
    costPips: 2.3,
  };
}

describe("通知本文", () => {
  /*
   * 通知は画面と違って、注釈を読まずに行動できる。深夜に届いた
   * 「BUY・損切りここ・利確ここ」だけを見て発注できてしまうので、
   * **その設定で何%当てれば±0なのか**と、**この判定が検証を通って
   * いないこと**を同じ場所に書く。
   */
  it("損益分岐の的中率を添える", () => {
    const { notifications } = diffSignals({}, [evaluation("USDJPY", "BUY")]);
    // 損切り30pips / RR 1:2 / コスト2.3pips → (30+2.3)/(60+30) = 35.9%
    expect(notifications[0].body).toContain("損益±0に必要な的中率 35.9%");
  });

  it("検証を通っていないことを添える", () => {
    const { notifications } = diffSignals({}, [evaluation("USDJPY", "BUY")]);
    expect(notifications[0].body).toContain("ランダムエントリーと区別がつきません");
  });

  it("解除の通知にはエントリーの情報を載せない", () => {
    // 解除は「もう条件を満たしていない」だけなので、損切り幅も何も無い
    const state = { USDJPY: { signal: "BUY" as const, barTime: 900 } };
    const { notifications } = diffSignals(state, [evaluation("USDJPY", "WAIT")]);
    expect(notifications[0].kind).toBe("cleared");
    expect(notifications[0].body).not.toContain("損益±0に必要な的中率");
  });
});

describe("diffSignals", () => {
  it("初回にBUYが出れば通知する", () => {
    const { notifications } = diffSignals({}, [evaluation("USDJPY", "BUY")]);
    expect(notifications).toHaveLength(1);
    expect(notifications[0].kind).toBe("entry");
    expect(notifications[0].signal).toBe("BUY");
    expect(notifications[0].previousSignal).toBe("WAIT");
  });

  it("初回がWAITなら通知しない", () => {
    const { notifications } = diffSignals({}, [evaluation("USDJPY", "WAIT")]);
    expect(notifications).toHaveLength(0);
  });

  it("同じシグナルが続いている間は通知しない", () => {
    const state: SignalState = { USDJPY: { signal: "BUY", barTime: 900 } };
    const { notifications } = diffSignals(state, [evaluation("USDJPY", "BUY")]);
    expect(notifications).toHaveLength(0);
  });

  it("BUYからWAITに戻ったら解除を通知する", () => {
    const state: SignalState = { USDJPY: { signal: "BUY", barTime: 900 } };
    const { notifications } = diffSignals(state, [evaluation("USDJPY", "WAIT")]);
    expect(notifications).toHaveLength(1);
    expect(notifications[0].kind).toBe("cleared");
    expect(notifications[0].previousSignal).toBe("BUY");
  });

  it("BUYからSELLへの反転も通知する", () => {
    const state: SignalState = { USDJPY: { signal: "BUY", barTime: 900 } };
    const { notifications } = diffSignals(state, [evaluation("USDJPY", "SELL")]);
    expect(notifications).toHaveLength(1);
    expect(notifications[0].kind).toBe("entry");
    expect(notifications[0].signal).toBe("SELL");
    expect(notifications[0].previousSignal).toBe("BUY");
  });

  it("WAITが続いても通知しない", () => {
    const state: SignalState = { USDJPY: { signal: "WAIT", barTime: 900 } };
    const { notifications } = diffSignals(state, [evaluation("USDJPY", "WAIT")]);
    expect(notifications).toHaveLength(0);
  });

  it("銘柄ごとに独立して判定する", () => {
    const state: SignalState = { USDJPY: { signal: "BUY", barTime: 900 } };
    const { notifications } = diffSignals(state, [
      evaluation("USDJPY", "BUY"),
      evaluation("GBPJPY", "SELL"),
    ]);
    expect(notifications).toHaveLength(1);
    expect(notifications[0].symbolId).toBe("GBPJPY");
  });

  it("次に保存すべき状態を返し、渡された状態は変更しない", () => {
    const state: SignalState = { USDJPY: { signal: "WAIT", barTime: 900 } };
    const { nextState } = diffSignals(state, [evaluation("USDJPY", "BUY", 1200)]);

    expect(nextState.USDJPY).toEqual({ signal: "BUY", barTime: 1200 });
    expect(state.USDJPY).toEqual({ signal: "WAIT", barTime: 900 });
  });

  it("判定に含まれない銘柄の状態は残す", () => {
    const state: SignalState = { EURUSD: { signal: "SELL", barTime: 900 } };
    const { nextState } = diffSignals(state, [evaluation("USDJPY", "BUY")]);
    expect(nextState.EURUSD).toEqual({ signal: "SELL", barTime: 900 });
  });

  it("通知本文に価格・損切り・利確を含める", () => {
    const { notifications } = diffSignals({}, [evaluation("USDJPY", "BUY")]);
    expect(notifications[0].body).toContain("150.123");
    expect(notifications[0].body).toContain("損切り");
    expect(notifications[0].body).toContain("利確");
  });
});

describe("createWebhookNotifier", () => {
  it("DiscordとSlackの両方が読めるようにcontentとtextを送る", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);

    const notifier = createWebhookNotifier("https://example.test/webhook");
    const { notifications } = diffSignals({}, [evaluation("USDJPY", "BUY")]);
    await notifier.send(notifications[0]);

    expect(fetchMock).toHaveBeenCalledOnce();
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.content).toBe(body.text);
    expect(body.content).toContain("USDJPY BUY");

    vi.unstubAllGlobals();
  });

  it("Webhookがエラーを返したら例外にする", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false, status: 404, text: () => Promise.resolve("not found"),
    });
    vi.stubGlobal("fetch", fetchMock);

    const notifier = createWebhookNotifier("https://example.test/webhook");
    const { notifications } = diffSignals({}, [evaluation("USDJPY", "BUY")]);

    await expect(notifier.send(notifications[0])).rejects.toThrow(/HTTP 404/);

    vi.unstubAllGlobals();
  });
});

describe("describeFetchFailure", () => {
  /*
   * `--test-notification` は利用者が最初に打つ命令で、失敗したときに
   * 何を直すかを決める材料になる。Node の fetch は接続できないと
   * `fetch failed` としか言わず、本当の原因は `cause` に入っている。
   */
  function failure(code: string): Error {
    const error = new Error("fetch failed");
    error.cause = Object.assign(new Error("connect " + code), { code });
    return error;
  }

  it("接続拒否は、ホストとポートを確かめるよう言う", () => {
    expect(describeFetchFailure(failure("ECONNREFUSED"))).toContain("ポート");
  });

  it("名前解決の失敗は、綴りとDNSを確かめるよう言う", () => {
    const message = describeFetchFailure(failure("ENOTFOUND"));
    expect(message).toContain("ホスト名");
    expect(message).toContain("ENOTFOUND");
  });

  it("証明書の問題はそれと分かるようにする", () => {
    expect(describeFetchFailure(failure("CERT_HAS_EXPIRED"))).toContain("証明書");
  });

  it("タイムアウトは秒数まで言う", () => {
    const aborted = new Error("This operation was aborted");
    aborted.name = "AbortError";
    expect(describeFetchFailure(aborted)).toContain("15秒");
  });

  it("知らない原因でも、cause の中身を落とさない", () => {
    // 分類できないものを "fetch failed" だけにして捨てると、
    // 調べる手がかりが無くなる
    const error = new Error("fetch failed");
    error.cause = new Error("なにか別の理由");
    expect(describeFetchFailure(error)).toContain("なにか別の理由");
  });

  it("cause が無ければ元の文言をそのまま返す", () => {
    expect(describeFetchFailure(new Error("そのままの理由"))).toBe("そのままの理由");
  });
});
