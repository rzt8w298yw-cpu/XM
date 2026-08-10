/**
 * スプレッド条件とスコア計算の検証。
 *
 * 以前は実スプレッドを知る術がないのに条件が常に成立し、重み1が無条件で
 * 加算されていた。評価できないものを「満たした」と数えるとスコアが底上げされる。
 * ここでは、評価できない条件が分子からも分母からも外れることを固定する。
 */
import { describe, expect, it } from "vitest";
import { checkSpread } from "../lib/technicalAnalysis";
import {
  generateSignal,
  weightedScore,
  type ConditionResult,
} from "../lib/autoSignalEngine";
import { createSimulator } from "../lib/priceSimulator";
import { aggregate } from "../lib/marketData";

describe("checkSpread", () => {
  it("値が渡されなければ評価不能とする", () => {
    for (const value of [undefined, null, Number.NaN]) {
      const result = checkSpread(value, 3);
      expect(result.available).toBe(false);
      expect(result.description).toMatch(/未取得/);
    }
  });

  it("上限以内なら成立", () => {
    const result = checkSpread(1.2, 3);
    expect(result.available).toBe(true);
    expect(result.ok).toBe(true);
  });

  it("上限ちょうどは成立、超えたら不成立", () => {
    expect(checkSpread(3, 3).ok).toBe(true);
    expect(checkSpread(3.1, 3).ok).toBe(false);
  });

  it("超過時は理由が分かる文言になる", () => {
    expect(checkSpread(5, 3).description).toMatch(/超過/);
  });
});

describe("weightedScore", () => {
  function condition(
    id: string, met: boolean, weight: number, available?: boolean,
  ): ConditionResult {
    return { id, name: id, category: "filter", met, value: "", weight, available };
  }

  it("評価できない条件は分母からも外す", () => {
    const score = weightedScore([
      condition("a", true, 3),
      condition("b", false, 1),
      condition("c", true, 1, false), // 評価不能
    ]);
    // 3/(3+1) = 75%。評価不能の1は分子にも分母にも入らない
    expect(score.totalWeight).toBe(4);
    expect(score.metWeight).toBe(3);
    expect(score.ratio).toBeCloseTo(0.75, 10);
  });

  it("評価不能を満たし扱いにするとスコアが底上げされる（それを避けている）", () => {
    const withUnavailable = weightedScore([
      condition("a", true, 3),
      condition("b", false, 1),
      condition("c", true, 1, false),
    ]);
    const ifCounted = (3 + 1) / (3 + 1 + 1); // 80%
    expect(withUnavailable.ratio).toBeLessThan(ifCounted);
  });

  it("available が未指定なら評価済みとして扱う", () => {
    const score = weightedScore([condition("a", true, 2)]);
    expect(score.totalWeight).toBe(2);
    expect(score.ratio).toBe(1);
  });

  it("全て評価不能ならゼロ除算せずに0を返す", () => {
    const score = weightedScore([condition("a", true, 2, false)]);
    expect(score.totalWeight).toBe(0);
    expect(score.ratio).toBe(0);
  });
});

describe("エンジンのスプレッド条件", () => {
  const TS = Date.UTC(2026, 0, 5, 9, 0, 0);
  function run(options: Parameters<typeof generateSignal>[4]) {
    const candles = createSimulator(700, { bars: 9000 });
    const window = candles.slice(-1000);
    return generateSignal(
      window, aggregate(window, 4), aggregate(candles, 24), aggregate(window, 8), options,
    );
  }

  it("スプレッドを渡さなければ評価不能として除外する", () => {
    const result = run({ overrideTimestamp: TS });
    const spread = result.conditions.find((c) => c.id === "spread_filter")!;
    expect(spread.available).toBe(false);
    // 分母から外れているので、全条件の重み合計より小さい
    const allWeights = result.conditions.reduce((sum, c) => sum + c.weight, 0);
    expect(weightedScore(result.conditions).totalWeight).toBe(allWeights - spread.weight);
  });

  it("実スプレッドを渡せば評価対象になる", () => {
    const result = run({ overrideTimestamp: TS, spreadPips: 1.2, maxSpreadPips: 3 });
    const spread = result.conditions.find((c) => c.id === "spread_filter")!;
    expect(spread.available).toBe(true);
    expect(spread.met).toBe(true);
  });

  it("上限を超えるスプレッドは不成立になる", () => {
    const result = run({ overrideTimestamp: TS, spreadPips: 9, maxSpreadPips: 3 });
    const spread = result.conditions.find((c) => c.id === "spread_filter")!;
    expect(spread.available).toBe(true);
    expect(spread.met).toBe(false);
  });
});
