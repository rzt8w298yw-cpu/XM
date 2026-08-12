/**
 * シグナル記録と照合の検証。
 *
 * フォワードテストの数字がここで作られるので、バックテストと同じ
 * 悲観側の約束事（同一足で両側に触れたら損切り）が守られていることと、
 * 壊れた行があっても全体が読めなくならないことを固定する。
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
    const result = reconcileSignal(record(), candles, 0.01);
    expect(result.outcome).toBe("take_profit");
    expect(result.pips).toBeCloseTo(60, 10); // 150.60 - 150.00 = 60pips
    expect(result.barsToResolve).toBe(2);
  });

  it("損切りに到達したら stop_loss と損失を返す", () => {
    const candles = [bar(1, 150.2, 149.9), bar(2, 150.1, 149.6)];
    const result = reconcileSignal(record(), candles, 0.01);
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
    const result = reconcileSignal(sell, candles, 0.01);
    expect(result.outcome).toBe("take_profit");
    expect(result.pips).toBeCloseTo(60, 10); // 150.00 - 149.40 = 60pips
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
