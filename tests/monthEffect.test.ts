/**
 * 月初の効果の計測。
 *
 * ここは事後に見つけたものを標本の外で確かめるための道具なので、
 * 道具のほうが間違っていると結論ごと壊れる。特に:
 *   - 月初の判定に翌営業日を使っていないこと（先読み）
 *   - 前月の方向と「逆」に向きが付いていること
 *   - 並べ替え検定が、効果の無い入力で有意にならないこと
 */
import { describe, expect, it } from "vitest";
import {
  collectMonthEffect,
  isFirstTradingDayOfMonth,
  makeRandom,
  mean,
  permutationTest,
  trailingVolatility,
} from "../lib/monthEffect";

/** 営業日（土日を飛ばす）の日付列を作る */
function businessDays(count: number, startIso = "2000-01-03"): string[] {
  const out: string[] = [];
  const cursor = new Date(`${startIso}T00:00:00Z`);
  while (out.length < count) {
    const day = cursor.getUTCDay();
    if (day !== 0 && day !== 6) out.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return out;
}

/** 決まった種で上下する価格列 */
function wander(count: number, seed = 5, start = 100): number[] {
  const rand = makeRandom(seed);
  const out: number[] = [];
  let price = start;
  for (let i = 0; i < count; i++) {
    price *= 1 + (rand() - 0.5) * 0.01;
    out.push(price);
  }
  return out;
}

describe("isFirstTradingDayOfMonth", () => {
  it("前の営業日と月が変わっていれば月初", () => {
    const dates = ["2020-01-30", "2020-01-31", "2020-02-03", "2020-02-04"];
    expect(isFirstTradingDayOfMonth(dates, 1)).toBe(false);
    expect(isFirstTradingDayOfMonth(dates, 2)).toBe(true);
    expect(isFirstTradingDayOfMonth(dates, 3)).toBe(false);
  });

  it("先頭は判定できない", () => {
    expect(isFirstTradingDayOfMonth(["2020-02-03"], 0)).toBe(false);
  });

  it("年をまたいでも月初として拾う", () => {
    expect(isFirstTradingDayOfMonth(["2019-12-31", "2020-01-02"], 1)).toBe(true);
  });
});

describe("trailingVolatility", () => {
  it("値動きが無ければ0", () => {
    const values = new Array(100).fill(100);
    expect(trailingVolatility(values, 80, 60)).toBe(0);
  });

  it("値動きが2倍になればばらつきも2倍になる", () => {
    const small: number[] = [];
    const large: number[] = [];
    for (let i = 0; i < 100; i++) {
      small.push(100 * (1 + (i % 2 === 0 ? 0.001 : -0.001)));
      large.push(100 * (1 + (i % 2 === 0 ? 0.002 : -0.002)));
    }
    const a = trailingVolatility(small, 80, 60);
    const b = trailingVolatility(large, 80, 60);
    expect(b / a).toBeCloseTo(2, 2);
  });

  it("ウォームアップ前は計算しない", () => {
    expect(Number.isNaN(trailingVolatility(wander(100), 30, 60))).toBe(true);
  });
});

describe("collectMonthEffect", () => {
  const dates = businessDays(600);
  const values = wander(600);

  it("月初の営業日だけを拾う", () => {
    const samples = collectMonthEffect({ dates, values, lookback: 21, hold: 5 });
    expect(samples.length).toBeGreaterThan(10);
    for (const sample of samples) {
      expect(isFirstTradingDayOfMonth(dates, sample.index)).toBe(true);
    }
  });

  it("前月が上げていれば売り、下げていれば買い", () => {
    const samples = collectMonthEffect({ dates, values, lookback: 21, hold: 5 });
    for (const sample of samples) {
      const previousMove = values[sample.index] - values[sample.index - 21];
      expect(sample.sign).toBe(previousMove > 0 ? -1 : 1);
    }
  });

  it("hold 日後より先の値は使わない", () => {
    const samples = collectMonthEffect({ dates, values, lookback: 21, hold: 5 });
    const target = samples[3];

    // 使ってよい最後の位置より後ろを大きく書き換える
    const tampered = values.map((v, i) => (i > target.index + 5 ? v * 3 : v));
    const after = collectMonthEffect({ dates, values: tampered, lookback: 21, hold: 5 });

    const same = after.find((s) => s.index === target.index);
    expect(same).toBeDefined();
    expect(same!.rawReturn).toBeCloseTo(target.rawReturn, 12);
    expect(same!.sign).toBe(target.sign);
  });

  it("リターンはばらつきで割ってある（動きの大きい通貨に引きずられない）", () => {
    // 同じ形で値動きの大きさだけ2倍違う系列。割ってあれば同じ値になる
    const calm = wander(600, 5);
    const wild = calm.map((v, i) => (i === 0 ? v : calm[0] * (v / calm[0]) ** 2));

    const a = collectMonthEffect({ dates, values: calm, lookback: 21, hold: 5 });
    const b = collectMonthEffect({ dates, values: wild, lookback: 21, hold: 5 });
    expect(a.length).toBe(b.length);

    // 割っていなければ、変化率が2倍のぶん平均も2倍近くになる
    const ratio = mean(b.map((s) => Math.abs(s.rawReturn))) / mean(a.map((s) => Math.abs(s.rawReturn)));
    expect(ratio).toBeGreaterThan(0.8);
    expect(ratio).toBeLessThan(1.25);
  });

  it("最後まで hold 日ぶん残っていない月初は拾わない", () => {
    const samples = collectMonthEffect({ dates, values, lookback: 21, hold: 5 });
    for (const sample of samples) {
      expect(sample.index + 5).toBeLessThan(values.length);
    }
  });

  it("長さが違えば拒否する", () => {
    expect(() =>
      collectMonthEffect({ dates: dates.slice(0, 10), values, lookback: 21, hold: 5 }),
    ).toThrow(/長さ/);
  });

  it("逆張りが当たる系列では signedReturn がプラスに寄る", () => {
    // 月初の直後だけ、前月と逆に動く系列を組む
    const crafted = [...values];
    const samples = collectMonthEffect({ dates, values: crafted, lookback: 21, hold: 5 });
    for (const sample of samples) {
      // 前月の動きと逆向きに、5日かけて動かす
      const direction = sample.sign; // +1 なら上げてほしい
      for (let k = 1; k <= 5; k++) {
        crafted[sample.index + k] = crafted[sample.index] * (1 + direction * 0.01 * k);
      }
    }
    const after = collectMonthEffect({ dates, values: crafted, lookback: 21, hold: 5 });
    expect(mean(after.map((s) => s.signedReturn))).toBeGreaterThan(0);
  });
});

describe("permutationTest", () => {
  it("効果の無い入力では有意にならない", () => {
    const rand = makeRandom(99);
    const samples = Array.from({ length: 500 }, () => ({
      rawReturn: rand() - 0.5,
      sign: rand() < 0.5 ? 1 : -1,
    }));
    const { p } = permutationTest(samples, 7, 2000);
    expect(p).toBeGreaterThan(0.05);
  });

  it("向きが完全に当たっていれば有意になる", () => {
    const rand = makeRandom(11);
    const samples = Array.from({ length: 300 }, () => {
      const magnitude = rand() * 0.5 + 0.1;
      const sign = rand() < 0.5 ? 1 : -1;
      // 常に向きどおりに動く
      return { rawReturn: magnitude * sign, sign };
    });
    const { actual, p } = permutationTest(samples, 7, 2000);
    expect(actual).toBeGreaterThan(0);
    expect(p).toBeLessThan(0.01);
  });

  it("逆に効いている場合、片側では有意にならない", () => {
    const rand = makeRandom(13);
    const samples = Array.from({ length: 300 }, () => {
      const magnitude = rand() * 0.5 + 0.1;
      const sign = rand() < 0.5 ? 1 : -1;
      return { rawReturn: -magnitude * sign, sign };
    });
    expect(permutationTest(samples, 7, 2000).p).toBeGreaterThan(0.9);
    // 両側なら「逆に効いている」ことも拾える
    expect(permutationTest(samples, 7, 2000, true).p).toBeLessThan(0.01);
  });

  it("空なら p=1", () => {
    expect(permutationTest([], 7, 100)).toEqual({ actual: 0, p: 1 });
  });
});
