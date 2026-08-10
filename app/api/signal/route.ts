import { NextResponse } from "next/server";
import { generateSignal } from "@/lib/autoSignalEngine";
import { fetchMarketData, getSymbolSpec, SYMBOLS } from "@/lib/marketData";
import { buildTradePlan } from "@/lib/tradePlan";
import { loadStrategyConfig } from "@/lib/strategyConfig";
import { buildLotPlan } from "@/lib/lotPlan";

// 毎リクエスト最新のレートを取りに行くのでキャッシュしない
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const requested = searchParams.get("symbol") ?? SYMBOLS[0].id;

  if (!SYMBOLS.some((s) => s.id === requested)) {
    return NextResponse.json(
      { error: `未対応のシンボルです: ${requested}` },
      { status: 400 },
    );
  }

  const spec = getSymbolSpec(requested);

  try {
    const { config: strategy, warnings } = loadStrategyConfig();
    for (const warning of warnings) console.warn(`戦略設定: ${warning}`);

    const market = await fetchMarketData(spec.id);
    const result = generateSignal(
      market.candles1H,
      market.candles4H,
      market.candlesDaily,
      market.candles8H,
      { thresholds: strategy.thresholds },
    );
    const tradePlan = buildTradePlan(
      result.signal,
      result.analysis.currentPrice,
      result.analysis.currentATR,
      spec.pipSize,
      {
        atrStopMultiplier: strategy.atrStopMultiplier,
        riskRewardRatio: strategy.riskRewardRatio,
      },
    );

    // 口座残高が設定されていればロットも出す。pipsは金額ではないので、
    // これが無いとリスクの実際の大きさが分からない
    const lotPlan = tradePlan
      ? buildLotPlan({
          spec,
          stopDistancePips: tradePlan.stopPips,
          accountBalance: strategy.accountBalance,
          riskPercent: strategy.riskPercent,
        })
      : null;

    return NextResponse.json({
      symbol: spec.id,
      symbolLabel: spec.label,
      digits: spec.digits,
      pipSize: spec.pipSize,
      dataSource: market.source,
      dataNote: market.note ?? null,
      candleCounts: {
        h1: market.candles1H.length,
        h4: market.candles4H.length,
        h8: market.candles8H.length,
        daily: market.candlesDaily.length,
      },
      latestCandleTime: market.candles1H.at(-1)?.timestamp ?? null,
      tradePlan,
      lotPlan,
      ...result,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json(
      { error: `シグナル生成に失敗しました: ${message}` },
      { status: 500 },
    );
  }
}
