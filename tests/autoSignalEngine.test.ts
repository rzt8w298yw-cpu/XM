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

/**
 * 「トレンドと逆行する材料を加点しない」という性質のテスト。
 *
 * ダイバージェンスとダウ理論構造の判定式は、条件を足すときに後段のOR節へ
 * 吸収されて前段の意図が消えやすい。個別のケースを固定するのではなく、
 * 多数の相場を回して「逆行しているのに成立している」ケースが1件も無いことを
 * 確かめる。逆行ケース自体が観測できていることも併せて確認し、
 * テストが空振りしていないことを担保する。
 */
describe("トレンドに逆行する材料の扱い", () => {
  function mulberry32(seed: number): () => number {
    let a = seed;
    return () => {
      a |= 0;
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /** ノイズと押し戻しを含むランダムウォーク。逆行する構造が自然に混ざる */
  function walk(
    count: number,
    start: number,
    drift: number,
    volatility: number,
    seed: number,
    stepMs: number,
  ): OHLC[] {
    const rand = mulberry32(seed);
    const candles: OHLC[] = [];
    let price = start;
    for (let i = 0; i < count; i++) {
      const open = price;
      const close = open + drift + (rand() - 0.5) * volatility * 2;
      const wick = Math.abs(close - open) * 0.5 + rand() * volatility * 0.5;
      candles.push({
        timestamp: LONDON_TS - (count - 1 - i) * stepMs,
        open,
        high: Math.max(open, close) + wick * rand(),
        low: Math.min(open, close) - wick * rand(),
        close,
      });
      price = close;
    }
    return candles;
  }

  function sample() {
    const results = [];
    for (let seed = 1; seed <= 150; seed++) {
      for (const direction of [1, -1] as const) {
        const candles1H = walk(
          600,
          direction === 1 ? 150 : 170,
          direction * 0.012,
          0.05,
          seed,
          HOUR,
        );
        const candlesDaily = walk(
          300,
          direction === 1 ? 140 : 200,
          direction * 0.1,
          0.4,
          seed + 9999,
          24 * HOUR,
        );
        results.push(
          generateSignal(
            candles1H,
            aggregate(candles1H, 4),
            candlesDaily,
            aggregate(candles1H, 8),
            { overrideTimestamp: LONDON_TS },
          ),
        );
      }
    }
    return results;
  }

  it("逆行するダイバージェンスは成立扱いにしない", () => {
    let opposingSeen = 0;

    for (const result of sample()) {
      const { trend1H, divergence } = result.analysis;
      const opposing =
        (trend1H === "UP" && divergence === "bearish") ||
        (trend1H === "DOWN" && divergence === "bullish");
      if (!opposing) continue;

      opposingSeen++;
      const condition = result.conditions.find((c) => c.id === "divergence");
      expect(condition?.met).toBe(false);
    }

    expect(opposingSeen).toBeGreaterThan(0);
  });

  it("逆行するダウ理論構造は成立扱いにしない", () => {
    let opposingSeen = 0;

    for (const result of sample()) {
      const { trend1H, marketStructure } = result.analysis;
      const opposing =
        (trend1H === "UP" && marketStructure === "DOWNTREND") ||
        (trend1H === "DOWN" && marketStructure === "UPTREND");
      if (!opposing) continue;

      opposingSeen++;
      const condition = result.conditions.find((c) => c.id === "market_structure");
      expect(condition?.met).toBe(false);
    }

    expect(opposingSeen).toBeGreaterThan(0);
  });

  it("レンジ構造も成立扱いにしない", () => {
    let rangeSeen = 0;

    for (const result of sample()) {
      if (result.analysis.marketStructure !== "RANGE") continue;
      rangeSeen++;
      const condition = result.conditions.find((c) => c.id === "market_structure");
      expect(condition?.met).toBe(false);
    }

    expect(rangeSeen).toBeGreaterThan(0);
  });
});
