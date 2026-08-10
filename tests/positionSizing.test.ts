/**
 * ロット計算の検証。
 *
 * ここが1桁ずれると資金がそのまま吹き飛ぶ。丸めの方向（必ず切り捨て）と、
 * 発注できない場合に黙って0を返さず理由を残すことを固定する。
 */
import { describe, expect, it } from "vitest";
import {
  calculatePositionSize,
  pipValuePerLot,
  STANDARD_CONTRACT_SIZE,
  XM_STANDARD,
} from "../lib/positionSizing";

describe("pipValuePerLot", () => {
  it("ドル円・円口座なら1ロット1pipは1000円", () => {
    // 100,000通貨 × 0.01円 × 1 = 1000円
    expect(pipValuePerLot(STANDARD_CONTRACT_SIZE, 0.01, 1)).toBe(1000);
  });

  it("ユーロドル・円口座なら換算レートが効く", () => {
    // 100,000通貨 × 0.0001ドル = 10ドル。1ドル=150円なら1500円
    expect(pipValuePerLot(STANDARD_CONTRACT_SIZE, 0.0001, 150)).toBeCloseTo(1500, 10);
  });

  it("不正な入力では0を返す", () => {
    expect(pipValuePerLot(0, 0.01, 1)).toBe(0);
    expect(pipValuePerLot(STANDARD_CONTRACT_SIZE, 0.01, 0)).toBe(0);
    expect(pipValuePerLot(STANDARD_CONTRACT_SIZE, -0.01, 1)).toBe(0);
  });
});

describe("calculatePositionSize", () => {
  const base = {
    accountBalance: 1_000_000, // 100万円
    riskPercent: 2,            // 1トレード2% = 2万円
    stopDistancePips: 20,
    pipValuePerLot: 1000,      // ドル円・円口座
  };

  it("損切り幅とリスク割合からロットを出す", () => {
    // 2万円 ÷ (20pips × 1000円) = 1.0ロット
    const result = calculatePositionSize(base);
    expect(result.lots).toBeCloseTo(1.0, 10);
    expect(result.riskAmount).toBe(20_000);
    expect(result.actualLossAtStop).toBeCloseTo(20_000, 6);
    expect(result.actualRiskPercent).toBeCloseTo(2, 6);
    expect(result.warnings).toEqual([]);
  });

  it("損切りが広いほどロットは小さくなる", () => {
    const narrow = calculatePositionSize({ ...base, stopDistancePips: 10 });
    const wide = calculatePositionSize({ ...base, stopDistancePips: 40 });
    expect(narrow.lots).toBeCloseTo(2.0, 10);
    expect(wide.lots).toBeCloseTo(0.5, 10);
    // 損切り幅が変わってもリスク額は一定に保たれる
    expect(narrow.actualLossAtStop).toBeCloseTo(wide.actualLossAtStop, 6);
  });

  it("刻みには必ず切り捨てる（切り上げるとリスクを超える）", () => {
    // 2万円 ÷ (30pips × 1000円) = 0.6666... → 0.66
    const result = calculatePositionSize({ ...base, stopDistancePips: 30 });
    expect(result.lots).toBeCloseTo(0.66, 10);
    expect(result.actualLossAtStop).toBeLessThanOrEqual(result.riskAmount);
    expect(result.actualRiskPercent).toBeLessThanOrEqual(base.riskPercent);
  });

  it("最小ロットに満たない場合は0を返し、理由を残す", () => {
    // 残高が小さすぎて0.01ロットにも届かない
    const result = calculatePositionSize({
      ...base,
      accountBalance: 5_000,
      riskPercent: 1,
      stopDistancePips: 50,
    });
    expect(result.lots).toBe(0);
    expect(result.warnings.join()).toMatch(/最小単位/);
  });

  it("上限を超える場合は上限に丸めて警告する", () => {
    const result = calculatePositionSize({
      ...base,
      accountBalance: 1_000_000_000,
    });
    expect(result.lots).toBe(XM_STANDARD.maxLot);
    expect(result.warnings.join()).toMatch(/上限/);
    // 上限に張り付いた分、実際のリスクは指定より小さい
    expect(result.actualRiskPercent).toBeLessThan(base.riskPercent);
  });

  it("不正な入力では発注せず理由を返す", () => {
    for (const bad of [
      { ...base, accountBalance: 0 },
      { ...base, riskPercent: -1 },
      { ...base, stopDistancePips: 0 },
      { ...base, pipValuePerLot: Number.NaN },
    ]) {
      const result = calculatePositionSize(bad);
      expect(result.lots).toBe(0);
      expect(result.warnings).toHaveLength(1);
    }
  });

  it("実際のリスク割合は丸め後のロットで計算する", () => {
    const result = calculatePositionSize({ ...base, stopDistancePips: 30 });
    // 0.66ロット × 30pips × 1000円 = 19,800円 → 1.98%
    expect(result.actualLossAtStop).toBeCloseTo(19_800, 6);
    expect(result.actualRiskPercent).toBeCloseTo(1.98, 6);
  });
});
