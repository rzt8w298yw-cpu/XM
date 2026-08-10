/**
 * 全シンボルの判定結果をJSONに書き出す。
 * 静的な共有ページ（Artifact）に埋め込むためのスナップショット生成用。
 *
 *   npx tsx scripts/exportSnapshot.ts > snapshot.json
 */
import { generateSignal } from "../lib/autoSignalEngine";
import { fetchMarketData, SYMBOLS } from "../lib/marketData";
import { buildTradePlan } from "../lib/tradePlan";
import { buildLotPlan } from "../lib/lotPlan";
import { loadStrategyConfig } from "../lib/strategyConfig";

async function main() {
  const { config: strategy } = loadStrategyConfig();
  const symbols = [];
  let source = "synthetic";
  let note: string | null = null;

  for (const spec of SYMBOLS) {
    const market = await fetchMarketData(spec.id);
    const result = generateSignal(
      market.candles1H, market.candles4H, market.candlesDaily, market.candles8H,
    );
    source = market.source;
    note = market.note ?? null;
    const tradePlan = buildTradePlan(
      result.signal, result.analysis.currentPrice, result.analysis.currentATR, spec.pipSize,
      {
        atrStopMultiplier: strategy.atrStopMultiplier,
        riskRewardRatio: strategy.riskRewardRatio,
      },
    );

    symbols.push({
      id: spec.id,
      label: spec.label,
      digits: spec.digits,
      pipSize: spec.pipSize,
      tradePlan,
      lotPlan: tradePlan
        ? buildLotPlan({
            spec,
            stopDistancePips: tradePlan.stopPips,
            accountBalance: strategy.accountBalance,
            riskPercent: strategy.riskPercent,
          })
        : null,
      ...result,
    });
  }

  process.stdout.write(JSON.stringify({ generatedAt: Date.now(), source, note, symbols }));
}

main().catch((e) => { console.error(e); process.exit(1); });
