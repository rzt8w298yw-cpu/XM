/**
 * 価格の桁の取り違えを検出する
 *
 * 配布されているローソク足は、価格を「小数点以下の桁数ぶん10倍した整数」で
 * 持っていることがある（`81121` = 81.121、`130583` = 1.30583）。桁を
 * 取り違えると**値動きの形はまったく変わらず、pipの大きさだけが10倍・
 * 100倍ずれる。** チャートを見ても気づけない種類の間違い。
 *
 * 気づける唯一の手掛かりは「値幅をpipで測るといくつか」。為替の日足は
 * 数十〜数百pips、1時間足はその10分の1程度に収まる。
 *
 * 最初は1時間足と日足に同じ範囲を当てていて、**低ボラの通貨の1時間足を
 * 誤って弾いた**（EURCHFの中央値8 pipsは桁違いではなく実際の姿）。
 * 検査が正しいデータを拒む側に倒れると、使えるデータが使えなくなる。
 */

export type Timeframe = "h1" | "d1";

/** 足の長さごとの、値幅のありうる範囲（pips） */
export const RANGE_BOUNDS: Record<Timeframe, { min: number; max: number }> = {
  // 1時間足は日足のおよそ10分の1。低ボラの通貨だと中央値8 pips まで下がる
  h1: { min: 1, max: 500 },
  d1: { min: 10, max: 3000 },
};

export interface RangeRow {
  high: number;
  low: number;
}

/** 値幅の中央値をpipで返す */
export function medianRangePips(rows: RangeRow[], pipSize: number): number {
  if (rows.length === 0 || !(pipSize > 0)) return NaN;
  const ranges = rows.map((r) => (r.high - r.low) / pipSize).sort((a, b) => a - b);
  return ranges[Math.floor(ranges.length / 2)];
}

export interface ScaleCheck {
  ok: boolean;
  medianPips: number;
  bounds: { min: number; max: number };
  /** ok が false のときの理由 */
  reason: string | null;
}

export function checkScale(
  rows: RangeRow[],
  pipSize: number,
  timeframe: Timeframe,
): ScaleCheck {
  const bounds = RANGE_BOUNDS[timeframe];
  const medianPips = medianRangePips(rows, pipSize);

  if (!Number.isFinite(medianPips)) {
    return { ok: false, medianPips, bounds, reason: "値幅を計算できませんでした" };
  }
  if (medianPips < bounds.min || medianPips > bounds.max) {
    return {
      ok: false,
      medianPips,
      bounds,
      reason:
        `値幅の中央値が ${medianPips.toFixed(0)} pips です` +
        `（想定 ${bounds.min}〜${bounds.max}）。` +
        `価格の桁数の想定（1pip = ${pipSize}）が違う可能性があります`,
    };
  }
  return { ok: true, medianPips, bounds, reason: null };
}
