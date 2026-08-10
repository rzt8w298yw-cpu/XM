/**
 * バックテスト基盤の検証。
 *
 * 損益の出し方と先読み防止が壊れていると、バックテストは「よく見える嘘」を返す。
 * ここでは結果が既知になる人工的な値動きを組んで、決済価格・pips換算・
 * スプレッド控除・同一足で両側に触れた場合の扱いを固定する。
 */
import { describe, expect, it } from "vitest";
import { runBacktest, simulateTrade, summarize, type Trade } from "../lib/backtest";
import type { OHLC } from "../lib/technicalAnalysis";

function trade(pips: number, direction: "BUY" | "SELL" = "BUY"): Trade {
  return {
    direction,
    entryTime: 0,
    entryPrice: 150,
    exitTime: 0,
    exitPrice: 150,
    stopLoss: 149,
    takeProfit: 152,
    pips,
    exitReason: pips > 0 ? "take_profit" : "stop_loss",
    holdingBars: 4,
    confidence: 70,
    session: "LONDON",
  };
}

describe("summarize", () => {
  it("勝率・PF・期待値を集計する", () => {
    const stats = summarize([trade(20), trade(-10), trade(20), trade(-10)]);
    expect(stats.trades).toBe(4);
    expect(stats.wins).toBe(2);
    expect(stats.winRate).toBe(50);
    expect(stats.netPips).toBe(20);
    expect(stats.profitFactor).toBe(2);
    expect(stats.expectancyPips).toBe(5);
  });

  it("最大ドローダウンは累積損益の山からの落ち込み幅", () => {
    // 累積: +30 → +10 → -5 → +15。山は30、谷は-5なので落ち込みは35
    const stats = summarize([trade(30), trade(-20), trade(-15), trade(20)]);
    expect(stats.maxDrawdownPips).toBe(35);
  });

  it("損失が無ければPFは無限大", () => {
    expect(summarize([trade(10), trade(5)]).profitFactor).toBe(Infinity);
  });

  it("トレードが無ければ全て0", () => {
    const stats = summarize([]);
    expect(stats.trades).toBe(0);
    expect(stats.winRate).toBe(0);
    expect(stats.profitFactor).toBe(0);
    expect(stats.maxDrawdownPips).toBe(0);
  });

  it("BUYとSELLを分けて集計する", () => {
    const stats = summarize([trade(20, "BUY"), trade(-10, "SELL"), trade(30, "SELL")]);
    expect(stats.byDirection.BUY.trades).toBe(1);
    expect(stats.byDirection.SELL.trades).toBe(2);
    expect(stats.byDirection.SELL.netPips).toBe(20);
  });
});

describe("simulateTrade", () => {
  const HOUR = 3_600_000;
  const cfg = {
    pipSize: 0.01,
    atrStopMultiplier: 1.5,
    riskRewardRatio: 2,
    spreadPips: 1,
    // 既存の期待値は滑り無しの前提。滑りの挙動は別のテストで確かめる
    stopSlippagePips: 0,
    windowSize: 1000,
    maxHoldingBars: 10,
  };
  // ATR 0.1 → 損切り幅 0.15 (15pips) / 利確幅 0.30 (30pips)
  const ATR = 0.1;

  function bar(i: number, open: number, high: number, low: number, close: number): OHLC {
    return { timestamp: i * HOUR, open, high, low, close };
  }

  it("シグナル足の終値ではなく次の足の始値で約定する", () => {
    const candles = [
      bar(0, 150.0, 150.1, 149.9, 150.0), // シグナル足
      bar(1, 150.5, 150.6, 150.4, 150.5), // 窓を開けて始まる
      ...Array.from({ length: 8 }, (_, i) => bar(i + 2, 150.5, 150.6, 150.4, 150.5)),
    ];
    const trade = simulateTrade(candles, 0, "BUY", ATR, 70, cfg)!;
    expect(trade.entryPrice).toBe(150.5);
    expect(trade.entryTime).toBe(1 * HOUR);
  });

  it("BUYが利確に到達すると RR分の利益からスプレッドを引いた値になる", () => {
    const candles = [
      bar(0, 150.0, 150.1, 149.9, 150.0),
      bar(1, 150.0, 150.1, 149.95, 150.0),
      bar(2, 150.0, 150.35, 149.95, 150.3), // 150.30 = 利確ライン
      ...Array.from({ length: 8 }, (_, i) => bar(i + 3, 150.3, 150.4, 150.2, 150.3)),
    ];
    const trade = simulateTrade(candles, 0, "BUY", ATR, 70, cfg)!;
    expect(trade.exitReason).toBe("take_profit");
    expect(trade.exitPrice).toBeCloseTo(150.3, 10);
    // 30pips - スプレッド1pip
    expect(trade.pips).toBeCloseTo(29, 10);
  });

  it("BUYが損切りに到達すると損失になる", () => {
    const candles = [
      bar(0, 150.0, 150.1, 149.9, 150.0),
      bar(1, 150.0, 150.1, 149.95, 150.0),
      bar(2, 150.0, 150.05, 149.8, 149.85), // 149.85 = 損切りライン
      ...Array.from({ length: 8 }, (_, i) => bar(i + 3, 149.85, 149.9, 149.8, 149.85)),
    ];
    const trade = simulateTrade(candles, 0, "BUY", ATR, 70, cfg)!;
    expect(trade.exitReason).toBe("stop_loss");
    // -15pips - スプレッド1pip
    expect(trade.pips).toBeCloseTo(-16, 10);
  });

  it("SELLは方向が反転し、下落が利益になる", () => {
    const candles = [
      bar(0, 150.0, 150.1, 149.9, 150.0),
      bar(1, 150.0, 150.05, 149.95, 150.0),
      bar(2, 150.0, 150.05, 149.65, 149.7), // 149.70 = SELLの利確ライン
      ...Array.from({ length: 8 }, (_, i) => bar(i + 3, 149.7, 149.8, 149.6, 149.7)),
    ];
    const trade = simulateTrade(candles, 0, "SELL", ATR, 70, cfg)!;
    expect(trade.exitReason).toBe("take_profit");
    expect(trade.pips).toBeCloseTo(29, 10);
  });

  it("同じ足で損切りと利確の両方に触れたら損切りを採用する", () => {
    const candles = [
      bar(0, 150.0, 150.1, 149.9, 150.0),
      // 始値150.0から上下どちらにも大きく振れた足
      bar(1, 150.0, 150.5, 149.5, 150.0),
      ...Array.from({ length: 8 }, (_, i) => bar(i + 2, 150.0, 150.1, 149.9, 150.0)),
    ];
    const trade = simulateTrade(candles, 0, "BUY", ATR, 70, cfg)!;
    expect(trade.exitReason).toBe("stop_loss");
    expect(trade.pips).toBeLessThan(0);
  });

  it("どちらにも触れなければ最大保有本数で時間切れ決済する", () => {
    const candles = [
      bar(0, 150.0, 150.1, 149.9, 150.0),
      ...Array.from({ length: 20 }, (_, i) => bar(i + 1, 150.0, 150.05, 149.95, 150.02)),
    ];
    const trade = simulateTrade(candles, 0, "BUY", ATR, 70, cfg)!;
    expect(trade.exitReason).toBe("timeout");
    expect(trade.holdingBars).toBe(cfg.maxHoldingBars);
  });

  it("損切りは不利な方向に滑る", () => {
    // 損切りに達するのは値動きが速い局面なので、指定レートより不利に約定する。
    // ここを見ないとバックテストが実際より良く出る
    const withSlip = { ...cfg, stopSlippagePips: 2 };
    const candles = [
      bar(0, 150.0, 150.1, 149.9, 150.0),
      bar(1, 150.0, 150.1, 149.95, 150.0),
      bar(2, 150.0, 150.05, 149.8, 149.85), // 149.85 = 損切りライン
      ...Array.from({ length: 8 }, (_, i) => bar(i + 3, 149.85, 149.9, 149.8, 149.85)),
    ];
    const trade = simulateTrade(candles, 0, "BUY", ATR, 70, withSlip)!;
    expect(trade.exitReason).toBe("stop_loss");
    // 損切り149.85から2pips不利にずれて149.83で約定
    expect(trade.exitPrice).toBeCloseTo(149.83, 10);
    // -17pips - スプレッド1pip
    expect(trade.pips).toBeCloseTo(-18, 10);
  });

  it("SELLの損切りは逆方向に滑る", () => {
    const withSlip = { ...cfg, stopSlippagePips: 2 };
    const candles = [
      bar(0, 150.0, 150.1, 149.9, 150.0),
      bar(1, 150.0, 150.05, 149.95, 150.0),
      bar(2, 150.0, 150.2, 149.95, 150.15), // 150.15 = SELLの損切りライン
      ...Array.from({ length: 8 }, (_, i) => bar(i + 3, 150.15, 150.2, 150.1, 150.15)),
    ];
    const trade = simulateTrade(candles, 0, "SELL", ATR, 70, withSlip)!;
    expect(trade.exitReason).toBe("stop_loss");
    // SELLは高く約定するのが不利
    expect(trade.exitPrice).toBeCloseTo(150.17, 10);
    expect(trade.pips).toBeCloseTo(-18, 10);
  });

  it("利確は指値なので滑らせない", () => {
    const withSlip = { ...cfg, stopSlippagePips: 2 };
    const candles = [
      bar(0, 150.0, 150.1, 149.9, 150.0),
      bar(1, 150.0, 150.1, 149.95, 150.0),
      bar(2, 150.0, 150.35, 149.95, 150.3),
      ...Array.from({ length: 8 }, (_, i) => bar(i + 3, 150.3, 150.4, 150.2, 150.3)),
    ];
    const trade = simulateTrade(candles, 0, "BUY", ATR, 70, withSlip)!;
    expect(trade.exitReason).toBe("take_profit");
    expect(trade.exitPrice).toBeCloseTo(150.3, 10);
    expect(trade.pips).toBeCloseTo(29, 10);
  });

  it("時間切れの決済も成行なので滑る", () => {
    const withSlip = { ...cfg, stopSlippagePips: 2 };
    const candles = [
      bar(0, 150.0, 150.1, 149.9, 150.0),
      ...Array.from({ length: 20 }, (_, i) => bar(i + 1, 150.0, 150.05, 149.95, 150.0)),
    ];
    const trade = simulateTrade(candles, 0, "BUY", ATR, 70, withSlip)!;
    expect(trade.exitReason).toBe("timeout");
    expect(trade.exitPrice).toBeCloseTo(149.98, 10);
  });

  it("次の足が無ければ約定しない", () => {
    const candles = [bar(0, 150.0, 150.1, 149.9, 150.0)];
    expect(simulateTrade(candles, 0, "BUY", ATR, 70, cfg)).toBeNull();
  });
});

describe("runBacktest", () => {
  const HOUR = 3_600_000;

  function flat(count: number, price: number, startTime: number, stepMs: number): OHLC[] {
    return Array.from({ length: count }, (_, i) => ({
      timestamp: startTime + i * stepMs,
      open: price,
      high: price,
      low: price,
      close: price,
    }));
  }

  it("値動きが無ければトレードは発生しない", () => {
    const start = Date.UTC(2024, 0, 1);
    const result = runBacktest(
      flat(1400, 150, start, HOUR),
      flat(400, 150, start - 400 * 24 * HOUR, 24 * HOUR),
      { windowSize: 300 },
    );
    expect(result.stats.trades).toBe(0);
    expect(result.barsEvaluated).toBeGreaterThan(0);
  });

  it("日足が足りなければ1本も判定しない", () => {
    const start = Date.UTC(2024, 0, 1);
    const result = runBacktest(
      flat(1400, 150, start, HOUR),
      flat(50, 150, start - 50 * 24 * HOUR, 24 * HOUR),
      { windowSize: 300 },
    );
    expect(result.barsEvaluated).toBe(0);
  });

  it("1H足がウォームアップ本数に満たなければ判定しない", () => {
    const start = Date.UTC(2024, 0, 1);
    const result = runBacktest(
      flat(100, 150, start, HOUR),
      flat(400, 150, start - 400 * 24 * HOUR, 24 * HOUR),
      { windowSize: 1000 },
    );
    expect(result.barsEvaluated).toBe(0);
    expect(result.stats.trades).toBe(0);
  });
});
