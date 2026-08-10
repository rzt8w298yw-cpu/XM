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
  DAILY_RULES,
  donchian20,
  insideBarBreak,
  maCross,
  rsi2Pullback,
  timeSeriesMomentum,
  turnOfMonth,
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
const DAY = 24 * HOUR;

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

  it.each(ALL_RULES.map((r) => [r.id, r] as const))(
    "%s は後ろの足を書き換えても判断が変わらない",
    (_id, rule) => {
      const cut = 400;
      // 日足のルールは月やカレンダーを見るので、足の間隔もそれに合わせる
      const step = rule.timeframe === "daily" ? DAY : HOUR;
      const candles = closes.map((close, i) => ({
        timestamp: i * step,
        open: i === 0 ? close : closes[i - 1],
        high: Math.max(close, i === 0 ? close : closes[i - 1]) + 0.05,
        low: Math.min(close, i === 0 ? close : closes[i - 1]) - 0.05,
        close,
      }));

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

// ============================================================
// 日足のルール
// ============================================================
describe("日足のルール", () => {
  /** 日足間隔の足を作る */
  function daily(closes: number[], startTime = Date.UTC(2015, 0, 1)): OHLC[] {
    return closes.map((close, i) => ({
      timestamp: startTime + i * DAY,
      open: i === 0 ? close : closes[i - 1],
      high: Math.max(close, i === 0 ? close : closes[i - 1]) + 0.05,
      low: Math.min(close, i === 0 ? close : closes[i - 1]) - 0.05,
      close,
    }));
  }

  it("20日ブレイクアウトは20日の外に出た足だけで入る", () => {
    const closes = wiggle(120, 31);
    const candles = daily(closes);
    const i = 100;

    // 直前20本の最高値より高く終える足にする
    const priorHigh = Math.max(...candles.slice(i - 20, i).map((c) => c.high));
    const broken = candles.map((c, j) =>
      j === i ? { ...c, close: priorHigh + 1, high: priorHigh + 1.1 } : c,
    );
    expect(donchian20.decide({ ...buildContext(broken), i })).toBe("BUY");

    // レンジ内に収まる足では入らない
    const priorLow = Math.min(...candles.slice(i - 20, i).map((c) => c.low));
    const inside = candles.map((c, j) =>
      j === i ? { ...c, close: (priorHigh + priorLow) / 2 } : c,
    );
    expect(donchian20.decide({ ...buildContext(inside), i })).toBeNull();

    // ちょうど20本前だけが突出している形。19本しか見ないと
    // 「抜けた」と誤判定するので、期間の長さが効いていることが分かる
    const spikeAt20 = candles.map((c, j) =>
      j === i - 20
        ? { ...c, high: priorHigh + 10, close: priorHigh + 9 }
        : j === i
          ? { ...c, close: priorHigh + 5, high: priorHigh + 5.1 }
          : c,
    );
    expect(donchian20.decide({ ...buildContext(spikeAt20), i })).toBeNull();
  });

  it("50日/200日クロスは、水準ではなく交差した日だけで入る", () => {
    const ctx = buildContext(daily(wiggle(300, 37)));
    const i = 250;

    const crossUp = {
      ...ctx,
      ema50: setAt(setAt(ctx.ema50, i - 1, 99), i, 101),
      ema200: setAt(setAt(ctx.ema200, i - 1, 100), i, 100),
      i,
    };
    expect(maCross.decide(crossUp)).toBe("BUY");

    // 交差せず上にいるだけなら入らない
    const alreadyAbove = {
      ...ctx,
      ema50: setAt(setAt(ctx.ema50, i - 1, 101), i, 102),
      ema200: setAt(setAt(ctx.ema200, i - 1, 100), i, 100),
      i,
    };
    expect(maCross.decide(alreadyAbove)).toBeNull();
  });

  it("時系列モメンタムは符号が変わった日だけで入る", () => {
    // 63本前を跨いで符号が反転する形を作る
    const closes = Array.from({ length: 200 }, (_, i) => 100 + i * 0.01);
    const candles = daily(closes);
    const ctx = buildContext(candles);

    // 単調増加なので、どの日も「63日前より上」。符号は変わらないので入らない
    expect(timeSeriesMomentum.decide({ ...ctx, i: 150 })).toBeNull();

    // 前日だけ63日前を下回るようにすると、その翌日が反転の日になる
    const flipped = [...closes];
    flipped[149 - 63] = flipped[149] + 1;
    const ctx2 = buildContext(daily(flipped));
    expect(timeSeriesMomentum.decide({ ...ctx2, i: 150 })).toBe("BUY");
  });

  it("短期逆張りは長期の方向と逆側には入らない", () => {
    const ctx = buildContext(daily(wiggle(300, 41)));
    const i = 250;
    const price = ctx.candles[i].close;

    expect(
      rsi2Pullback.decide({
        ...ctx, ema200: setAt(ctx.ema200, i, price - 1), rsi2: setAt(ctx.rsi2, i, 5), i,
      }),
    ).toBe("BUY");
    // 200日線の上でRSIが下がりきっていなければ入らない
    expect(
      rsi2Pullback.decide({
        ...ctx, ema200: setAt(ctx.ema200, i, price - 1), rsi2: setAt(ctx.rsi2, i, 20), i,
      }),
    ).toBeNull();

    // RSIが下がりきっていても、200日線の下なら買わない（流れに逆らわない）
    expect(
      rsi2Pullback.decide({
        ...ctx, ema200: setAt(ctx.ema200, i, price + 1), rsi2: setAt(ctx.rsi2, i, 5), i,
      }),
    ).toBeNull();
  });

  it("インサイドバーは前日が前々日の値幅に収まっている場合だけ", () => {
    const closes = wiggle(120, 43);
    const base = daily(closes);
    const i = 100;

    const withInside = base.map((c, j) => {
      if (j === i - 2) return { ...c, high: 200, low: 100 };
      if (j === i - 1) return { ...c, high: 180, low: 120 };
      if (j === i) return { ...c, close: 185 }; // 前日の高値を超えて終える
      return c;
    });
    expect(insideBarBreak.decide({ ...buildContext(withInside), i })).toBe("BUY");

    // 前日が前々日からはみ出していればインサイドではない。
    // 前日の高値を超えて終えていても入らないことまで確かめる
    const notInside = withInside.map((c, j) =>
      j === i - 1 ? { ...c, high: 210 } : j === i ? { ...c, close: 215 } : c,
    );
    expect(insideBarBreak.decide({ ...buildContext(notInside), i })).toBeNull();
  });

  it("月初は月が変わった最初の足だけで入る", () => {
    // 2015-01-01 から日足。月が変わる位置を探す
    const candles = daily(wiggle(200, 47));
    const ctx = buildContext(candles);

    let firstOfMonth = -1;
    for (let i = 30; i < candles.length; i++) {
      const month = new Date(candles[i].timestamp).getUTCMonth();
      const prev = new Date(candles[i - 1].timestamp).getUTCMonth();
      if (month !== prev) {
        firstOfMonth = i;
        break;
      }
    }
    expect(firstOfMonth).toBeGreaterThan(0);

    expect(turnOfMonth.decide({ ...ctx, i: firstOfMonth })).not.toBeNull();
    // 同じ月の中の足では入らない
    expect(turnOfMonth.decide({ ...ctx, i: firstOfMonth + 1 })).toBeNull();
  });

  it("日足のルールはすべて timeframe が daily になっている", () => {
    for (const rule of DAILY_RULES) expect(rule.timeframe).toBe("daily");
  });
});
