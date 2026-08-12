import { NextResponse } from "next/server";
import { generateSignal } from "@/lib/autoSignalEngine";
import { fetchMarketData, findSymbolSpec, SIGNAL_SYMBOLS, SYMBOLS } from "@/lib/marketData";
import { buildTradePlan } from "@/lib/tradePlan";
import { loadStrategyConfig } from "@/lib/strategyConfig";
import { buildLotPlan } from "@/lib/lotPlan";
import { requiredAccuracy } from "@/lib/edgeMath";

// 毎リクエスト最新のレートを取りに行くのでキャッシュしない
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const requested = searchParams.get("symbol") ?? SIGNAL_SYMBOLS[0].id;

  // 知らない銘柄でUSD/JPYを見せない。求めたものと違うものが
  // 同じ見た目で返るほうが、エラーより危ない。
  //
  // 判定はここ1か所。以前は手前に `SYMBOLS.some(...)` の検査がもう1つ
  // 並んでいたが、通れば `findSymbolSpec` は必ず値を返すので、下の
  // 分岐——対応銘柄の一覧を返すほう——には決して到達しなかった。
  const spec = findSymbolSpec(requested);
  if (spec === null) {
    return NextResponse.json(
      {
        error: `未対応の銘柄です: ${requested}`,
        supported: SYMBOLS.map((s) => s.id),
      },
      { status: 400 },
    );
  }

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

    /**
     * その損切り幅とコストで、損益が±0になる的中率。
     *
     * 判定と一緒に出す。エントリーの根拠より先に「この設定で何%当てれば
     * ±0なのか」が要る。実データで確認できた的中率がこれを超えていない
     * 限り、どれだけ条件が揃っていても期待値はマイナスになる。
     */
    // WAITのときも出す。この水準はエントリーの前にこそ要る数字で、
    // シグナルが出てから見るものではない
    const stopPips =
      tradePlan?.stopPips ??
      (result.analysis.currentATR * strategy.atrStopMultiplier) / spec.pipSize;
    const breakEven =
      Number.isFinite(stopPips) && stopPips > 0
        ? requiredAccuracy({
            stopDistancePips: stopPips,
            riskRewardRatio: strategy.riskRewardRatio,
            costPips: strategy.assumedCostPips,
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
      breakEven,
      assumedCostPips: strategy.assumedCostPips,
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
