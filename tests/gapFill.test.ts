/**
 * 窓を開けて始まった足での約定。
 *
 * 週末や指標を挟むと窓が開く。損切りの水準が窓の内側にあるとき、実際に
 * 約定するのは始値であって、置いた値段ではない。ここを「指定値で約定した」
 * ことにすると、飛んだぶんの損失が丸ごと消える。
 *
 * 実データには4日超の飛びが銘柄あたり数百箇所あり、EURCHFには2081 pipsの
 * 飛びが1箇所ある（スイス中銀が下限を外した日）。そこを指定値で約定できた
 * ことにすると、破綻が無かったことになる。
 */
import { describe, expect, it } from "vitest";
import { simulateTrade, DEFAULT_BACKTEST_CONFIG } from "../lib/backtest";
import type { OHLC } from "../lib/technicalAnalysis";

const HOUR = 3_600_000;

function bar(i: number, open: number, high: number, low: number, close: number): OHLC {
  return { timestamp: Date.UTC(2020, 0, 6, 8) + i * HOUR, open, high, low, close };
}

/** 滑りを0にして、窓の効果だけを見る */
const cfg = {
  ...DEFAULT_BACKTEST_CONFIG,
  pipSize: 0.01,
  atrStopMultiplier: 1,
  riskRewardRatio: 2,
  spreadPips: 0,
  stopSlippagePips: 0,
  maxHoldingBars: 10,
};

describe("窓を開けた足での損切り約定", () => {
  it("窓が損切りを飛び越えたら、始値で約定する", () => {
    /*
     * ATR=1.00、損切り1ATR。100.00 で買い、損切りは 99.00。
     * 次の足が 97.00 で始まる（窓）。99.00 では約定できない。
     */
    const candles = [
      bar(0, 100, 100, 100, 100), // シグナル足
      bar(1, 100, 100.2, 99.9, 100), // エントリー足（始値100.00で買い）
      bar(2, 97, 97.5, 96.5, 97), // 窓を開けて下に飛ぶ
    ];
    const trade = simulateTrade(candles, 0, "BUY", 1.0, 50, cfg);

    expect(trade).not.toBeNull();
    expect(trade?.exitReason).toBe("stop_loss");
    // 100.00 → 97.00 で 300 pips の損。99.00 で約定していれば 100 pips
    expect(trade?.pips).toBeCloseTo(-300, 0);
  });

  it("SELLでも上に飛べば始値で約定する", () => {
    const candles = [
      bar(0, 100, 100, 100, 100),
      bar(1, 100, 100.1, 99.8, 100),
      bar(2, 103, 103.5, 102.5, 103), // 上に窓
    ];
    const trade = simulateTrade(candles, 0, "SELL", 1.0, 50, cfg);

    expect(trade?.exitReason).toBe("stop_loss");
    expect(trade?.pips).toBeCloseTo(-300, 0);
  });

  it("窓が無ければ従来どおり指定値で約定する", () => {
    // 足の中で損切りに触れるだけ。始値は損切りの手前にある
    const candles = [
      bar(0, 100, 100, 100, 100),
      bar(1, 100, 100.2, 99.9, 100),
      bar(2, 99.5, 99.6, 98.8, 99.2), // 始値99.50は損切り99.00の手前
    ];
    const trade = simulateTrade(candles, 0, "BUY", 1.0, 50, cfg);

    expect(trade?.exitReason).toBe("stop_loss");
    expect(trade?.pips).toBeCloseTo(-100, 0);
  });

  it("利確側は窓が有利に開いても指定値のまま（良く見えない側に倒す）", () => {
    // 利確は 102.00。足が 105.00 で始まっても 102.00 で数える
    const candles = [
      bar(0, 100, 100, 100, 100),
      bar(1, 100, 100.2, 99.9, 100),
      bar(2, 105, 105.5, 104.5, 105),
    ];
    const trade = simulateTrade(candles, 0, "BUY", 1.0, 50, cfg);

    expect(trade?.exitReason).toBe("take_profit");
    expect(trade?.pips).toBeCloseTo(200, 0);
  });

  it("窓が損切りと利確の両方を飛び越えたら損切り側を取る", () => {
    // 到達順は足からは分からない。楽観側を採らない
    const candles = [
      bar(0, 100, 100, 100, 100),
      bar(1, 100, 100.2, 99.9, 100),
      bar(2, 97, 103, 96, 97), // 始値は下に窓、足の中で利確にも触れている
    ];
    const trade = simulateTrade(candles, 0, "BUY", 1.0, 50, cfg);

    expect(trade?.exitReason).toBe("stop_loss");
    expect(trade?.pips).toBeCloseTo(-300, 0);
  });

  it("滑りは窓の始値から更に不利側へ乗る", () => {
    const candles = [
      bar(0, 100, 100, 100, 100),
      bar(1, 100, 100.2, 99.9, 100),
      bar(2, 97, 97.5, 96.5, 97),
    ];
    const trade = simulateTrade(candles, 0, "BUY", 1.0, 50, {
      ...cfg,
      stopSlippagePips: 2,
    });

    // 97.00 から更に2pips不利 = 302 pips の損
    expect(trade?.pips).toBeCloseTo(-302, 0);
  });
});
