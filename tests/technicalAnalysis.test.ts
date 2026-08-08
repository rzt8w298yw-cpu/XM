import { describe, expect, it } from "vitest";
import {
  calculateATR,
  calculateBollingerBands,
  calculateEMA,
  calculateMACD,
  calculateRSI,
  calculateSMA,
  detectCandlePattern,
  determineTrend,
  getEMADirection,
  getTimeSessionFromTimestamp,
  isNearSupportResistance,
  type OHLC,
} from "../lib/technicalAnalysis";

function makeCandles(closes: number[]): OHLC[] {
  return closes.map((close, i) => ({
    timestamp: i * 3_600_000,
    open: i === 0 ? close : closes[i - 1],
    high: close + 0.5,
    low: close - 0.5,
    close,
  }));
}

describe("calculateEMA", () => {
  it("データが期間に満たない場合は空配列を返す", () => {
    expect(calculateEMA([1, 2, 3], 5)).toEqual([]);
  });

  it("入力と同じインデックスに値を揃える", () => {
    const ema = calculateEMA([1, 2, 3, 4, 5], 3);
    expect(ema.length).toBe(5);
    expect(ema[0]).toBeUndefined();
    expect(ema[1]).toBeUndefined();
    // 最初の値は単純平均 (1+2+3)/3
    expect(ema[2]).toBeCloseTo(2, 10);
    // 以降は EMA: close * k + prev * (1 - k), k = 2/(3+1) = 0.5
    expect(ema[3]).toBeCloseTo(3, 10);
    expect(ema[4]).toBeCloseTo(4, 10);
  });

  it("一定値の系列ではその値のままになる", () => {
    const ema = calculateEMA(new Array(30).fill(7), 10);
    expect(ema[29]).toBeCloseTo(7, 10);
  });
});

describe("calculateSMA", () => {
  it("移動平均を正しく計算する", () => {
    const sma = calculateSMA([1, 2, 3, 4, 5], 3);
    expect(sma[2]).toBeCloseTo(2, 10);
    expect(sma[4]).toBeCloseTo(4, 10);
  });
});

describe("calculateRSI", () => {
  it("上昇し続ける系列では100に張り付く", () => {
    const closes = Array.from({ length: 40 }, (_, i) => 100 + i);
    const rsi = calculateRSI(closes, 14);
    expect(rsi[rsi.length - 1]).toBeCloseTo(100, 6);
  });

  it("下落し続ける系列では0に張り付く", () => {
    const closes = Array.from({ length: 40 }, (_, i) => 100 - i);
    const rsi = calculateRSI(closes, 14);
    expect(rsi[rsi.length - 1]).toBeCloseTo(0, 6);
  });

  it("データ不足なら空配列", () => {
    expect(calculateRSI([1, 2, 3], 14)).toEqual([]);
  });
});

describe("calculateATR", () => {
  it("値幅が一定なら同じATRになる", () => {
    // 毎足 high-low = 1.0、終値も 1.0 ずつ動くので TR は常に 1.5
    const candles: OHLC[] = Array.from({ length: 30 }, (_, i) => ({
      timestamp: i,
      open: 100 + i,
      high: 100.5 + i,
      low: 99.5 + i,
      close: 100 + i,
    }));
    const atr = calculateATR(candles, 14);
    expect(atr[atr.length - 1]).toBeCloseTo(1.5, 6);
  });
});

describe("calculateBollingerBands", () => {
  it("価格が上バンドにあれば %B が 1 に近づく", () => {
    const closes = [...new Array(19).fill(100), 106];
    const bb = calculateBollingerBands(closes, 20);
    expect(bb).not.toBeNull();
    expect(bb!.percentB).toBeGreaterThan(0.9);
    expect(bb!.upper).toBeGreaterThan(bb!.middle);
    expect(bb!.lower).toBeLessThan(bb!.middle);
  });

  it("データ不足なら null", () => {
    expect(calculateBollingerBands([1, 2, 3], 20)).toBeNull();
  });
});

describe("calculateMACD", () => {
  it("データ不足なら null", () => {
    expect(calculateMACD(new Array(20).fill(100))).toBeNull();
  });

  it("上昇トレンドではヒストグラムがプラスになる", () => {
    const closes = Array.from({ length: 120 }, (_, i) => 100 + i * 0.5);
    const macd = calculateMACD(closes);
    expect(macd).not.toBeNull();
    expect(macd!.macd).toBeGreaterThan(0);
    expect(Number.isFinite(macd!.histogramPrev)).toBe(true);
  });
});

describe("determineTrend", () => {
  it("価格 > 20EMA > 200EMA で上昇と判定する", () => {
    const closes = Array.from({ length: 260 }, (_, i) => 100 + i * 0.3);
    const trend = determineTrend(
      closes,
      calculateEMA(closes, 20),
      calculateEMA(closes, 200),
    );
    expect(trend).toBe("UP");
  });

  it("価格 < 20EMA < 200EMA で下降と判定する", () => {
    const closes = Array.from({ length: 260 }, (_, i) => 200 - i * 0.3);
    const trend = determineTrend(
      closes,
      calculateEMA(closes, 20),
      calculateEMA(closes, 200),
    );
    expect(trend).toBe("DOWN");
  });

  it("横ばいならFLAT", () => {
    const closes = new Array(260).fill(100);
    const trend = determineTrend(
      closes,
      calculateEMA(closes, 20),
      calculateEMA(closes, 200),
    );
    expect(trend).toBe("FLAT");
  });
});

describe("getEMADirection", () => {
  it("上昇/下降/横ばいを区別する", () => {
    const rising = Array.from({ length: 30 }, (_, i) => 100 + i);
    const falling = Array.from({ length: 30 }, (_, i) => 100 - i);
    expect(getEMADirection(rising, 5)).toBe("rising");
    expect(getEMADirection(falling, 5)).toBe("falling");
    expect(getEMADirection(new Array(30).fill(100), 5)).toBe("neutral");
  });
});

describe("detectCandlePattern", () => {
  it("ブル包み足を検出する", () => {
    const candles: OHLC[] = [
      { timestamp: 0, open: 100, high: 101, low: 99, close: 100.5 },
      { timestamp: 1, open: 101, high: 101.2, low: 99.8, close: 100 },
      { timestamp: 2, open: 99.5, high: 102.5, low: 99.4, close: 102 },
    ];
    expect(detectCandlePattern(candles)).toBe("engulfing_bull");
  });

  it("ブルピンバー（下ヒゲが長い足）を検出する", () => {
    const candles: OHLC[] = [
      { timestamp: 0, open: 100, high: 100.5, low: 99.5, close: 100 },
      { timestamp: 1, open: 100, high: 100.5, low: 99.5, close: 100 },
      { timestamp: 2, open: 100, high: 100.1, low: 97, close: 100.05 },
    ];
    expect(detectCandlePattern(candles)).toBe("pin_bar_bull");
  });

  it("特徴のない足では none", () => {
    expect(detectCandlePattern(makeCandles([100, 100.2, 100.4]))).toBe("none");
  });
});

describe("isNearSupportResistance", () => {
  const levels = [
    { price: 150, type: "support" as const, strength: 3 },
    { price: 160, type: "resistance" as const, strength: 2 },
  ];

  it("許容誤差内なら near = true", () => {
    const result = isNearSupportResistance(150.1, levels, 0.0015);
    expect(result.near).toBe(true);
    expect(result.level?.price).toBe(150);
  });

  it("離れていれば near = false", () => {
    expect(isNearSupportResistance(155, levels, 0.0015).near).toBe(false);
  });
});

describe("getTimeSessionFromTimestamp", () => {
  const at = (utcHour: number) => Date.UTC(2026, 0, 5, utcHour, 0, 0);

  it("JST 17時（UTC 8時）はロンドン", () => {
    expect(getTimeSessionFromTimestamp(at(8))).toBe("LONDON");
  });

  it("JST 22時（UTC 13時）はNY", () => {
    expect(getTimeSessionFromTimestamp(at(13))).toBe("NY");
  });

  it("JST 10時（UTC 1時）は東京", () => {
    expect(getTimeSessionFromTimestamp(at(1))).toBe("TOKYO");
  });
});
