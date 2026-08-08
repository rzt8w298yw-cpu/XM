/**
 * シグナル到達可能性テスト
 *
 * エンジンは多段フィルターでBUY/SELLを絞り込むため、条件を1つ締めるだけで
 * 「どんな相場でもWAITしか出ない」状態に陥りうる。ここでは実際にBUYとSELLが
 * 発火する相場をシードで固定し、フィルター変更で発火しなくなったら気づけるようにする。
 */
import { describe, expect, it } from "vitest";
import { generateSignal } from "../lib/autoSignalEngine";
import { aggregate } from "../lib/marketData";
import type { OHLC } from "../lib/technicalAnalysis";

const HOUR = 3_600_000;
/** JST 18時（ロンドン時間） */
const LONDON_TS = Date.UTC(2026, 0, 5, 9, 0, 0);

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

/** 決定論的なランダムウォーク */
function walk(
  count: number,
  start: number,
  drift: number,
  volatility: number,
  seed: number,
  stepMs: number,
  endTime: number,
): OHLC[] {
  const rand = mulberry32(seed);
  const candles: OHLC[] = [];
  let price = start;
  for (let i = 0; i < count; i++) {
    const open = price;
    const close = open + drift + (rand() - 0.5) * volatility * 2;
    const wick = Math.abs(close - open) * 0.5 + rand() * volatility * 0.5;
    candles.push({
      timestamp: endTime - (count - 1 - i) * stepMs,
      open,
      high: Math.max(open, close) + wick * rand(),
      low: Math.min(open, close) - wick * rand(),
      close,
    });
    price = close;
  }
  return candles;
}

function runScenario(seed: number, direction: 1 | -1) {
  const drift = direction * 0.012;
  const candles1H = walk(700, direction === 1 ? 150 : 170, drift, 0.05, seed, HOUR, LONDON_TS);
  const candlesDaily = walk(
    320,
    direction === 1 ? 130 : 190,
    direction * 0.1,
    0.4,
    seed + 9999,
    24 * HOUR,
    LONDON_TS,
  );
  return generateSignal(
    candles1H,
    aggregate(candles1H, 4),
    candlesDaily,
    aggregate(candles1H, 8),
    { overrideTimestamp: LONDON_TS },
  );
}

describe("シグナル到達可能性", () => {
  it("条件が揃った上昇相場ではBUYが発火する", () => {
    const result = runScenario(798, 1);
    expect(result.signal).toBe("BUY");
    expect(result.analysis.mtfFilter.buyPass).toBe(true);
    expect(result.analysis.currentRSI).toBeLessThan(70);
  });

  it("条件が揃った下降相場ではSELLが発火する", () => {
    const result = runScenario(2634, -1);
    expect(result.signal).toBe("SELL");
    expect(result.analysis.mtfFilter.sellPass).toBe(true);
    expect(result.analysis.currentRSI).toBeGreaterThan(30);
  });

  it("BUY発火時はATRベースの売買プランが組める", () => {
    const result = runScenario(798, 1);
    expect(result.analysis.currentATR).toBeGreaterThan(0);
  });
});
