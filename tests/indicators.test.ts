/**
 * 追加した指標の検証。
 *
 * 指標が間違っていると、その上に載るルールの結果はすべて意味を失う。
 * 「動いた」ではなく「値が正しい」ところまで固定する。手計算できる
 * 人工的な系列と、既知の性質（範囲・単調性・ウォームアップ）で見る。
 */
import { describe, expect, it } from "vitest";
import {
  bollingerSqueeze,
  calculateADX,
  calculateCCI,
  calculateKeltner,
  calculateParabolicSAR,
  calculatePivots,
  calculateROC,
  calculateSlope,
  calculateStochastic,
  calculateWilliamsR,
  distanceToRoundNumber,
  narrowestRange,
  retracementRatio,
} from "../lib/indicators";
import { calculateATR, calculateEMA, type OHLC } from "../lib/technicalAnalysis";

const HOUR = 3_600_000;

function bars(spec: [number, number, number, number][]): OHLC[] {
  return spec.map(([open, high, low, close], i) => ({
    timestamp: Date.UTC(2020, 0, 6, 8) + i * HOUR,
    open,
    high,
    low,
    close,
  }));
}

/** 一定の傾きで上昇する系列 */
function rising(count: number, slope = 1, start = 100): OHLC[] {
  return bars(
    Array.from({ length: count }, (_, i): [number, number, number, number] => {
      const base = start + i * slope;
      return [base, base + 0.4, base - 0.4, base + 0.2];
    }),
  );
}

describe("calculateStochastic", () => {
  it("レンジの上端なら100、下端なら0に近づく", () => {
    // 平滑を無効にして生の%Kを見る
    const up = rising(30);
    const { k } = calculateStochastic(up, 14, 1, 1);
    // 上昇し続けていれば終値は常にレンジ上端付近
    expect(k.at(-1)).toBeGreaterThan(80);

    const down = rising(30, -1);
    const stochDown = calculateStochastic(down, 14, 1, 1);
    expect(stochDown.k.at(-1)).toBeLessThan(20);
  });

  it("値幅が0の区間は中立の50にする（0にすると売られすぎに化ける）", () => {
    const flat = bars(Array.from({ length: 20 }, (): [number, number, number, number] => [100, 100, 100, 100]));
    const { k } = calculateStochastic(flat, 14, 1, 1);
    expect(k.at(-1)).toBe(50);
  });

  it("ウォームアップ区間は NaN", () => {
    const { k } = calculateStochastic(rising(30), 14, 1, 1);
    expect(Number.isNaN(k[12])).toBe(true);
    expect(Number.isFinite(k[13])).toBe(true);
  });

  it("%D は %K を平滑したもので、%K より遅れる", () => {
    const { k, d } = calculateStochastic(rising(40), 14, 3, 3);
    expect(Number.isFinite(d.at(-1))).toBe(true);
    // 上昇中は %K が先に上がるので %D 以上になる
    expect(k.at(-1)).toBeGreaterThanOrEqual(d.at(-1) ?? 0);
  });
});

describe("calculateCCI", () => {
  it("上昇が続けば正、下降が続けば負", () => {
    expect(calculateCCI(rising(40), 20).at(-1)).toBeGreaterThan(0);
    expect(calculateCCI(rising(40, -1), 20).at(-1)).toBeLessThan(0);
  });

  it("平均偏差が0なら0を返す（0除算にしない）", () => {
    const flat = bars(Array.from({ length: 30 }, (): [number, number, number, number] => [100, 100, 100, 100]));
    expect(calculateCCI(flat, 20).at(-1)).toBe(0);
  });
});

describe("calculateWilliamsR", () => {
  it("0〜-100 の範囲に収まる", () => {
    const values = calculateWilliamsR(rising(50), 14).filter(Number.isFinite);
    expect(values.length).toBeGreaterThan(0);
    for (const v of values) {
      expect(v).toBeLessThanOrEqual(0);
      expect(v).toBeGreaterThanOrEqual(-100);
    }
  });

  it("高値圏では0に近く、安値圏では-100に近い", () => {
    expect(calculateWilliamsR(rising(30), 14).at(-1)).toBeGreaterThan(-20);
    expect(calculateWilliamsR(rising(30, -1), 14).at(-1)).toBeLessThan(-80);
  });
});

describe("calculateROC", () => {
  it("10本前から10%上がっていれば10を返す", () => {
    const closes = [...Array<number>(10).fill(100), 110];
    expect(calculateROC(closes, 10).at(-1)).toBeCloseTo(10);
  });

  it("period 本ぶんは NaN", () => {
    const roc = calculateROC([100, 101, 102, 103], 2);
    expect(Number.isNaN(roc[1])).toBe(true);
    expect(Number.isFinite(roc[2])).toBe(true);
  });
});

describe("calculateADX", () => {
  it("一方向のトレンドで ADX が上がり、+DI が -DI を上回る", () => {
    const { adx, plusDI, minusDI } = calculateADX(rising(120), 14);
    expect(adx.at(-1)).toBeGreaterThan(25);
    expect(plusDI.at(-1)).toBeGreaterThan(minusDI.at(-1) ?? 0);
  });

  it("下降トレンドでは -DI が上回る", () => {
    const { plusDI, minusDI } = calculateADX(rising(120, -1), 14);
    expect(minusDI.at(-1)).toBeGreaterThan(plusDI.at(-1) ?? 0);
  });

  it("DI は 0〜100 に収まる", () => {
    const { plusDI, minusDI } = calculateADX(rising(120), 14);
    for (const series of [plusDI, minusDI]) {
      for (const v of series.filter(Number.isFinite)) {
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(100);
      }
    }
  });

  it("上下の動きは大きいほうだけを数える", () => {
    /*
     * +DM と -DM は「大きいほうだけ」を採るのが定義。両方を数えると
     * レンジ相場でも両方のDIが立ち上がり、トレンドの有無が読めなくなる。
     * 前の足を両側に包む足（外側の足）を作って確かめる。
     */
    const candles = bars([
      [100, 101, 99, 100],
      // 高値は+1、安値は-3。下の動きのほうが大きいので +DM は0でなければならない
      [100, 102, 96, 97],
      ...Array.from({ length: 40 }, (): [number, number, number, number] => [97, 97.5, 96.5, 97]),
    ]);
    const { plusDI, minusDI } = calculateADX(candles, 14);
    const i = candles.length - 1;
    // 下の動きだけを数えていれば -DI が支配的になる
    expect(minusDI[i]).toBeGreaterThan(plusDI[i] ?? 0);
    expect(plusDI[i]).toBeCloseTo(0, 6);
  });

  it("足が足りなければ全部 NaN で返す（落ちない）", () => {
    const { adx } = calculateADX(rising(10), 14);
    expect(adx.every((v) => Number.isNaN(v))).toBe(true);
  });
});

describe("calculateSlope", () => {
  it("1本あたり1.0で上がる系列の傾きは1.0", () => {
    // 終値は base + 0.2 なので、傾きは slope と同じ
    const closes = rising(40, 1).map((c) => c.close);
    expect(calculateSlope(closes, 20).at(-1)).toBeCloseTo(1.0, 6);
  });

  it("下降なら負、横ばいなら0", () => {
    expect(calculateSlope(rising(40, -2).map((c) => c.close), 20).at(-1)).toBeCloseTo(-2.0, 6);
    expect(calculateSlope(new Array<number>(40).fill(100), 20).at(-1)).toBeCloseTo(0, 9);
  });
});

describe("calculateKeltner", () => {
  it("中心はEMA、幅はATRの倍数", () => {
    const candles = rising(60);
    const ema = calculateEMA(candles.map((c) => c.close), 20);
    const atr = calculateATR(candles, 14);
    const { upper, middle, lower } = calculateKeltner(candles, ema, atr, 2);

    const i = candles.length - 1;
    expect(middle[i]).toBeCloseTo(ema[i]);
    expect(upper[i] - middle[i]).toBeCloseTo(atr[i] * 2);
    expect(middle[i] - lower[i]).toBeCloseTo(atr[i] * 2);
  });
});

describe("calculateParabolicSAR", () => {
  it("上昇中は価格の下、下降中は価格の上に来る", () => {
    const up = calculateParabolicSAR(rising(60));
    const i = 59;
    expect(up.rising[i]).toBe(true);
    expect(up.sar[i]).toBeLessThan(rising(60)[i].low);

    const downCandles = rising(60, -1);
    const down = calculateParabolicSAR(downCandles);
    expect(down.rising[59]).toBe(false);
    expect(down.sar[59]).toBeGreaterThan(downCandles[59].high);
  });

  it("直近2本のレンジに食い込ませない", () => {
    /*
     * SARは直近2本の高安の内側に入ってはいけない。ここを1本しか見ないと、
     * 前々足の安値を割った位置にSARが置かれ、本来より早く反転する。
     * 押しを作って、その安値より下にSARが留まることを見る。
     */
    const spec: [number, number, number, number][] = [];
    for (let i = 0; i < 20; i++) spec.push([100 + i, 100.5 + i, 99.5 + i, 100.4 + i]);
    // 深い押しを1本入れる（前々足の安値を大きく下回る）
    spec.push([119, 119.5, 112, 118]);
    spec.push([118, 119, 117.5, 118.8]);
    spec.push([118.8, 120, 118, 119.8]);
    const candles = bars(spec);
    const { sar, rising } = calculateParabolicSAR(candles);
    const i = candles.length - 1;
    if (rising[i]) {
      expect(sar[i]).toBeLessThanOrEqual(Math.min(candles[i - 1].low, candles[i - 2].low));
    }
  });

  it("トレンドが反転すれば rising も反転する", () => {
    // 30本上げてから30本下げる
    const candles = [...rising(30), ...rising(30, -1, 130)];
    const { rising: dir } = calculateParabolicSAR(candles);
    expect(dir[29]).toBe(true);
    expect(dir.at(-1)).toBe(false);
  });
});

describe("calculatePivots", () => {
  it("一つ前の足から出す（当日の足を使わない）", () => {
    const candles = bars([
      [100, 110, 90, 105],
      [105, 106, 104, 105],
    ]);
    // P = (110 + 90 + 105) / 3 = 101.666...
    expect(calculatePivots(candles).pivot[1]).toBeCloseTo(101.6667, 3);
    // 最初の足は前の足が無いので NaN
    expect(Number.isNaN(calculatePivots(candles).pivot[0])).toBe(true);
  });

  it("R1 > P > S1 になる", () => {
    const candles = bars([
      [100, 110, 90, 105],
      [105, 106, 104, 105],
    ]);
    const { pivot, r1, s1, r2, s2 } = calculatePivots(candles);
    expect(r1[1]).toBeGreaterThan(pivot[1]);
    expect(s1[1]).toBeLessThan(pivot[1]);
    expect(r2[1]).toBeGreaterThan(pivot[1]);
    expect(s2[1]).toBeLessThan(pivot[1]);
  });
});

describe("narrowestRange", () => {
  it("直近7本で最も狭ければ true", () => {
    const spec: [number, number, number, number][] = Array.from({ length: 7 }, () => [100, 102, 98, 100]);
    spec.push([100, 100.1, 99.9, 100]); // 最後だけ極端に狭い
    const flags = narrowestRange(bars(spec), 7);
    expect(flags.at(-1)).toBe(true);
  });

  it("同じ幅の足があれば true にしない（一意に最も狭いときだけ）", () => {
    const spec: [number, number, number, number][] = Array.from({ length: 8 }, () => [100, 101, 99, 100]);
    expect(narrowestRange(bars(spec), 7).at(-1)).toBe(false);
  });
});

describe("bollingerSqueeze", () => {
  it("バンド幅が直近で最も狭ければ true", () => {
    const n = 60;
    const middle = new Array<number>(n).fill(100);
    const upper = new Array<number>(n).fill(102);
    const lower = new Array<number>(n).fill(98);
    upper[n - 1] = 100.5;
    lower[n - 1] = 99.5;
    expect(bollingerSqueeze(upper, lower, middle, 50).at(-1)).toBe(true);
  });

  it("幅が変わらなければ false", () => {
    const n = 60;
    expect(
      bollingerSqueeze(
        new Array<number>(n).fill(102),
        new Array<number>(n).fill(98),
        new Array<number>(n).fill(100),
        50,
      ).at(-1),
    ).toBe(false);
  });
});

describe("distanceToRoundNumber", () => {
  it("きりのいい価格までの距離をpipsで返す", () => {
    // 154.80 から 155.00 まで 20 pips 上
    expect(distanceToRoundNumber(154.8, 1, 0.01)).toBeCloseTo(20);
    // 155.30 なら 155.00 が最寄りで 30 pips 下
    expect(distanceToRoundNumber(155.3, 1, 0.01)).toBeCloseTo(-30);
  });
});

describe("retracementRatio", () => {
  it("上昇のあとの押しを0〜1で返す", () => {
    // 100 → 110 と上げてから 105 まで押した
    const spec: [number, number, number, number][] = [];
    for (let i = 0; i < 10; i++) spec.push([100 + i, 100 + i, 100 + i, 100 + i]);
    spec.push([105, 105, 105, 105]);
    const result = retracementRatio(bars(spec), spec.length - 1, 10);

    expect(result).not.toBeNull();
    expect(result?.upswing).toBe(true);
    // 高値109、安値100、終値105 → (109-105)/9 = 0.444
    expect(result?.ratio).toBeCloseTo(0.444, 2);
  });

  it("下降のあとの戻りは upswing=false になる", () => {
    /*
     * 高値と安値のどちらが後に来たかで、いま上昇の途中か下降の途中かが
     * 決まる。ここを見ないと、下げ相場の戻りを「押し目買い」と読む。
     */
    const spec: [number, number, number, number][] = [];
    for (let i = 0; i < 10; i++) spec.push([110 - i, 110 - i, 110 - i, 110 - i]);
    spec.push([105, 105, 105, 105]); // 安値101から戻した
    const result = retracementRatio(bars(spec), spec.length - 1, 10);

    expect(result).not.toBeNull();
    expect(result?.upswing).toBe(false);
    // 安値101、高値110、終値105 → (105-101)/9 = 0.444
    expect(result?.ratio).toBeCloseTo(0.444, 2);
  });

  it("値幅が0なら null", () => {
    const spec: [number, number, number, number][] = Array.from({ length: 11 }, () => [100, 100, 100, 100]);
    expect(retracementRatio(bars(spec), 10, 10)).toBeNull();
  });

  it("さかのぼれる本数が足りなければ null", () => {
    expect(retracementRatio(rising(5), 2, 10)).toBeNull();
  });
});
