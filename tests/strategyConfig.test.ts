/**
 * 戦略設定の読み込みの検証。
 *
 * ここが黙って既定値に落ちると、設定したつもりで効いていない状態になる。
 * 不正な値を無視すること、そのとき必ず警告を残すことを固定する。
 */
import { describe, expect, it } from "vitest";
import { DEFAULT_STRATEGY, loadStrategyConfig } from "../lib/strategyConfig";
import { buildTradePlan } from "../lib/tradePlan";

describe("loadStrategyConfig", () => {
  it("未設定なら既定値を返す", () => {
    const { config, overrides, warnings } = loadStrategyConfig({});
    expect(config).toEqual(DEFAULT_STRATEGY);
    expect(overrides).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it("環境変数で上書きできる", () => {
    const { config, overrides } = loadStrategyConfig({
      SIGNAL_BUY_SCORE_MIN: "0.7",
      SIGNAL_BUY_RSI_MAX: "80",
      TRADE_ATR_STOP: "2",
      TRADE_RISK_REWARD: "1.5",
    });
    expect(config.thresholds.buyScoreMin).toBe(0.7);
    expect(config.thresholds.buyRsiMax).toBe(80);
    expect(config.atrStopMultiplier).toBe(2);
    expect(config.riskRewardRatio).toBe(1.5);
    // 指定していない項目は既定値のまま
    expect(config.thresholds.sellScoreMin).toBe(DEFAULT_STRATEGY.thresholds.sellScoreMin);
    expect(overrides).toHaveLength(4);
  });

  it("数値でない値は無視して警告する", () => {
    const { config, warnings } = loadStrategyConfig({ TRADE_RISK_REWARD: "たくさん" });
    expect(config.riskRewardRatio).toBe(DEFAULT_STRATEGY.riskRewardRatio);
    expect(warnings.join()).toMatch(/TRADE_RISK_REWARD/);
  });

  it("範囲外の値は無視して警告する", () => {
    const { config, warnings } = loadStrategyConfig({
      SIGNAL_BUY_SCORE_MIN: "1.5", // 0〜1 の範囲外
      SIGNAL_BUY_RSI_MAX: "0",     // 1〜100 の範囲外
    });
    expect(config.thresholds.buyScoreMin).toBe(DEFAULT_STRATEGY.thresholds.buyScoreMin);
    expect(config.thresholds.buyRsiMax).toBe(DEFAULT_STRATEGY.thresholds.buyRsiMax);
    expect(warnings).toHaveLength(2);
  });

  it("空文字は未設定として扱う", () => {
    const { config, overrides, warnings } = loadStrategyConfig({ TRADE_ATR_STOP: "   " });
    expect(config.atrStopMultiplier).toBe(DEFAULT_STRATEGY.atrStopMultiplier);
    expect(overrides).toEqual([]);
    expect(warnings).toEqual([]);
  });
});

describe("buildTradePlan", () => {
  it("既定では損切り1.5ATR・リスクリワード1:2", () => {
    // ATR 0.2 → 損切り 0.30 (30pips) / 利確 0.60 (60pips)
    const plan = buildTradePlan("BUY", 150, 0.2, 0.01)!;
    expect(plan.stopPips).toBeCloseTo(30, 10);
    expect(plan.targetPips).toBeCloseTo(60, 10);
    expect(plan.stopLoss).toBeCloseTo(149.7, 10);
    expect(plan.takeProfit).toBeCloseTo(150.6, 10);
  });

  it("設定を渡すと損切り幅と利確幅が変わる", () => {
    const plan = buildTradePlan("BUY", 150, 0.2, 0.01, {
      atrStopMultiplier: 2,
      riskRewardRatio: 1.5,
    })!;
    // 損切り 0.40 (40pips) / 利確 0.60 (60pips)
    expect(plan.stopPips).toBeCloseTo(40, 10);
    expect(plan.targetPips).toBeCloseTo(60, 10);
    expect(plan.riskRewardRatio).toBe(1.5);
  });

  it("SELLは方向が反転する", () => {
    const plan = buildTradePlan("SELL", 150, 0.2, 0.01)!;
    expect(plan.stopLoss).toBeCloseTo(150.3, 10);
    expect(plan.takeProfit).toBeCloseTo(149.4, 10);
  });

  it("WAITとATR0ではプランを作らない", () => {
    expect(buildTradePlan("WAIT", 150, 0.2, 0.01)).toBeNull();
    expect(buildTradePlan("BUY", 150, 0, 0.01)).toBeNull();
  });
});
