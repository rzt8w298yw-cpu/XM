import type { SignalResult } from "./autoSignalEngine";
import type { TradePlan } from "./tradePlan";
import type { LotPlan } from "./lotPlan";
import type { RequiredAccuracy } from "./edgeMath";

/** /api/signal のレスポンス形状 */
export interface SignalApiResponse extends SignalResult {
  symbol: string;
  symbolLabel: string;
  digits: number;
  pipSize: number;
  dataSource: "yahoo" | "synthetic";
  dataNote: string | null;
  candleCounts: { h1: number; h4: number; h8: number; daily: number };
  latestCandleTime: number | null;
  tradePlan: TradePlan | null;
  lotPlan: LotPlan | null;
  /** その損切り幅とコストで損益が±0になる的中率 */
  breakEven: RequiredAccuracy | null;
  /** 計算に使った往復コスト（pips） */
  assumedCostPips: number;
}

export interface SignalApiError {
  error: string;
}
