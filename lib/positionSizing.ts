/**
 * ロット計算（資金管理）
 *
 * バックテストはpipsで損益を測るが、pipsは金額ではない。
 * 「最大ドローダウン200pips」が痛いのかどうかは、1pipあたりいくら賭けて
 * いるかで決まる。ここは損切り幅から逆算して、1トレードで失う金額を
 * 口座残高の一定割合に固定するための計算。
 *
 * 為替の換算レートは推測せず、呼び出し側から受け取る。ここで適当な
 * レートを仮定すると、ロットが静かにずれて実際のリスクが変わってしまう。
 */

export interface LotStep {
  /** 最小取引単位（XMのマイクロ口座なら0.01） */
  minLot: number;
  /** 発注できる最大ロット */
  maxLot: number;
  /** ロットの刻み */
  step: number;
}

export const XM_STANDARD: LotStep = { minLot: 0.01, maxLot: 50, step: 0.01 };

export interface PositionSizeInput {
  /** 口座残高（口座通貨建て） */
  accountBalance: number;
  /** 1トレードで許容する損失の割合（%）。2 なら残高の2% */
  riskPercent: number;
  /** 損切りまでの距離（pips） */
  stopDistancePips: number;
  /** 1ロットあたり1pipの価値（口座通貨建て） */
  pipValuePerLot: number;
  lotStep?: LotStep;
}

export interface PositionSize {
  /** 発注ロット数（刻みに丸め済み） */
  lots: number;
  /** 許容損失額（口座通貨） */
  riskAmount: number;
  /** 実際に損切りに達した場合の損失額（丸め後のロットで再計算） */
  actualLossAtStop: number;
  /** 丸め後のロットで見た、実際のリスク割合（%） */
  actualRiskPercent: number;
  /** 発注できない場合の理由 */
  warnings: string[];
}

/**
 * 損切り幅とリスク許容度からロット数を決める。
 *
 * lots = (残高 × リスク割合) / (損切りpips × 1ロットあたりのpip価値)
 *
 * 刻みに丸める際は必ず切り捨てる。切り上げると意図したリスクを超えるため。
 */
export function calculatePositionSize(input: PositionSizeInput): PositionSize {
  const lotStep = input.lotStep ?? XM_STANDARD;
  const warnings: string[] = [];

  const invalid =
    !Number.isFinite(input.accountBalance) || input.accountBalance <= 0 ||
    !Number.isFinite(input.riskPercent) || input.riskPercent <= 0 ||
    !Number.isFinite(input.stopDistancePips) || input.stopDistancePips <= 0 ||
    !Number.isFinite(input.pipValuePerLot) || input.pipValuePerLot <= 0;

  if (invalid) {
    return {
      lots: 0,
      riskAmount: 0,
      actualLossAtStop: 0,
      actualRiskPercent: 0,
      warnings: ["残高・リスク割合・損切り幅・pip価値はいずれも正の数である必要があります"],
    };
  }

  const riskAmount = input.accountBalance * (input.riskPercent / 100);
  const lossPerLot = input.stopDistancePips * input.pipValuePerLot;
  const rawLots = riskAmount / lossPerLot;

  // 刻みに切り捨てる（切り上げると意図したリスクを超える）
  const steps = Math.floor(rawLots / lotStep.step);
  let lots = Number((steps * lotStep.step).toFixed(10));

  if (lots < lotStep.minLot) {
    warnings.push(
      `必要ロット ${rawLots.toFixed(4)} が最小単位 ${lotStep.minLot} を下回ります。` +
        `このリスク設定では発注できません（損切りを狭めるか、リスク割合を上げるか、残高を増やす必要があります）`,
    );
    lots = 0;
  } else if (lots > lotStep.maxLot) {
    warnings.push(
      `必要ロット ${rawLots.toFixed(2)} が上限 ${lotStep.maxLot} を超えるため上限に丸めました。` +
        `実際のリスクは指定より小さくなります`,
    );
    lots = lotStep.maxLot;
  }

  const actualLossAtStop = lots * lossPerLot;

  return {
    lots,
    riskAmount,
    actualLossAtStop,
    actualRiskPercent: (actualLossAtStop / input.accountBalance) * 100,
    warnings,
  };
}

/**
 * 1ロットあたり1pipの価値を求める。
 *
 * pip価値 = 1ロットの通貨量 × pipの大きさ ÷（決済通貨→口座通貨の換算レート）
 *
 * 決済通貨（ペアの後ろ側）と口座通貨が同じなら換算は不要なので
 * `quoteToAccountRate` に 1 を渡す。違う場合は必ず実レートを渡すこと。
 * ここで推測すると、ロットが静かにずれて実際のリスクが変わる。
 */
export function pipValuePerLot(
  contractSize: number,
  pipSize: number,
  quoteToAccountRate: number,
): number {
  if (
    !Number.isFinite(contractSize) || contractSize <= 0 ||
    !Number.isFinite(pipSize) || pipSize <= 0 ||
    !Number.isFinite(quoteToAccountRate) || quoteToAccountRate <= 0
  ) {
    return 0;
  }
  return contractSize * pipSize * quoteToAccountRate;
}

/** 標準ロットの通貨量 */
export const STANDARD_CONTRACT_SIZE = 100_000;
