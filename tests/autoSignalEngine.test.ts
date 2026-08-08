import { describe, expect, it } from "vitest";
import { generateSignal } from "../lib/autoSignalEngine";
import { aggregate } from "../lib/marketData";
import type { OHLC } from "../lib/technicalAnalysis";

const HOUR = 3_600_000;

/** 一定の傾きにノイズを乗せた足を作る（決定論的） */
function buildSeries(
  count: number,
  start: number,
  slopePerBar: number,
  stepMs: number,
  endTime: number,
): OHLC[] {
  const candles: OHLC[] = [];
  let price = start;
  for (let i = 0; i < count; i++) {
    const open = price;
    const noise = Math.sin(i / 7) * Math.abs(slopePerBar) * 0.6;
    const close = open + slopePerBar + noise;
    candles.push({
      timestamp: endTime - (count - 1 - i) * stepMs,
      open,
      high: Math.max(open, close) + Math.abs(slopePerBar) * 0.4,
      low: Math.min(open, close) - Math.abs(slopePerBar) * 0.4,
      close,
    });
    price = close;
  }
  return candles;
}

/** JST 18時（ロンドン時間）に固定したタイムスタンプ */
const LONDON_TS = Date.UTC(2026, 0, 5, 9, 0, 0);

describe("generateSignal", () => {
  it("上昇相場でも構造が壊れていなければ結果一式を返す", () => {
    const candles1H = buildSeries(600, 150, 0.02, HOUR, LONDON_TS);
    const candlesDaily = buildSeries(300, 140, 0.15, 24 * HOUR, LONDON_TS);

    const result = generateSignal(
      candles1H,
      aggregate(candles1H, 4),
      candlesDaily,
      aggregate(candles1H, 8),
      { overrideTimestamp: LONDON_TS },
    );

    expect(["BUY", "SELL", "WAIT"]).toContain(result.signal);
    expect(result.confidence).toBeGreaterThanOrEqual(0);
    expect(result.confidence).toBeLessThanOrEqual(100);
    expect(result.conditions).toHaveLength(15);
    expect(result.chartData).toHaveLength(30);
    expect(result.analysis.timeSession).toBe("LONDON");
  });

  it("上昇トレンドでは1H/日足ともUPと判定される", () => {
    const candles1H = buildSeries(600, 150, 0.02, HOUR, LONDON_TS);
    const candlesDaily = buildSeries(300, 140, 0.15, 24 * HOUR, LONDON_TS);

    const result = generateSignal(
      candles1H,
      aggregate(candles1H, 4),
      candlesDaily,
      aggregate(candles1H, 8),
      { overrideTimestamp: LONDON_TS },
    );

    expect(result.analysis.trend1H).toBe("UP");
    expect(result.analysis.trendDaily).toBe("UP");
    expect(result.signal).not.toBe("SELL");
  });

  it("下降トレンドではBUYを出さない", () => {
    const candles1H = buildSeries(600, 170, -0.02, HOUR, LONDON_TS);
    const candlesDaily = buildSeries(300, 190, -0.15, 24 * HOUR, LONDON_TS);

    const result = generateSignal(
      candles1H,
      aggregate(candles1H, 4),
      candlesDaily,
      aggregate(candles1H, 8),
      { overrideTimestamp: LONDON_TS },
    );

    expect(result.analysis.trend1H).toBe("DOWN");
    expect(result.signal).not.toBe("BUY");
  });

  it("東京時間はロンドン/NY以外なのでWAITに落とされる", () => {
    const tokyoTs = Date.UTC(2026, 0, 5, 1, 0, 0); // JST 10時
    const candles1H = buildSeries(600, 150, 0.02, HOUR, tokyoTs);
    const candlesDaily = buildSeries(300, 140, 0.15, 24 * HOUR, tokyoTs);

    const result = generateSignal(
      candles1H,
      aggregate(candles1H, 4),
      candlesDaily,
      aggregate(candles1H, 8),
      { overrideTimestamp: tokyoTs },
    );

    expect(result.analysis.timeSession).toBe("TOKYO");
    expect(result.signal).toBe("WAIT");
  });

  it("8H足を渡さなくても1H足から自動生成して動く", () => {
    const candles1H = buildSeries(600, 150, 0.02, HOUR, LONDON_TS);
    const candlesDaily = buildSeries(300, 140, 0.15, 24 * HOUR, LONDON_TS);

    const result = generateSignal(
      candles1H,
      aggregate(candles1H, 4),
      candlesDaily,
      undefined,
      { overrideTimestamp: LONDON_TS },
    );

    expect(result.analysis.mtfFilter.trend8H.price).toBeGreaterThan(0);
  });

  it("経済指標フィルターは overrideTimestamp を基準に判定する", () => {
    // JST 21:30 = UTC 12:30 は指標発表の危険時間帯
    const dangerTs = Date.UTC(2026, 0, 5, 12, 30, 0);
    const candles1H = buildSeries(600, 150, 0.02, HOUR, dangerTs);
    const candlesDaily = buildSeries(300, 140, 0.15, 24 * HOUR, dangerTs);

    const result = generateSignal(
      candles1H,
      aggregate(candles1H, 4),
      candlesDaily,
      aggregate(candles1H, 8),
      { overrideTimestamp: dangerTs },
    );

    const economic = result.conditions.find((c) => c.id === "economic_filter");
    expect(economic?.met).toBe(false);
    expect(result.signal).toBe("WAIT");
  });
});
