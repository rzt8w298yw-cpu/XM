/**
 * シグナルからロット数を出す
 *
 * `positionSizing` は純粋な計算で、こちらは「この銘柄・この口座で
 * 実際にいくつ発注できるか」を組み立てる層。
 *
 * 換算レートは推測しない。口座通貨と決済通貨が違い、レートが分からない
 * 場合は計算せずに理由を返す。ここで適当なレートを置くと、ロットが静かに
 * ずれて実際のリスクが変わってしまう。
 */
import {
  calculatePositionSize,
  pipValuePerLot,
  STANDARD_CONTRACT_SIZE,
  XM_STANDARD,
  type PositionSize,
} from "./positionSizing";
import type { SymbolSpec } from "./marketData";

export interface LotPlanInput {
  spec: SymbolSpec;
  /** 損切りまでの距離（pips） */
  stopDistancePips: number;
  accountBalance: number;
  riskPercent: number;
  /** 口座通貨（既定は円口座） */
  accountCurrency?: string;
  /**
   * 決済通貨→口座通貨の換算レート。
   * 決済通貨と口座通貨が同じ場合は不要。
   */
  quoteToAccountRate?: number;
}

export interface LotPlan extends PositionSize {
  /** 1ロットあたり1pipの価値（口座通貨建て） */
  pipValue: number;
}

/**
 * ロット数を計算する。計算できない場合は lots=0 と理由を返す。
 */
export function buildLotPlan(input: LotPlanInput): LotPlan | null {
  const accountCurrency = input.accountCurrency ?? "JPY";

  if (input.accountBalance <= 0) return null;

  const sameCurrency = input.spec.quoteCurrency === accountCurrency;
  const rate = sameCurrency ? 1 : input.quoteToAccountRate;

  if (rate === undefined || !Number.isFinite(rate) || rate <= 0) {
    return {
      lots: 0,
      riskAmount: input.accountBalance * (input.riskPercent / 100),
      actualLossAtStop: 0,
      actualRiskPercent: 0,
      pipValue: 0,
      warnings: [
        `${input.spec.quoteCurrency} から ${accountCurrency} への換算レートが不明なため` +
          `ロットを計算できません（推測すると実際のリスクがずれます）`,
      ],
    };
  }

  const pipValue = pipValuePerLot(STANDARD_CONTRACT_SIZE, input.spec.pipSize, rate);
  const size = calculatePositionSize({
    accountBalance: input.accountBalance,
    riskPercent: input.riskPercent,
    stopDistancePips: input.stopDistancePips,
    pipValuePerLot: pipValue,
    lotStep: XM_STANDARD,
  });

  return { ...size, pipValue };
}
