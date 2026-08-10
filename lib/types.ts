import type { SignalResult } from "./autoSignalEngine";
import type { TradePlan } from "./tradePlan";
import type { LotPlan } from "./lotPlan";

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
}

export interface SignalApiError {
  error: string;
}
