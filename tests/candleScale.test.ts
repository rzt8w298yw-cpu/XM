/**
 * 価格の桁の検査。
 *
 * 桁を取り違えると値動きの形は変わらず、pipの大きさだけが10倍・100倍
 * ずれる。チャートを見ても気づけないので、この検査が最後の砦になる。
 *
 * そして**検査が厳しすぎても困る。** 最初は1時間足と日足に同じ範囲を
 * 当てていて、低ボラ通貨の正しいデータを弾いた。両側を固定する。
 */
import { describe, expect, it } from "vitest";
import { checkScale, medianRangePips, RANGE_BOUNDS } from "../lib/candleScale";

/** 値幅がだいたい一定の足を作る */
function rows(rangePips: number, pipSize: number, base = 1.1, count = 101) {
  const range = rangePips * pipSize;
  return Array.from({ length: count }, (_, i) => ({
    // 中央値がぶれないよう、幅だけを少し散らす
    high: base + range * (1 + (i % 3) * 0.01),
    low: base,
  }));
}

describe("medianRangePips", () => {
  it("値幅の中央値をpipで返す", () => {
    expect(medianRangePips(rows(50, 0.0001), 0.0001)).toBeCloseTo(50, 0);
  });

  it("pipの大きさが100倍違えば、結果も100分の1になる", () => {
    const bars = rows(50, 0.0001);
    expect(medianRangePips(bars, 0.01) * 100).toBeCloseTo(medianRangePips(bars, 0.0001), 0);
  });

  it("空や不正な入力ではNaN", () => {
    expect(Number.isNaN(medianRangePips([], 0.0001))).toBe(true);
    expect(Number.isNaN(medianRangePips(rows(50, 0.0001), 0))).toBe(true);
  });
});

describe("checkScale", () => {
  it("ドル円の日足（90 pips）は通る", () => {
    expect(checkScale(rows(90, 0.01, 150), 0.01, "d1").ok).toBe(true);
  });

  it("低ボラ通貨の1時間足（8 pips）を弾かない", () => {
    // EURCHFの実際の姿。桁違いではないので通さなければならない
    const result = checkScale(rows(8, 0.0001), 0.0001, "h1");
    expect(result.ok).toBe(true);
    expect(result.medianPips).toBeCloseTo(8, 0);
  });

  it("同じ8 pipsでも日足なら疑う", () => {
    // 日足で8 pipsは、桁を1つ取り違えている疑いが濃い
    expect(checkScale(rows(8, 0.0001), 0.0001, "d1").ok).toBe(false);
  });

  it("桁を100倍取り違えれば弾く", () => {
    // 5桁の通貨を3桁（0.01）として読むと、値幅が100分の1に見える
    const bars = rows(90, 0.0001);
    expect(checkScale(bars, 0.0001, "d1").ok).toBe(true);
    expect(checkScale(bars, 0.01, "d1").ok).toBe(false);
  });

  it("桁を100分の1に取り違えても弾く", () => {
    // 3桁の通貨を5桁として読むと、値幅が100倍に見える
    const bars = rows(90, 0.01, 150);
    expect(checkScale(bars, 0.0001, "d1").ok).toBe(false);
    expect(checkScale(bars, 0.0001, "d1").reason).toMatch(/桁数の想定/);
  });

  it("1時間足の範囲は日足より下に伸びている", () => {
    // 1時間足の値幅は日足のおよそ10分の1。同じ範囲を当てると誤検知する
    expect(RANGE_BOUNDS.h1.min).toBeLessThan(RANGE_BOUNDS.d1.min);
    expect(RANGE_BOUNDS.h1.max).toBeLessThan(RANGE_BOUNDS.d1.max);
  });

  it("計算できなければ理由を返す", () => {
    const result = checkScale([], 0.0001, "h1");
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/計算できません/);
  });
});
