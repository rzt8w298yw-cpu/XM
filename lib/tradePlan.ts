/**
 * ATRベースの売買プラン（エントリー / 損切り / 利確）
 *
 * 損切り幅を ATR の一定倍に置くことで、ボラティリティに応じて
 * ストップの距離が自動で伸縮する。利確はリスクリワード比から逆算する。
 */
import type { SignalType } from "./autoSignalEngine";

export interface TradePlan {
  entry: number;
  stopLoss: number;
  takeProfit: number;
  stopPips: number;
  targetPips: number;
  riskRewardRatio: number;
}

const ATR_STOP_MULTIPLIER = 1.5;
const RISK_REWARD_RATIO = 2;

export function buildTradePlan(
  signal: SignalType,
  price: number,
  atr: number,
  pipSize: number,
): TradePlan | null {
  if (signal === "WAIT" || atr <= 0 || pipSize <= 0) return null;

  const stopDistance = atr * ATR_STOP_MULTIPLIER;
  const targetDistance = stopDistance * RISK_REWARD_RATIO;
  const direction = signal === "BUY" ? 1 : -1;

  return {
    entry: price,
    stopLoss: price - stopDistance * direction,
    takeProfit: price + targetDistance * direction,
    stopPips: stopDistance / pipSize,
    targetPips: targetDistance / pipSize,
    riskRewardRatio: RISK_REWARD_RATIO,
  };
}
