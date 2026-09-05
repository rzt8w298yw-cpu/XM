/**
 * キャリートレード計算の検証。
 *
 * ロット計算は positionSizing と同じ式を再利用しているだけなので、
 * ここではスワップとの掛け合わせ・警告条件だけを固定する。
 */
import { describe, expect, it } from "vitest";
import { accumulatedSwap, daysHeld, planCarryPosition } from "../lib/carryTrade";

describe("planCarryPosition", () => {
  const base = {
    accountBalance: 1_000_000, // 100万円
    riskPercent: 2,            // 2万円まで
    maxAdverseMovePips: 200,
    pipValuePerLot: 1000,      // ドル円・円口座
    swapPerLotPerNight: 150,   // 1ロット・1晩150円のプラススワップ
  };

  it("ロットは positionSizing と同じ式で決まる", () => {
    const plan = planCarryPosition(base);
    // (1,000,000 * 0.02) / (200 * 1000) = 0.1 lot
    expect(plan.lots).toBeCloseTo(0.1, 10);
    expect(plan.actualLossAtMaxAdverse).toBeCloseTo(20_000, 10);
    expect(plan.actualRiskPercent).toBeCloseTo(2, 10);
  });

  it("スワップ収入をロット・日数で積み上げる", () => {
    const plan = planCarryPosition(base);
    expect(plan.dailySwap).toBeCloseTo(0.1 * 150, 10);
    expect(plan.monthlySwap).toBeCloseTo(plan.dailySwap * 30, 10);
    expect(plan.annualSwap).toBeCloseTo(plan.dailySwap * 365, 10);
    expect(plan.annualYieldOnBalance).toBeCloseTo((plan.annualSwap / base.accountBalance) * 100, 10);
  });

  it("スワップが0以下なら警告を出す（この戦略の前提が成り立たない）", () => {
    const plan = planCarryPosition({ ...base, swapPerLotPerNight: -50 });
    expect(plan.warnings.some((w) => w.includes("マイナス"))).toBe(true);
    expect(plan.daysOfSwapToOffsetMaxAdverse).toBeNull();
  });

  it("最大逆行の回収に1年超かかるなら警告を出す", () => {
    // 0.1 lot × 150円/日 = 15円/日。損失2万円を回収するのに約1,333日
    const plan = planCarryPosition(base);
    expect(plan.daysOfSwapToOffsetMaxAdverse).toBeGreaterThan(365);
    expect(plan.warnings.some((w) => w.includes("値動きのリスクに対して"))).toBe(true);
  });

  it("不正な入力では0とエラーメッセージを返す（黙って0にしない）", () => {
    const plan = planCarryPosition({ ...base, accountBalance: 0 });
    expect(plan.lots).toBe(0);
    expect(plan.warnings.length).toBeGreaterThan(0);
  });
});

describe("daysHeld / accumulatedSwap", () => {
  it("経過日数を単純な日数差で出す", () => {
    expect(daysHeld("2026-08-01", "2026-08-10")).toBe(9);
    expect(daysHeld("2026-08-10", "2026-08-10")).toBe(0);
  });

  it("累積スワップは経過日数×ロット×1晩あたりスワップ", () => {
    const position = {
      id: "1",
      pair: "USDJPY",
      direction: "LONG" as const,
      lots: 0.1,
      swapPerLotPerNight: 150,
      entryDate: "2026-08-01",
    };
    expect(accumulatedSwap(position, "2026-08-11")).toBeCloseTo(10 * 0.1 * 150, 10);
  });
});
