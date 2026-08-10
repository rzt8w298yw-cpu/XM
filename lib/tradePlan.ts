/**
 * ATRベースの売買プラン（エントリー / 損切り / 利確）
 *
 * 損切り幅を ATR の一定倍に置くことで、ボラティリティに応じて
 * ストップの距離が自動で伸縮する。利確はリスクリワード比から逆算する。
 */
import type { SignalType } from "./autoSignalEngine";
import { DEFAULT_STRATEGY } from "./strategyConfig";

export interface TradePlan {
  entry: number;
  stopLoss: number;
  takeProfit: number;
  stopPips: number;
  targetPips: number;
  riskRewardRatio: number;
}

export interface TradePlanOptions {
  atrStopMultiplier: number;
  riskRewardRatio: number;
}

export function buildTradePlan(
  signal: SignalType,
  price: number,
  atr: number,
  pipSize: number,
  options: TradePlanOptions = {
    atrStopMultiplier: DEFAULT_STRATEGY.atrStopMultiplier,
    riskRewardRatio: DEFAULT_STRATEGY.riskRewardRatio,
  },
): TradePlan | null {
  if (signal === "WAIT" || atr <= 0 || pipSize <= 0) return null;

  const stopDistance = atr * options.atrStopMultiplier;
  const targetDistance = stopDistance * options.riskRewardRatio;
  const direction = signal === "BUY" ? 1 : -1;

  return {
    entry: price,
    stopLoss: price - stopDistance * direction,
    takeProfit: price + targetDistance * direction,
    stopPips: stopDistance / pipSize,
    targetPips: targetDistance / pipSize,
    riskRewardRatio: options.riskRewardRatio,
  };
}
