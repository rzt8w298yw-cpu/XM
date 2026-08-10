/**
 * エントリー仮説の検証。
 *
 * ここで一番大事なのは「未来を見ていないこと」。ルールがうっかり後ろの足を
 * 参照すると、バックテストの成績だけが良くなって実運用では再現しない。
 * i より後ろを書き換えても判断が変わらないことを、全ルールについて確かめる。
 */
import { describe, expect, it } from "vitest";
import {
  ALL_RULES,
  bbReversion,
  buildContext,
  londonBreakout,
  plainMomentum,
  rsiReversion,
  scanRule,
  tokyoFixFade,
  trendPullback,
} from "../lib/hypotheses";
import { calculateBollingerBands, type OHLC } from "../lib/technicalAnalysis";

const HOUR = 3_600_000;

/** 与えた終値から、上下に少し幅を持たせた足を作る */
function fromCloses(closes: number[], startTime = 0): OHLC[] {
  return closes.map((close, i) => ({
    timestamp: startTime + i * HOUR,
    open: i === 0 ? close : closes[i - 1],
    high: Math.max(close, i === 0 ? close : closes[i - 1]) + 0.05,
    low: Math.min(close, i === 0 ? close : closes[i - 1]) - 0.05,
    close,
  }));
}

/** 疑似乱数で上下する終値。系列の性質に依存しない確認に使う */
function wiggle(length: number, seed = 7): number[] {
  let state = seed;
  const out: number[] = [];
  let price = 150;
  for (let i = 0; i < length; i++) {
    state = (state * 1103515245 + 12345) % 2147483648;
    price += ((state / 2147483648) - 0.5) * 0.4;
    out.push(Number(price.toFixed(3)));
  }
  return out;
}

describe("buildContext", () => {
  it("percentB が既存のボリンジャー実装と一致する", () => {
    const closes = wiggle(120);
    const candles = fromCloses(closes);
    const ctx = buildContext(candles);

    // 既存実装は最新値だけを返すので、末尾を切りながら突き合わせる
    for (const end of [30, 60, 90, 120]) {
      const expected = calculateBollingerBands(closes.slice(0, end), 20, 2);
      expect(expected).not.toBeNull();
      expect(ctx.percentB[end - 1]).toBeCloseTo(expected!.percentB, 10);
    }
  });

  it("ウォームアップ前は数値にならない", () => {
    const ctx = buildContext(fromCloses(wiggle(40)));
    expect(Number.isNaN(ctx.percentB[18])).toBe(true);
    expect(Number.isNaN(ctx.percentB[19])).toBe(false);
  });

  it("UTC時刻を足ごとに持つ", () => {
    // 1970-01-01 00:00 UTC から1時間ずつ
    const ctx = buildContext(fromCloses(wiggle(30)));
    expect(ctx.hourUtc[0]).toBe(0);
    expect(ctx.hourUtc[5]).toBe(5);
    expect(ctx.hourUtc[25]).toBe(1);
  });
});

describe("未来の足を見ていないこと", () => {
  const closes = wiggle(600);
  const candles = fromCloses(closes);

  it.each(ALL_RULES.map((r) => [r.id, r] as const))(
    "%s は後ろの足を書き換えても判断が変わらない",
    (_id, rule) => {
      const cut = 400;

      const full = buildContext(candles);
      const decisionsFull: (string | null)[] = [];
      for (let i = 250; i < cut; i++) decisionsFull.push(rule.decide({ ...full, i }));

      // cut 以降を大きく別物にする
      const tampered = candles.map((c, i) =>
        i < cut ? c : { ...c, open: c.open + 5, high: c.high + 5, low: c.low + 5, close: c.close + 5 },
      );
      const after = buildContext(tampered);
      const decisionsAfter: (string | null)[] = [];
      for (let i = 250; i < cut; i++) decisionsAfter.push(rule.decide({ ...after, i }));

      expect(decisionsAfter).toEqual(decisionsFull);
    },
  );
});

describe("各ルールの判断", () => {
  it("ボリンジャー逆張りは下バンド割れで買い、上バンド超えで売る", () => {
    const base = wiggle(100, 3);
    const candles = fromCloses(base);
    const ctx = buildContext(candles);

    const last = candles.length - 1;
    // percentB を直接置いて境界を確かめる
    expect(bbReversion.decide({ ...ctx, percentB: setAt(ctx.percentB, last, 0.01), i: last })).toBe("BUY");
    expect(bbReversion.decide({ ...ctx, percentB: setAt(ctx.percentB, last, 0.03), i: last })).toBeNull();
    expect(bbReversion.decide({ ...ctx, percentB: setAt(ctx.percentB, last, 0.99), i: last })).toBe("SELL");
    expect(bbReversion.decide({ ...ctx, percentB: setAt(ctx.percentB, last, 0.97), i: last })).toBeNull();
  });

  it("RSI反転は水準ではなく、またいだ足だけで入る", () => {
    const ctx = buildContext(fromCloses(wiggle(100, 5)));
    const i = 50;
    const cross = setAt(setAt(ctx.rsi, i - 1, 29), i, 31);
    const stayLow = setAt(setAt(ctx.rsi, i - 1, 25), i, 28);

    expect(rsiReversion.decide({ ...ctx, rsi: cross, i })).toBe("BUY");
    // ずっと30未満なら入らない（水準ではなく折り返しを見ている）
    expect(rsiReversion.decide({ ...ctx, rsi: stayLow, i })).toBeNull();
  });

  it("素の順張りは24本前との比較とEMA20の両方を見る", () => {
    const ctx = buildContext(fromCloses(wiggle(100, 9)));
    const i = 60;
    const price = ctx.candles[i].close;

    // 24本前より上・EMA20より上 → BUY
    expect(
      plainMomentum.decide({
        ...ctx,
        candles: setCandleClose(ctx.candles, i - 24, price - 1),
        ema20: setAt(ctx.ema20, i, price - 0.5),
        i,
      }),
    ).toBe("BUY");

    // 24本前より上でもEMA20の下なら入らない
    expect(
      plainMomentum.decide({
        ...ctx,
        candles: setCandleClose(ctx.candles, i - 24, price - 1),
        ema20: setAt(ctx.ema20, i, price + 0.5),
        i,
      }),
    ).toBeNull();
  });

  it("ロンドン開始のブレイクはUTC7時の足だけを見る", () => {
    const ctx = buildContext(fromCloses(wiggle(100, 11)));
    const i = 50;
    const atSeven = setAt(ctx.hourUtc, i, 7);
    const atEight = setAt(ctx.hourUtc, i, 8);

    // 直前7本より高く終えた足を作る
    const broken = ctx.candles.map((c, j) =>
      j === i ? { ...c, close: c.close + 5, high: c.high + 5 } : c,
    );

    expect(londonBreakout.decide({ ...ctx, candles: broken, hourUtc: atSeven, i })).toBe("BUY");
    expect(londonBreakout.decide({ ...ctx, candles: broken, hourUtc: atEight, i })).toBeNull();
  });

  it("東京仲値の戻りは、方向のはっきりした足の逆に入る", () => {
    const ctx = buildContext(fromCloses(wiggle(100, 13)));
    const i = 50;
    const hour = setAt(ctx.hourUtc, i, 1);

    // 直前の足を「実体の大きい陽線」にする → 売り
    const bullish = ctx.candles.map((c, j) =>
      j === i - 1 ? { ...c, open: 150, close: 150.5, high: 150.55, low: 149.95 } : c,
    );
    expect(tokyoFixFade.decide({ ...ctx, candles: bullish, hourUtc: hour, i })).toBe("SELL");

    // 同じ値幅でも実体が小さければ見送る
    const indecisive = ctx.candles.map((c, j) =>
      j === i - 1 ? { ...c, open: 150, close: 150.05, high: 150.5, low: 149.6 } : c,
    );
    expect(tokyoFixFade.decide({ ...ctx, candles: indecisive, hourUtc: hour, i })).toBeNull();
  });

  it("上位足に沿った押し目は、EMA200の側と反対の向きには入らない", () => {
    const ctx = buildContext(fromCloses(wiggle(300, 17)));
    const i = 250;
    const price = ctx.candles[i].close;

    // EMA200の上 + RSI低い → BUY
    expect(
      trendPullback.decide({
        ...ctx, ema200: setAt(ctx.ema200, i, price - 1), rsi: setAt(ctx.rsi, i, 35), i,
      }),
    ).toBe("BUY");
    // EMA200の上だがRSIが高い → 見送り（売りには回らない）
    expect(
      trendPullback.decide({
        ...ctx, ema200: setAt(ctx.ema200, i, price - 1), rsi: setAt(ctx.rsi, i, 65), i,
      }),
    ).toBeNull();
  });
});

describe("scanRule", () => {
  it("指定した範囲の外では判定しない", () => {
    const candles = fromCloses(wiggle(600, 23));
    const ctx = buildContext(candles);
    const scan = scanRule(plainMomentum, ctx, 300, 400);

    expect(scan.hits.length).toBeGreaterThan(0);
    for (const hit of scan.hits) {
      expect(hit.index).toBeGreaterThanOrEqual(300);
      expect(hit.index).toBeLessThan(400);
    }
  });

  it("ATRが立ち上がる前は判定しない", () => {
    const candles = fromCloses(wiggle(600, 29));
    const ctx = buildContext(candles);
    const scan = scanRule(plainMomentum, ctx, 0, 600);
    for (const hit of scan.hits) expect(hit.index).toBeGreaterThanOrEqual(250);
  });
});

function setAt(series: number[], index: number, value: number): number[] {
  const copy = [...series];
  copy[index] = value;
  return copy;
}

function setCandleClose(candles: OHLC[], index: number, close: number): OHLC[] {
  const copy = [...candles];
  copy[index] = { ...copy[index], close };
  return copy;
}
