/**
 * キャリートレード計算（金利差戦略）
 *
 * このリポジトリで検証した12個のアイデア（テクニカル指標・出来高・VIX・
 * 金利レジーム・通貨バスケット・トレーリングストップ）はすべて、価格の
 * 「方向」を当てようとして優位性ゼロに終わった。キャリートレードは方向を
 * 当てる手法ではなく、金利差（スワップ）を積み上げる手法であり、性質が違う。
 *
 * ここではスワップの実値をユーザーから受け取り、それをリスク管理・
 * ポジションサイズ・想定利回りに変換するだけの、判定を含まない計算関数を置く。
 * 「勝てる」という予測はどこにも書かない——過去の検証で予測が外れ続けたのは
 * 判定ロジックの問題であり、計算そのものを予測に使わないここでは再発しない。
 */

export interface CarryPositionInput {
  /** 口座残高（口座通貨建て） */
  accountBalance: number;
  /** 1トレードで許容する損失の割合（%） */
  riskPercent: number;
  /** 逆行時に耐える最大の値幅（pips）。ここに達したら手仕舞う前提でロットを決める */
  maxAdverseMovePips: number;
  /** 1ロットあたり1pipの価値（口座通貨建て） */
  pipValuePerLot: number;
  /** 1ロット・1晩あたりのスワップ（口座通貨建て、MT5の建玉画面から直接読む） */
  swapPerLotPerNight: number;
}

export interface CarryPositionPlan {
  lots: number;
  riskAmount: number;
  actualLossAtMaxAdverse: number;
  actualRiskPercent: number;
  /** 1日あたりのスワップ収入（口座通貨） */
  dailySwap: number;
  /** 30日あたりのスワップ収入 */
  monthlySwap: number;
  /** 365日あたりのスワップ収入 */
  annualSwap: number;
  /** 年間スワップ ÷ 口座残高（%）。ポジションの証拠金効率ではなく、口座全体に対する規模感 */
  annualYieldOnBalance: number;
  /** 最大許容逆行を打ち消すのに必要な日数（スワップだけで、値動きを考慮しない単純計算） */
  daysOfSwapToOffsetMaxAdverse: number | null;
  warnings: string[];
}

/**
 * ロット数を決め、そのロットでのスワップ収入とリスクを一緒に出す。
 *
 * ロット計算そのものは `lib/positionSizing.ts` の `calculatePositionSize` と同じ式
 * （残高×リスク割合 ÷ (許容逆行pips × pip価値)）。ここではその結果に
 * スワップを掛け合わせるところだけを追加する。
 */
export function planCarryPosition(input: CarryPositionInput): CarryPositionPlan {
  const warnings: string[] = [];

  const invalid =
    !Number.isFinite(input.accountBalance) || input.accountBalance <= 0 ||
    !Number.isFinite(input.riskPercent) || input.riskPercent <= 0 ||
    !Number.isFinite(input.maxAdverseMovePips) || input.maxAdverseMovePips <= 0 ||
    !Number.isFinite(input.pipValuePerLot) || input.pipValuePerLot <= 0;

  if (invalid) {
    return {
      lots: 0, riskAmount: 0, actualLossAtMaxAdverse: 0, actualRiskPercent: 0,
      dailySwap: 0, monthlySwap: 0, annualSwap: 0, annualYieldOnBalance: 0,
      daysOfSwapToOffsetMaxAdverse: null,
      warnings: ["残高・リスク割合・許容逆行幅・pip価値はいずれも正の数である必要があります"],
    };
  }

  const riskAmount = input.accountBalance * (input.riskPercent / 100);
  const lossPerLot = input.maxAdverseMovePips * input.pipValuePerLot;
  const lots = riskAmount / lossPerLot;
  const actualLossAtMaxAdverse = lots * lossPerLot;

  const dailySwap = lots * input.swapPerLotPerNight;
  const monthlySwap = dailySwap * 30;
  const annualSwap = dailySwap * 365;

  if (input.swapPerLotPerNight <= 0) {
    warnings.push(
      "スワップがマイナスまたは0です。キャリートレードは金利差を積み上げる手法のため、" +
        "スワップがプラスに転じている方向でなければこの戦略の前提が成り立ちません。",
    );
  }

  const daysOfSwapToOffsetMaxAdverse =
    dailySwap > 0 ? Math.ceil(actualLossAtMaxAdverse / dailySwap) : null;

  if (daysOfSwapToOffsetMaxAdverse !== null && daysOfSwapToOffsetMaxAdverse > 365) {
    warnings.push(
      `想定した最大逆行(${input.maxAdverseMovePips}pips)をスワップだけで取り戻すのに` +
        `${daysOfSwapToOffsetMaxAdverse}日(約${(daysOfSwapToOffsetMaxAdverse / 365).toFixed(1)}年)かかります。` +
        "値動きのリスクに対してスワップ収入が小さすぎる可能性があります。",
    );
  }

  return {
    lots: Number(lots.toFixed(4)),
    riskAmount,
    actualLossAtMaxAdverse,
    actualRiskPercent: (actualLossAtMaxAdverse / input.accountBalance) * 100,
    dailySwap,
    monthlySwap,
    annualSwap,
    annualYieldOnBalance: (annualSwap / input.accountBalance) * 100,
    daysOfSwapToOffsetMaxAdverse,
    warnings,
  };
}

export interface OpenCarryPosition {
  id: string;
  pair: string;
  direction: "LONG" | "SHORT";
  lots: number;
  swapPerLotPerNight: number;
  entryDate: string; // ISO date (yyyy-mm-dd)
  note?: string;
}

/** 保有開始日からの経過日数（当日を含めない、単純な日数差） */
export function daysHeld(entryDateIso: string, todayIso: string): number {
  const entry = new Date(`${entryDateIso}T00:00:00Z`).getTime();
  const today = new Date(`${todayIso}T00:00:00Z`).getTime();
  return Math.max(0, Math.round((today - entry) / 86_400_000));
}

/** 保有開始からの累積スワップ（値動きは含まない、スワップ分だけ） */
export function accumulatedSwap(position: OpenCarryPosition, todayIso: string): number {
  return daysHeld(position.entryDate, todayIso) * position.lots * position.swapPerLotPerNight;
}
