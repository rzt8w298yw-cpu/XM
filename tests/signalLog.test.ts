/**
 * シグナル記録と照合の検証。
 *
 * フォワードテストの数字がここで作られる。**この一式で唯一、新しい情報を
 * 生む経路**なので、バックテストと同じ約束事が守られていることを固定する:
 *
 * - 同一足で両側に触れたら損切り（悲観側）
 * - スプレッドを全トレードから引く
 * - 損切りは不利な方向に滑る
 * - 窓が損切りを飛び越えたら始値で約定する
 *
 * 後ろの3つは以前ここに無く、値幅をそのまま pips に直していた。実測で
 * バックテストより 1トレードあたり 1.21 pips 良く出ており、その差は
 * 測定できている期待値（0.69 pips）より大きかった。
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  appendSignalRecord,
  readSignalLog,
  reconcileSignal,
  summarizeForwardTest,
  type SignalRecord,
} from "../lib/signalLog";
import type { OHLC } from "../lib/technicalAnalysis";

const HOUR = 3_600_000;
const BASE = Date.UTC(2026, 0, 15, 9, 0, 0);

function record(overrides: Partial<SignalRecord> = {}): SignalRecord {
  return {
    barTime: BASE,
    recordedAt: BASE + 60_000,
    symbolId: "USDJPY",
    signal: "BUY",
    price: 150.0,
    stopLoss: 149.7,
    takeProfit: 150.6,
    confidence: 72,
    session: "LONDON",
    ...overrides,
  };
}

/** コストを0にして、値幅だけを見たいとき */
const NO_COST = { spreadPips: 0, stopSlippagePips: 0 };

function bar(offsetHours: number, high: number, low: number): OHLC {
  return {
    timestamp: BASE + offsetHours * HOUR,
    open: 150, high, low, close: 150,
  };
}

describe("記録の読み書き", () => {
  it("追記して読み戻せる", () => {
    const dir = mkdtempSync(join(tmpdir(), "signal-log-"));
    const path = join(dir, "log.jsonl");

    appendSignalRecord(path, record());
    appendSignalRecord(path, record({ symbolId: "GBPJPY", signal: "SELL" }));

    const { records, malformed } = readSignalLog(path);
    expect(records).toHaveLength(2);
    expect(records[1].symbolId).toBe("GBPJPY");
    expect(malformed).toBe(0);
  });

  it("ファイルが無いことと、空であることを区別する", () => {
    /*
     * どちらも0件になるが、意味は正反対。無いのは場所の指定違い、
     * 空なのはまだシグナルが出ていないだけ。照合はこれを見て
     * 案内を変える。
     */
    const dir = mkdtempSync(join(tmpdir(), "signal-log-"));
    const empty = join(dir, "empty.jsonl");
    writeFileSync(empty, "", "utf8");

    expect(readSignalLog(join(dir, "none.jsonl")).missing).toBe(true);
    expect(readSignalLog(empty).missing).toBe(false);
    expect(readSignalLog(empty).records).toHaveLength(0);
  });

  it("ファイルが無ければ空を返す", () => {
    const dir = mkdtempSync(join(tmpdir(), "signal-log-"));
    expect(readSignalLog(join(dir, "none.jsonl"))).toEqual({
      records: [],
      malformed: 0,
      missing: true,
    });
  });

  it("壊れた行は数えて飛ばし、残りは読む", () => {
    const dir = mkdtempSync(join(tmpdir(), "signal-log-"));
    const path = join(dir, "log.jsonl");
    writeFileSync(
      path,
      [
        JSON.stringify(record()),
        "{壊れたJSON",
        JSON.stringify({ symbolId: "USDJPY" }), // 必須項目が足りない
        JSON.stringify(record({ signal: "SELL" })),
        '{"barTime":1,"symbolId":"X","signal":"BUY","price":1,"stopLoss":1', // 途中で切れた行
      ].join("\n"),
    );

    const { records, malformed } = readSignalLog(path);
    expect(records).toHaveLength(2);
    expect(malformed).toBe(3);
  });
});

describe("reconcileSignal", () => {
  it("利確に到達したら take_profit と利益を返す", () => {
    const candles = [bar(1, 150.2, 149.9), bar(2, 150.7, 150.1)];
    const result = reconcileSignal(record(), candles, 0.01, 120, NO_COST);
    expect(result.outcome).toBe("take_profit");
    expect(result.pips).toBeCloseTo(60, 10); // 150.60 - 150.00 = 60pips
    expect(result.barsToResolve).toBe(2);
  });

  it("損切りに到達したら stop_loss と損失を返す", () => {
    const candles = [bar(1, 150.2, 149.9), bar(2, 150.1, 149.6)];
    const result = reconcileSignal(record(), candles, 0.01, 120, NO_COST);
    expect(result.outcome).toBe("stop_loss");
    expect(result.pips).toBeCloseTo(-30, 10);
  });

  it("同じ足で両方に触れたら損切りを採る", () => {
    const candles = [bar(1, 150.7, 149.6)];
    const result = reconcileSignal(record(), candles, 0.01);
    expect(result.outcome).toBe("stop_loss");
  });

  it("SELLは方向が反転する", () => {
    const sell = record({ signal: "SELL", stopLoss: 150.3, takeProfit: 149.4 });
    const candles = [bar(1, 150.1, 149.3)];
    const result = reconcileSignal(sell, candles, 0.01, 120, NO_COST);
    expect(result.outcome).toBe("take_profit");
    expect(result.pips).toBeCloseTo(60, 10); // 150.00 - 149.40 = 60pips
  });

  it("スプレッドを利確からも損切りからも引く", () => {
    // 引き忘れると、フォワードテストが実際より良く出る
    const win = reconcileSignal(record(), [bar(1, 150.7, 150.1)], 0.01, 120, {
      spreadPips: 2,
      stopSlippagePips: 0,
    });
    expect(win.pips).toBeCloseTo(58, 10); // 60 - 2

    const loss = reconcileSignal(record(), [bar(1, 150.1, 149.6)], 0.01, 120, {
      spreadPips: 2,
      stopSlippagePips: 0,
    });
    expect(loss.pips).toBeCloseTo(-32, 10); // -30 - 2
  });

  it("損切りは不利な方向に滑り、利確は滑らない", () => {
    // 損切りは成行で約定するので滑る。利確は指値なので滑らない
    const loss = reconcileSignal(record(), [bar(1, 150.1, 149.6)], 0.01, 120, {
      spreadPips: 0,
      stopSlippagePips: 1.5,
    });
    expect(loss.pips).toBeCloseTo(-31.5, 10);

    const win = reconcileSignal(record(), [bar(1, 150.7, 150.1)], 0.01, 120, {
      spreadPips: 0,
      stopSlippagePips: 1.5,
    });
    expect(win.pips).toBeCloseTo(60, 10);
  });

  it("SELLでも滑りは不利な方向（高く約定する）", () => {
    const sell = record({ signal: "SELL", stopLoss: 150.3, takeProfit: 149.4 });
    const result = reconcileSignal(sell, [bar(1, 150.4, 150.0)], 0.01, 120, {
      spreadPips: 0,
      stopSlippagePips: 1.5,
    });
    expect(result.outcome).toBe("stop_loss");
    // 150.30 で約定するはずが 150.315 になる → -31.5 pips
    expect(result.pips).toBeCloseTo(-31.5, 10);
  });

  it("窓が損切りを飛び越えたら始値で約定する", () => {
    /*
     * 週末を挟むと窓が開く。損切りが窓の内側にあるとき、置いた値段では
     * 約定しない。ここを指定値のままにすると、飛んだぶんの損失が消える。
     */
    const gapped: OHLC = {
      timestamp: BASE + HOUR,
      open: 149.0, // 損切り 149.70 を飛び越えて始まった
      high: 149.2,
      low: 148.8,
      close: 149.1,
    };
    const result = reconcileSignal(record(), [gapped], 0.01, 120, NO_COST);
    expect(result.outcome).toBe("stop_loss");
    // 149.70 なら -30 pips。実際は 149.00 で約定するので -100 pips
    expect(result.pips).toBeCloseTo(-100, 10);
  });

  it("窓が無ければ指定値で約定する", () => {
    const normal: OHLC = {
      timestamp: BASE + HOUR,
      open: 149.9, // 損切りの手前で始まっている
      high: 150.0,
      low: 149.6,
      close: 149.65,
    };
    const result = reconcileSignal(record(), [normal], 0.01, 120, NO_COST);
    expect(result.pips).toBeCloseTo(-30, 10);
  });

  it("どちらにも触れていなければ open", () => {
    const candles = [bar(1, 150.2, 149.9), bar(2, 150.1, 149.95)];
    expect(reconcileSignal(record(), candles, 0.01).outcome).toBe("open");
  });

  it("記録した足より後の足が無ければ no_data", () => {
    const candles = [{ timestamp: BASE - HOUR, open: 150, high: 151, low: 149, close: 150 }];
    expect(reconcileSignal(record(), candles, 0.01).outcome).toBe("no_data");
  });

  it("記録した足そのものは判定に使わない", () => {
    // 記録に使った足で利確に触れていても、それは判定済みの足なので数えない
    const candles = [{ timestamp: BASE, open: 150, high: 151, low: 149, close: 150 }];
    expect(reconcileSignal(record(), candles, 0.01).outcome).toBe("no_data");
  });

  it("保有上限を超えたら open のまま打ち切る", () => {
    const candles = Array.from({ length: 200 }, (_, i) => bar(i + 1, 150.1, 149.95));
    const result = reconcileSignal(record(), candles, 0.01, 10);
    expect(result.outcome).toBe("open");
  });
});

describe("summarizeForwardTest", () => {
  it("利確で終わってもコスト負けなら勝ちに数えない", () => {
    /*
     * 利確幅がスプレッドより狭いと、利確に届いても手取りはマイナスになる。
     * 決済理由で数えるとこれを勝ちに数えてしまい、バックテスト側
     * （`pips > 0` で数える）と勝率の定義が食い違う。両者は同じ
     * 損益分岐勝率と突き合わせる数字なので、ずれてはいけない。
     */
    const thin = record({ takeProfit: 150.01 }); // 1 pip しかない利確
    const result = reconcileSignal(thin, [bar(1, 150.05, 149.9)], 0.01, 120, {
      spreadPips: 2, // 利確幅より広いコスト
      stopSlippagePips: 0,
    });

    expect(result.outcome).toBe("take_profit");
    expect(result.pips).toBeCloseTo(-1, 10); // 1 - 2 = -1

    const summary = summarizeForwardTest([result]);
    expect(summary.resolved).toBe(1);
    expect(summary.wins).toBe(0);
    expect(summary.losses).toBe(1);
    expect(summary.winRate).toBe(0);
  });


  it("未決着は勝敗に数えない", () => {
    const candles = [bar(1, 150.7, 150.1)];
    const openCandles = [bar(1, 150.1, 149.95)];

    const summary = summarizeForwardTest([
      reconcileSignal(record(), candles, 0.01),
      reconcileSignal(record(), openCandles, 0.01),
      reconcileSignal(record(), [], 0.01),
    ]);

    expect(summary.total).toBe(3);
    expect(summary.resolved).toBe(1);
    expect(summary.open).toBe(1);
    expect(summary.noData).toBe(1);
    expect(summary.winRate).toBe(100);
  });

  it("決着が無ければ勝率0で割り算しない", () => {
    const summary = summarizeForwardTest([]);
    expect(summary.winRate).toBe(0);
    expect(summary.netPips).toBe(0);
  });
});
