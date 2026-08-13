/**
 * テクニカル指標の追加分
 *
 * `technicalAnalysis.ts` には EMA / SMA / RSI / ATR / ボリンジャー / MACD が
 * ある。ここはそれ以外——オシレーター、トレンド強度、チャネル、価格構造——を
 * 系列として返す形で揃える。
 *
 * ## 方針
 *
 * **すべて「その足まで」の情報だけで計算する。** 途中で未来の足を見ると
 * バックテストの成績が実際より良く出る。この経路は目視では気づけないので、
 * 各関数は `i` 番目の値を `candles[0..i]` だけから作る。
 *
 * 計算できない区間は `NaN` を入れる。0で埋めると「値が0」と区別がつかず、
 * ウォームアップ中の足がシグナルとして拾われる。
 */
import type { OHLC } from "./technicalAnalysis";

/** 計算できない区間を NaN で埋めた配列 */
function filled(length: number): number[] {
  return new Array<number>(length).fill(NaN);
}

const isNum = (v: number | undefined): v is number =>
  v !== undefined && Number.isFinite(v);

// ============================================================
// オシレーター
// ============================================================

export interface Stochastic {
  /** %K（0〜100） */
  k: number[];
  /** %D = %K の移動平均 */
  d: number[];
}

/**
 * ストキャスティクス。
 * 直近 `period` 本の高安レンジの中で、終値がどこにいるか。
 */
export function calculateStochastic(
  candles: OHLC[],
  period = 14,
  smoothK = 3,
  smoothD = 3,
): Stochastic {
  const rawK = filled(candles.length);

  for (let i = period - 1; i < candles.length; i++) {
    let high = -Infinity;
    let low = Infinity;
    for (let j = i - period + 1; j <= i; j++) {
      if (candles[j].high > high) high = candles[j].high;
      if (candles[j].low < low) low = candles[j].low;
    }
    const range = high - low;
    // レンジが0（全く動いていない）なら中立の50。0にすると「売られすぎ」に化ける
    rawK[i] = range === 0 ? 50 : ((candles[i].close - low) / range) * 100;
  }

  const k = smoothSeries(rawK, smoothK);
  return { k, d: smoothSeries(k, smoothD) };
}

/** NaN を挟んだ系列の単純移動平均。窓に NaN が1つでもあれば NaN */
function smoothSeries(values: number[], period: number): number[] {
  if (period <= 1) return [...values];
  const out = filled(values.length);
  for (let i = period - 1; i < values.length; i++) {
    let sum = 0;
    let ok = true;
    for (let j = i - period + 1; j <= i; j++) {
      if (!Number.isFinite(values[j])) {
        ok = false;
        break;
      }
      sum += values[j];
    }
    if (ok) out[i] = sum / period;
  }
  return out;
}

/**
 * CCI（Commodity Channel Index）。
 * 典型価格が移動平均からどれだけ離れているかを平均偏差で正規化する。
 */
export function calculateCCI(candles: OHLC[], period = 20): number[] {
  const out = filled(candles.length);
  const typical = candles.map((c) => (c.high + c.low + c.close) / 3);

  for (let i = period - 1; i < candles.length; i++) {
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) sum += typical[j];
    const mean = sum / period;

    let deviation = 0;
    for (let j = i - period + 1; j <= i; j++) deviation += Math.abs(typical[j] - mean);
    deviation /= period;

    // 0.015 は CCI の定義に含まれる定数（分布の±100に収まるよう調整されたもの）
    out[i] = deviation === 0 ? 0 : (typical[i] - mean) / (0.015 * deviation);
  }
  return out;
}

/**
 * Williams %R。0（高値圏）〜 -100（安値圏）。
 * ストキャスティクスと同じレンジ位置を見るが、符号と向きが逆。
 */
export function calculateWilliamsR(candles: OHLC[], period = 14): number[] {
  const out = filled(candles.length);
  for (let i = period - 1; i < candles.length; i++) {
    let high = -Infinity;
    let low = Infinity;
    for (let j = i - period + 1; j <= i; j++) {
      if (candles[j].high > high) high = candles[j].high;
      if (candles[j].low < low) low = candles[j].low;
    }
    const range = high - low;
    out[i] = range === 0 ? -50 : ((high - candles[i].close) / range) * -100;
  }
  return out;
}

/** ROC（変化率、%）。`period` 本前と比べてどれだけ動いたか */
export function calculateROC(closes: number[], period = 10): number[] {
  const out = filled(closes.length);
  for (let i = period; i < closes.length; i++) {
    const past = closes[i - period];
    if (past !== 0) out[i] = ((closes[i] - past) / past) * 100;
  }
  return out;
}

// ============================================================
// トレンド強度
// ============================================================

export interface ADX {
  adx: number[];
  plusDI: number[];
  minusDI: number[];
}

/**
 * ADX と方向性指数（DI）。
 *
 * ADX は「トレンドがあるか」だけを言い、方向は言わない。方向は +DI と -DI の
 * 大小で見る。Wilder の平滑を使う（単純平均ではない）。
 */
export function calculateADX(candles: OHLC[], period = 14): ADX {
  const n = candles.length;
  const adx = filled(n);
  const plusDI = filled(n);
  const minusDI = filled(n);
  if (n < period * 2) return { adx, plusDI, minusDI };

  const plusDM = new Array<number>(n).fill(0);
  const minusDM = new Array<number>(n).fill(0);
  const tr = new Array<number>(n).fill(0);

  for (let i = 1; i < n; i++) {
    const upMove = candles[i].high - candles[i - 1].high;
    const downMove = candles[i - 1].low - candles[i].low;
    // 大きいほうだけを採る。両方が正でも片方しか数えない
    plusDM[i] = upMove > downMove && upMove > 0 ? upMove : 0;
    minusDM[i] = downMove > upMove && downMove > 0 ? downMove : 0;

    const prevClose = candles[i - 1].close;
    tr[i] = Math.max(
      candles[i].high - candles[i].low,
      Math.abs(candles[i].high - prevClose),
      Math.abs(candles[i].low - prevClose),
    );
  }

  // Wilder の平滑（初回は単純合計、以降は「前回 - 前回/period + 今回」）
  let smoothTR = 0;
  let smoothPlus = 0;
  let smoothMinus = 0;
  for (let i = 1; i <= period; i++) {
    smoothTR += tr[i];
    smoothPlus += plusDM[i];
    smoothMinus += minusDM[i];
  }

  const dxSeries = filled(n);
  for (let i = period; i < n; i++) {
    if (i > period) {
      smoothTR = smoothTR - smoothTR / period + tr[i];
      smoothPlus = smoothPlus - smoothPlus / period + plusDM[i];
      smoothMinus = smoothMinus - smoothMinus / period + minusDM[i];
    }
    if (smoothTR === 0) continue;

    const pdi = (smoothPlus / smoothTR) * 100;
    const mdi = (smoothMinus / smoothTR) * 100;
    plusDI[i] = pdi;
    minusDI[i] = mdi;

    const sum = pdi + mdi;
    dxSeries[i] = sum === 0 ? 0 : (Math.abs(pdi - mdi) / sum) * 100;
  }

  // ADX は DX の Wilder 平滑
  let adxValue = 0;
  let counted = 0;
  for (let i = period; i < n; i++) {
    if (!Number.isFinite(dxSeries[i])) continue;
    counted++;
    if (counted < period) {
      adxValue += dxSeries[i];
      continue;
    }
    if (counted === period) {
      adxValue = (adxValue + dxSeries[i]) / period;
    } else {
      adxValue = (adxValue * (period - 1) + dxSeries[i]) / period;
    }
    adx[i] = adxValue;
  }

  return { adx, plusDI, minusDI };
}

/**
 * 終値に当てた回帰直線の傾き（1本あたりの価格変化）。
 *
 * 移動平均の向きより素直にトレンドの強さを表す。窓の中の位置に関わらず
 * 同じ重みで測るので、平均のラグに引きずられない。
 */
export function calculateSlope(closes: number[], period = 20): number[] {
  const out = filled(closes.length);
  // x を 0..period-1 に固定すると Σx と Σx² は定数になる
  const sumX = ((period - 1) * period) / 2;
  const sumXX = ((period - 1) * period * (2 * period - 1)) / 6;
  const denominator = period * sumXX - sumX * sumX;
  if (denominator === 0) return out;

  for (let i = period - 1; i < closes.length; i++) {
    let sumY = 0;
    let sumXY = 0;
    for (let j = 0; j < period; j++) {
      const y = closes[i - period + 1 + j];
      sumY += y;
      sumXY += j * y;
    }
    out[i] = (period * sumXY - sumX * sumY) / denominator;
  }
  return out;
}

// ============================================================
// チャネル
// ============================================================

export interface Channel {
  upper: number[];
  middle: number[];
  lower: number[];
}

/**
 * ケルトナーチャネル。EMA を中心に ATR の倍数で幅を取る。
 * ボリンジャーが標準偏差なのに対し、こちらは実際の値動きの幅を使う。
 */
export function calculateKeltner(
  candles: OHLC[],
  emaSeries: number[],
  atrSeries: number[],
  multiplier = 2,
): Channel {
  const n = candles.length;
  const upper = filled(n);
  const middle = filled(n);
  const lower = filled(n);
  for (let i = 0; i < n; i++) {
    const ema = emaSeries[i];
    const atr = atrSeries[i];
    if (!isNum(ema) || !isNum(atr)) continue;
    middle[i] = ema;
    upper[i] = ema + atr * multiplier;
    lower[i] = ema - atr * multiplier;
  }
  return { upper, middle, lower };
}

/**
 * パラボリックSAR。
 *
 * トレンド方向に沿って加速しながら追いかける点。反転したところが
 * シグナルになる。戻り値は「その足での SAR の値」と「上昇局面か」。
 */
export interface ParabolicSAR {
  sar: number[];
  /** その足の時点で上昇局面と判定しているか */
  rising: boolean[];
}

export function calculateParabolicSAR(
  candles: OHLC[],
  step = 0.02,
  maxStep = 0.2,
): ParabolicSAR {
  const n = candles.length;
  const sar = filled(n);
  const rising = new Array<boolean>(n).fill(false);
  if (n < 2) return { sar, rising };

  // 初期方向は最初の2本の関係で決める
  let up = candles[1].close >= candles[0].close;
  let acceleration = step;
  let extreme = up ? candles[1].high : candles[1].low;
  let current = up ? candles[0].low : candles[0].high;

  sar[1] = current;
  rising[1] = up;

  for (let i = 2; i < n; i++) {
    current = current + acceleration * (extreme - current);

    // SAR は直近2本のレンジの内側に入ってはいけない
    if (up) {
      current = Math.min(current, candles[i - 1].low, candles[i - 2].low);
    } else {
      current = Math.max(current, candles[i - 1].high, candles[i - 2].high);
    }

    const flipped = up ? candles[i].low < current : candles[i].high > current;
    if (flipped) {
      // 反転。SAR は直前の極値まで飛び、加速は初期値に戻す
      current = extreme;
      up = !up;
      acceleration = step;
      extreme = up ? candles[i].high : candles[i].low;
    } else if (up && candles[i].high > extreme) {
      extreme = candles[i].high;
      acceleration = Math.min(acceleration + step, maxStep);
    } else if (!up && candles[i].low < extreme) {
      extreme = candles[i].low;
      acceleration = Math.min(acceleration + step, maxStep);
    }

    sar[i] = current;
    rising[i] = up;
  }

  return { sar, rising };
}

// ============================================================
// 価格構造
// ============================================================

export interface PivotLevels {
  pivot: number[];
  r1: number[];
  s1: number[];
  r2: number[];
  s2: number[];
}

/**
 * ピボットポイント（クラシック）。
 *
 * **一つ前の足**の高安終値から出す。当日の足から出すと、その日の中では
 * まだ確定していない値を使うことになり、先読みになる。
 */
export function calculatePivots(candles: OHLC[]): PivotLevels {
  const n = candles.length;
  const pivot = filled(n);
  const r1 = filled(n);
  const s1 = filled(n);
  const r2 = filled(n);
  const s2 = filled(n);

  for (let i = 1; i < n; i++) {
    const prev = candles[i - 1];
    const p = (prev.high + prev.low + prev.close) / 3;
    const range = prev.high - prev.low;
    pivot[i] = p;
    r1[i] = 2 * p - prev.low;
    s1[i] = 2 * p - prev.high;
    r2[i] = p + range;
    s2[i] = p - range;
  }
  return { pivot, r1, s1, r2, s2 };
}

/**
 * 直近 `period` 本のうち、その足のレンジが最も狭いか（NR7 など）。
 *
 * 値動きが縮んだ後は広がりやすい、という前提のブレイクアウトに使う。
 */
export function narrowestRange(candles: OHLC[], period = 7): boolean[] {
  const out = new Array<boolean>(candles.length).fill(false);
  for (let i = period - 1; i < candles.length; i++) {
    const range = candles[i].high - candles[i].low;
    let narrowest = true;
    for (let j = i - period + 1; j < i; j++) {
      if (candles[j].high - candles[j].low <= range) {
        narrowest = false;
        break;
      }
    }
    out[i] = narrowest;
  }
  return out;
}

/**
 * ボリンジャーバンド幅の縮小（スクイーズ）。
 *
 * バンド幅が直近 `lookback` 本で最も狭ければ true。
 * 幅は中心線で割って正規化する（価格水準が変わっても比較できるように）。
 */
export function bollingerSqueeze(
  upper: number[],
  lower: number[],
  middle: number[],
  lookback = 50,
): boolean[] {
  const n = upper.length;
  const width = filled(n);
  for (let i = 0; i < n; i++) {
    if (!isNum(upper[i]) || !isNum(lower[i]) || !isNum(middle[i]) || middle[i] === 0) continue;
    width[i] = (upper[i] - lower[i]) / middle[i];
  }

  const out = new Array<boolean>(n).fill(false);
  for (let i = lookback; i < n; i++) {
    if (!Number.isFinite(width[i])) continue;
    let narrowest = true;
    for (let j = i - lookback; j < i; j++) {
      if (Number.isFinite(width[j]) && width[j] <= width[i]) {
        narrowest = false;
        break;
      }
    }
    out[i] = narrowest;
  }
  return out;
}

/**
 * きりのいい価格までの距離（pips）。
 *
 * ドル円なら 155.00 のような「00」に注文が溜まりやすい、という前提。
 * 正なら上、負なら下にある。
 */
export function distanceToRoundNumber(
  price: number,
  roundTo: number,
  pipSize: number,
): number {
  const nearest = Math.round(price / roundTo) * roundTo;
  return (nearest - price) / pipSize;
}

/**
 * 直近 `lookback` 本の値幅に対するフィボナッチ戻り。
 *
 * 上昇局面なら「高値から何%戻ったか」、下降局面なら「安値から何%戻ったか」。
 * 0 = まだ戻していない、1 = 起点まで戻った。
 */
export function retracementRatio(
  candles: OHLC[],
  i: number,
  lookback: number,
): { ratio: number; upswing: boolean } | null {
  if (i - lookback < 0) return null;
  let high = -Infinity;
  let low = Infinity;
  let highIndex = -1;
  let lowIndex = -1;
  for (let j = i - lookback; j <= i; j++) {
    if (candles[j].high > high) {
      high = candles[j].high;
      highIndex = j;
    }
    if (candles[j].low < low) {
      low = candles[j].low;
      lowIndex = j;
    }
  }
  const range = high - low;
  if (range === 0) return null;

  // 高値が後なら上昇の途中、安値が後なら下降の途中
  const upswing = highIndex > lowIndex;
  const ratio = upswing ? (high - candles[i].close) / range : (candles[i].close - low) / range;
  return { ratio, upswing };
}
