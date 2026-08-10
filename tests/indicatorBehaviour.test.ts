/**
 * 指標の判定内容の検証。
 *
 * `npm run mutate` を指標まで広げたところ、14件中11件が生き残った。
 * 値が計算できることは確かめていたが、**何を判定しているか**は
 * 確かめていなかった。ここはその11件をそれぞれ落とすために書いてある。
 *
 * 「境界のすぐ内側と外側」を対にして確かめる形にしてあるので、
 * 閾値を緩めたり条件を落としたりすると落ちる。
 */
import { describe, expect, it } from "vitest";
import {
  analyzeMarketStructure,
  detectDivergence,
  detectCandlePattern,
  detectSupportResistance,
  determineTrend,
  getATRStatus,
  getEMADirection,
  isPullback,
  type OHLC,
} from "../lib/technicalAnalysis";

const HOUR = 3_600_000;

/**
 * 平坦な足並びの指定位置だけに極値を置く。
 *
 * スイング判定は前後3本より高い（低い）ことを条件にするので、
 * 平坦部分は同値にして候補から外し、置いた極値だけが拾われるようにする。
 */
function withPivots(
  length: number,
  pivots: Record<number, { high?: number; low?: number }>,
): OHLC[] {
  return Array.from({ length }, (_, i) => {
    const pivot = pivots[i];
    const high = pivot?.high ?? 105;
    const low = pivot?.low ?? 100;
    const mid = (high + low) / 2;
    return { timestamp: i * HOUR, open: mid, high, low, close: mid };
  });
}

// ============================================================
// ダウ理論の構造
// ============================================================
describe("ダウ理論の高値安値構造", () => {
  it("高値も安値も切り上げていれば上昇と判定する", () => {
    // 安値95→98（切り上げ）、高値110→115（切り上げ）
    const candles = withPivots(21, {
      4: { low: 95 }, 8: { high: 110 }, 12: { low: 98 }, 16: { high: 115 },
    });
    expect(analyzeMarketStructure(candles)).toBe("UPTREND");
  });

  it("高値も安値も切り下げていれば下降と判定する", () => {
    // 高値115→110（切り下げ）、安値98→95（切り下げ）
    const candles = withPivots(21, {
      4: { high: 115 }, 8: { low: 98 }, 12: { high: 110 }, 16: { low: 95 },
    });
    expect(analyzeMarketStructure(candles)).toBe("DOWNTREND");
  });

  it("高値が切り下がり安値が切り上がればレンジ", () => {
    const candles = withPivots(21, {
      4: { high: 115 }, 8: { low: 95 }, 12: { high: 110 }, 16: { low: 98 },
    });
    expect(analyzeMarketStructure(candles)).toBe("RANGE");
  });

  it("スイングが2つに満たなければレンジ", () => {
    expect(analyzeMarketStructure(withPivots(21, { 8: { high: 110 } }))).toBe("RANGE");
  });
});

// ============================================================
// サポート / レジスタンス
// ============================================================
describe("サポレジの検出", () => {
  // 110付近に2回、95付近に2回反応する。両者は約15%離れており、
  // 既定の許容幅0.15%では別のクラスタになる。最後は105で終える
  const candles = (() => {
    const base = withPivots(25, {
      4: { high: 110 }, 8: { low: 95 }, 12: { high: 110.1 }, 16: { low: 95.1 },
    });
    // 現在値を2つのクラスタの間に置く
    base[base.length - 1] = {
      timestamp: 24 * HOUR, open: 105, high: 105, low: 105, close: 105,
    };
    return base;
  })();

  it("離れた価格帯は別のクラスタとして扱う", () => {
    const levels = detectSupportResistance(candles);
    const prices = levels.map((l) => l.price);
    expect(prices.some((p) => Math.abs(p - 110) < 1)).toBe(true);
    expect(prices.some((p) => Math.abs(p - 95) < 1)).toBe(true);
  });

  it("現在値より下はサポート、上はレジスタンスになる", () => {
    const levels = detectSupportResistance(candles);
    const price = candles[candles.length - 1].close;

    for (const level of levels) {
      if (level.price < price) expect(level.type).toBe("support");
      else expect(level.type).toBe("resistance");
    }
    // 両方の型が観測できていること（空振り防止）
    expect(levels.some((l) => l.type === "support")).toBe(true);
    expect(levels.some((l) => l.type === "resistance")).toBe(true);
  });

  it("反応回数の多い順に並ぶ", () => {
    const levels = detectSupportResistance(candles);
    for (let i = 1; i < levels.length; i++) {
      expect(levels[i - 1].strength).toBeGreaterThanOrEqual(levels[i].strength);
    }
  });
});

// ============================================================
// ダイバージェンス
// ============================================================
describe("ダイバージェンスの向き", () => {
  /** 20本ぶんの終値とRSIを組む。指定した位置だけ値を差し替える */
  function series(
    priceOverrides: Record<number, number>,
    rsiOverrides: Record<number, number>,
  ) {
    const closes = Array.from({ length: 20 }, (_, i) => priceOverrides[i] ?? 100);
    const rsi = Array.from({ length: 20 }, (_, i) => rsiOverrides[i] ?? 50);
    return { closes, rsi };
  }

  it("価格が安値を切り下げRSIが切り上げればブリッシュ", () => {
    // 前半の安値は98(RSI 30)、後半の安値は97(RSI 40)
    const { closes, rsi } = series({ 2: 98, 12: 97 }, { 2: 30, 12: 40 });
    expect(detectDivergence(closes, rsi, 20)).toBe("bullish");
  });

  it("価格が高値を切り上げRSIが切り下げればベアリッシュ", () => {
    const { closes, rsi } = series({ 2: 102, 12: 103 }, { 2: 70, 12: 60 });
    expect(detectDivergence(closes, rsi, 20)).toBe("bearish");
  });

  it("価格もRSIも同じ向きなら乖離ではない", () => {
    // 安値を切り下げ、RSIも切り下げ（順行なのでダイバージェンスではない）
    const { closes, rsi } = series({ 2: 98, 12: 97 }, { 2: 40, 12: 30 });
    expect(detectDivergence(closes, rsi, 20)).toBe("none");
  });

  it("本数が足りなければ判定しない", () => {
    expect(detectDivergence([100, 101], [50, 50], 20)).toBe("none");
  });
});

// ============================================================
// ローソク足パターン
// ============================================================
describe("ローソク足パターンの判定", () => {
  it("実体が直前より大きくなければ包み足にしない", () => {
    // 値幅は包んでいるが実体は同じ大きさ
    const candles: OHLC[] = [
      { timestamp: 0, open: 100, high: 101, low: 99, close: 100.5 },
      { timestamp: 1, open: 101, high: 101.2, low: 99.8, close: 100 }, // 陰線・実体1
      { timestamp: 2, open: 100, high: 101, low: 100, close: 101 },    // 陽線・実体1
    ];
    expect(detectCandlePattern(candles)).not.toBe("engulfing_bull");
  });

  it("実体が直前より大きければ包み足と判定する", () => {
    const candles: OHLC[] = [
      { timestamp: 0, open: 100, high: 101, low: 99, close: 100.5 },
      { timestamp: 1, open: 101, high: 101.2, low: 99.8, close: 100 }, // 実体1
      { timestamp: 2, open: 99.9, high: 101.5, low: 99.8, close: 101.4 }, // 実体1.5
    ];
    expect(detectCandlePattern(candles)).toBe("engulfing_bull");
  });

  it("ヒゲが値幅の3分の2に届かなければピンバーにしない", () => {
    // 値幅3、下ヒゲ1.5（50%）。3分の2（2.0）に届かない
    const candles: OHLC[] = [
      { timestamp: 0, open: 100, high: 100.5, low: 99.5, close: 100 },
      { timestamp: 1, open: 100, high: 100.6, low: 99.9, close: 100.5 }, // 陽線
      { timestamp: 2, open: 101.5, high: 103, low: 100, close: 101.8 },
    ];
    expect(detectCandlePattern(candles)).toBe("none");
  });

  it("ヒゲが値幅の3分の2以上ならピンバーと判定する", () => {
    // 値幅3、下ヒゲ2.2
    const candles: OHLC[] = [
      { timestamp: 0, open: 100, high: 100.5, low: 99.5, close: 100 },
      { timestamp: 1, open: 100, high: 100.6, low: 99.9, close: 100.5 },
      { timestamp: 2, open: 102.2, high: 103, low: 100, close: 102.5 },
    ];
    expect(detectCandlePattern(candles)).toBe("pin_bar_bull");
  });
});

// ============================================================
// 押し目 / 戻り目
// ============================================================
describe("押し目の判定", () => {
  it("EMAからATR1本分以内なら押し目とみなす", () => {
    // 価格100.5、EMA20が100、ATR1 → 距離0.5
    expect(isPullback(100.5, 100, 90, "UP", 1)).toBe(true);
  });

  it("EMAからATR1本分を超えていれば押し目にしない", () => {
    // 距離1.5はATR1本分を超える
    expect(isPullback(101.5, 100, 90, "UP", 1)).toBe(false);
  });

  it("上昇トレンドでも200EMAを下回っていれば押し目にしない", () => {
    // EMAには近い（距離0.5）が、200EMA(110)を下回っている
    expect(isPullback(100.5, 100, 110, "UP", 1)).toBe(false);
  });

  it("下降トレンドでは200EMAを上回っていれば戻り目にしない", () => {
    expect(isPullback(100.5, 100, 90, "DOWN", 1)).toBe(false);
    expect(isPullback(99.5, 100, 110, "DOWN", 1)).toBe(true);
  });

  it("レンジやATR0では判定しない", () => {
    expect(isPullback(100.5, 100, 90, "FLAT", 1)).toBe(false);
    expect(isPullback(100.5, 100, 90, "UP", 0)).toBe(false);
  });
});

// ============================================================
// ATRの状態
// ============================================================
describe("ボラティリティの状態", () => {
  const flat = new Array(50).fill(1.0);

  it("平均を大きく下回れば低ボラ", () => {
    expect(getATRStatus(flat, 0.5)).toBe("low");
  });

  it("平均並みなら適正", () => {
    expect(getATRStatus(flat, 1.0)).toBe("normal");
  });

  it("平均を大きく上回れば高ボラ", () => {
    expect(getATRStatus(flat, 2.0)).toBe("high");
  });

  it("低ボラの境界のすぐ内外で切り替わる", () => {
    expect(getATRStatus(flat, 0.69)).toBe("low");
    expect(getATRStatus(flat, 0.71)).toBe("normal");
  });

  it("本数が足りなければ適正として扱う", () => {
    expect(getATRStatus([1, 1], 0.1)).toBe("normal");
  });
});

// ============================================================
// トレンド判定
// ============================================================
describe("トレンド判定", () => {
  const rising = [99, 99.2, 99.4, 99.6, 99.8, 100];
  const falling = [101, 100.8, 100.6, 100.4, 100.2, 100];

  it("価格 > 20EMA > 200EMA なら上昇", () => {
    expect(determineTrend([105], rising, new Array(6).fill(90))).toBe("UP");
  });

  it("20EMAが200EMAを下回っていれば上昇にしない", () => {
    // 価格は20EMAの上だが、20EMAが200EMAの下にある
    expect(determineTrend([105], rising, new Array(6).fill(110))).toBe("FLAT");
  });

  it("価格 < 20EMA < 200EMA なら下降", () => {
    expect(determineTrend([95], falling, new Array(6).fill(110))).toBe("DOWN");
  });

  it("20EMAが200EMAを上回っていれば下降にしない", () => {
    expect(determineTrend([95], falling, new Array(6).fill(90))).toBe("FLAT");
  });
});

// ============================================================
// EMAの傾き
// ============================================================
describe("EMAの傾き", () => {
  it("わずかな傾きは横ばいとして扱う", () => {
    // 0.01%の上昇は閾値0.02%に届かない
    expect(getEMADirection([100, 100, 100, 100, 100, 100.01], 5)).toBe("neutral");
  });

  it("閾値を超える傾きは方向ありとする", () => {
    // 0.05%の上昇
    expect(getEMADirection([100, 100, 100, 100, 100, 100.05], 5)).toBe("rising");
    expect(getEMADirection([100, 100, 100, 100, 100, 99.95], 5)).toBe("falling");
  });

  it("完全に横ばいなら中立", () => {
    expect(getEMADirection(new Array(6).fill(100), 5)).toBe("neutral");
  });

  it("比較対象が足りなければ中立", () => {
    expect(getEMADirection([100, 101], 5)).toBe("neutral");
    expect(getEMADirection([], 5)).toBe("neutral");
  });
});
