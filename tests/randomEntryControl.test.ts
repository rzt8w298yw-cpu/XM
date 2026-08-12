/**
 * 対照実験そのものの検証。
 *
 * 対照が壊れていても、出力は「戦略の圧勝」に見える。0件の対照は勝率0%を
 * 返し、どんな戦略もそれを上回るからだ。実際、日足の探索でこれが起きた——
 * 候補をロンドン・NY時間に絞る条件が日足（22:00 UTC固定）に一件も当たらず、
 * 42件が「ランダムを上回った」と報告された。絞り込みを直すと22件に減り、
 * その大半も他の検定で落ちた。
 *
 * **比較が行われていないことは、圧勝と区別がつかない。**
 */
import { describe, expect, it } from "vitest";
import { runRandomEntryControl } from "../lib/backtest";
import { calculateATR, type OHLC } from "../lib/technicalAnalysis";

/** 指定した時刻から一定間隔で並ぶ、緩やかに上下する足 */
function candles(count: number, startUtcHour: number, stepMs: number): OHLC[] {
  const start = Date.UTC(2020, 0, 6, startUtcHour, 0, 0);
  const out: OHLC[] = [];
  for (let i = 0; i < count; i++) {
    const base = 100 + Math.sin(i / 7) * 2;
    out.push({
      timestamp: start + i * stepMs,
      open: base,
      high: base + 0.5,
      low: base - 0.5,
      close: base + Math.cos(i / 5) * 0.2,
    });
  }
  return out;
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const cfg = { pipSize: 0.01, windowSize: 250, maxHoldingBars: 20 };

describe("runRandomEntryControl", () => {
  it("1時間足では既定のまま（セッション絞り込みあり）で成立する", () => {
    // 08:00 UTC 始まりの1時間足。ロンドン・NY時間に十分かかる
    const bars = candles(1200, 8, HOUR);
    const result = runRandomEntryControl(bars, calculateATR(bars, 14), 30, 1, cfg);
    expect(result.trades.length).toBeGreaterThan(0);
  });

  it("日足にセッション絞り込みを掛けると、黙って0件を返さず例外にする", () => {
    /*
     * ここが本題。日足の時刻は 22:00 UTC で固定されていて、ロンドンにも
     * NYにも当たらない。以前は候補0件のまま空の結果を返しており、その
     * 勝率0%が戦略の勝率と比較されて「above」になっていた。
     */
    const bars = candles(1200, 22, DAY);
    expect(() => runRandomEntryControl(bars, calculateATR(bars, 14), 30, 1, cfg)).toThrow(
      /候補が1本もありません/,
    );
  });

  it("日足でも restrictToSessions: false なら成立する", () => {
    const bars = candles(1200, 22, DAY);
    const result = runRandomEntryControl(bars, calculateATR(bars, 14), 30, 1, {
      ...cfg,
      restrictToSessions: false,
    });
    expect(result.trades.length).toBeGreaterThan(0);
  });

  it("同じ種なら同じ結果になる", () => {
    // 乱数の引きで結論が変わってはいけない
    const bars = candles(1200, 8, HOUR);
    const atr = calculateATR(bars, 14);
    const a = runRandomEntryControl(bars, atr, 30, 42, cfg);
    const b = runRandomEntryControl(bars, atr, 30, 42, cfg);
    expect(a.trades.map((t) => t.entryTime)).toEqual(b.trades.map((t) => t.entryTime));
  });

  it("種が違えば違う場所に入る", () => {
    const bars = candles(1200, 8, HOUR);
    const atr = calculateATR(bars, 14);
    const a = runRandomEntryControl(bars, atr, 30, 1, cfg);
    const b = runRandomEntryControl(bars, atr, 30, 2, cfg);
    expect(a.trades.map((t) => t.entryTime)).not.toEqual(b.trades.map((t) => t.entryTime));
  });
});
