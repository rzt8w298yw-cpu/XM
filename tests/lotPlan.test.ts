/**
 * シグナルからロットを組む層の検証。
 *
 * 換算レートを推測すると、ロットが静かにずれて実際のリスクが変わる。
 * 分からないときは計算せずに理由を返すことを固定する。
 */
import { describe, expect, it } from "vitest";
import { buildLotPlan } from "../lib/lotPlan";
import { getSymbolSpec } from "../lib/marketData";

const usdjpy = getSymbolSpec("USDJPY"); // 決済通貨 JPY
const eurusd = getSymbolSpec("EURUSD"); // 決済通貨 USD

describe("buildLotPlan", () => {
  const base = { stopDistancePips: 20, accountBalance: 1_000_000, riskPercent: 2 };

  it("決済通貨と口座通貨が同じなら換算不要で計算できる", () => {
    const plan = buildLotPlan({ ...base, spec: usdjpy })!;
    // 1ロット1pip=1000円、2万円 ÷ (20pips × 1000円) = 1.0ロット
    expect(plan.pipValue).toBe(1000);
    expect(plan.lots).toBeCloseTo(1.0, 10);
    expect(plan.warnings).toEqual([]);
  });

  it("通貨が違い換算レートが無ければ計算せず理由を返す", () => {
    const plan = buildLotPlan({ ...base, spec: eurusd })!;
    expect(plan.lots).toBe(0);
    expect(plan.warnings.join()).toMatch(/換算レートが不明/);
  });

  it("換算レートを渡せば計算できる", () => {
    const plan = buildLotPlan({ ...base, spec: eurusd, quoteToAccountRate: 150 })!;
    // 1ロット1pip = 100,000 × 0.0001 × 150 = 1500円
    expect(plan.pipValue).toBeCloseTo(1500, 6);
    // 2万円 ÷ (20 × 1500) = 0.666… → 0.66に切り捨て
    expect(plan.lots).toBeCloseTo(0.66, 10);
  });

  it("残高が未設定ならロット計算自体を行わない", () => {
    expect(buildLotPlan({ ...base, spec: usdjpy, accountBalance: 0 })).toBeNull();
  });

  it("不正な換算レートは推測で埋めない", () => {
    for (const rate of [0, -1, Number.NaN]) {
      const plan = buildLotPlan({ ...base, spec: eurusd, quoteToAccountRate: rate })!;
      expect(plan.lots).toBe(0);
      expect(plan.warnings.join()).toMatch(/換算レートが不明/);
    }
  });

  it("口座通貨を指定できる", () => {
    // ドル口座ならEURUSDは換算不要。残高1万ドル・リスク2%なら200ドル
    const plan = buildLotPlan({
      ...base, spec: eurusd, accountCurrency: "USD", accountBalance: 10_000,
    })!;
    expect(plan.pipValue).toBeCloseTo(10, 6);
    // 200ドル ÷ (20pips × 10ドル) = 1.0ロット
    expect(plan.lots).toBeCloseTo(1.0, 10);
    expect(plan.warnings).toEqual([]);
  });

  it("上限を超える場合は丸めた上で警告する", () => {
    const plan = buildLotPlan({
      ...base, spec: eurusd, accountCurrency: "USD", accountBalance: 100_000_000,
    })!;
    expect(plan.lots).toBe(50);
    expect(plan.warnings.join()).toMatch(/上限/);
    // 上限に張り付いた分、実際のリスクは指定より小さい
    expect(plan.actualRiskPercent).toBeLessThan(base.riskPercent);
  });
});
