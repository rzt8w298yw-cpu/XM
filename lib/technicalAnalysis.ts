/**
 * テクニカル分析ライブラリ
 *
 * 配列を返す指標（EMA/RSI/ATR）は入力ローソク足と同じインデックスで揃える。
 * ウォームアップ期間に満たない先頭要素は空（undefined）のままにしてあるので、
 * 呼び出し側は `arr[i] ?? fallback` で埋められる。データ本数が足りない場合は
 * 空配列を返すので、`arr.length > 0` で利用可否を判定できる。
 */

export interface OHLC {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

export type TrendDirection = "UP" | "DOWN" | "FLAT";
export type MarketStructure = "UPTREND" | "DOWNTREND" | "RANGE";
export type ATRStatus = "low" | "normal" | "high";
export type DivergenceType = "bullish" | "bearish" | "none";
export type CandlePattern =
  | "pin_bar_bull"
  | "pin_bar_bear"
  | "engulfing_bull"
  | "engulfing_bear"
  | "morning_star"
  | "evening_star"
  | "none";
export type TimeSession = "TOKYO" | "LONDON" | "NY" | "SYDNEY" | "OFF_HOURS";
export type BBSignal =
  | "squeeze"
  | "expansion"
  | "upper_touch"
  | "lower_touch"
  | "neutral";
export type MACDSignal =
  | "golden_cross"
  | "dead_cross"
  | "bullish"
  | "bearish"
  | "neutral";

export interface SupportResistance {
  price: number;
  type: "support" | "resistance";
  /** 何回反応したか（タッチ回数）。多いほど強い */
  strength: number;
}

export interface BollingerBands {
  upper: number;
  middle: number;
  lower: number;
  /** バンド内での価格位置。0 = 下バンド, 1 = 上バンド */
  percentB: number;
  /** (upper - lower) / middle */
  bandwidth: number;
}

export interface MACDResult {
  macd: number;
  signal: number;
  histogram: number;
  histogramPrev: number;
}

// ============================================================
// 基本指標
// ============================================================

/** 指数移動平均。入力と同じ長さ・同じインデックスで返す */
export function calculateEMA(values: number[], period: number): number[] {
  if (period <= 0 || values.length < period) return [];

  const out: number[] = new Array(values.length);
  const k = 2 / (period + 1);

  let sum = 0;
  for (let i = 0; i < period; i++) sum += values[i];
  let ema = sum / period;
  out[period - 1] = ema;

  for (let i = period; i < values.length; i++) {
    ema = values[i] * k + ema * (1 - k);
    out[i] = ema;
  }
  return out;
}

/** 単純移動平均。入力と同じインデックスで返す */
export function calculateSMA(values: number[], period: number): number[] {
  if (period <= 0 || values.length < period) return [];

  const out: number[] = new Array(values.length);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

/** RSI（Wilder方式）。入力と同じインデックスで返す */
export function calculateRSI(closes: number[], period = 14): number[] {
  if (closes.length < period + 1) return [];

  const out: number[] = new Array(closes.length);
  let gainSum = 0;
  let lossSum = 0;

  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gainSum += diff;
    else lossSum -= diff;
  }

  let avgGain = gainSum / period;
  let avgLoss = lossSum / period;
  out[period] = rsiFrom(avgGain, avgLoss);

  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? -diff : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    out[i] = rsiFrom(avgGain, avgLoss);
  }
  return out;
}

function rsiFrom(avgGain: number, avgLoss: number): number {
  if (avgLoss === 0) return avgGain === 0 ? 50 : 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

/** ATR（Wilder方式）。入力と同じインデックスで返す */
export function calculateATR(candles: OHLC[], period = 14): number[] {
  if (candles.length < period + 1) return [];

  const trueRanges: number[] = new Array(candles.length);
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i];
    const prevClose = candles[i - 1].close;
    trueRanges[i] = Math.max(
      c.high - c.low,
      Math.abs(c.high - prevClose),
      Math.abs(c.low - prevClose),
    );
  }

  const out: number[] = new Array(candles.length);
  let sum = 0;
  for (let i = 1; i <= period; i++) sum += trueRanges[i];
  let atr = sum / period;
  out[period] = atr;

  for (let i = period + 1; i < candles.length; i++) {
    atr = (atr * (period - 1) + trueRanges[i]) / period;
    out[i] = atr;
  }
  return out;
}

// ============================================================
// トレンド判定
// ============================================================

/**
 * 価格とEMAの位置関係からトレンドを判定。
 * 200EMAが計算できない場合は20EMAの傾きだけで代替する。
 */
export function determineTrend(
  closes: number[],
  ema20: number[],
  ema200: number[],
): TrendDirection {
  if (closes.length === 0) return "FLAT";

  const price = closes[closes.length - 1];
  const e20 = ema20.length > 0 ? ema20[ema20.length - 1] : undefined;
  const e200 = ema200.length > 0 ? ema200[ema200.length - 1] : undefined;
  if (e20 === undefined) return "FLAT";

  const dir20 = getEMADirection(ema20, 5);

  if (e200 === undefined) {
    if (price > e20 && dir20 === "rising") return "UP";
    if (price < e20 && dir20 === "falling") return "DOWN";
    return "FLAT";
  }

  if (price > e20 && e20 > e200 && dir20 !== "falling") return "UP";
  if (price < e20 && e20 < e200 && dir20 !== "rising") return "DOWN";
  return "FLAT";
}

/** EMAの傾き。lookback本前と比べて 0.02% 以上動いていれば方向ありと見なす */
export function getEMADirection(
  ema: number[],
  lookback = 5,
): "rising" | "falling" | "neutral" {
  if (ema.length === 0) return "neutral";

  const lastIdx = ema.length - 1;
  const prevIdx = lastIdx - lookback;
  const last = ema[lastIdx];
  const prev = prevIdx >= 0 ? ema[prevIdx] : undefined;
  if (last === undefined || prev === undefined || prev === 0) return "neutral";

  const changeRatio = (last - prev) / prev;
  const threshold = 0.0002;
  if (changeRatio > threshold) return "rising";
  if (changeRatio < -threshold) return "falling";
  return "neutral";
}

/**
 * ダウ理論の高値/安値構造。
 * 直近のスイング高値・安値をそれぞれ2つ取り、切り上げ/切り下げを見る。
 */
export function analyzeMarketStructure(
  candles: OHLC[],
  swingWindow = 3,
): MarketStructure {
  const { highs, lows } = findSwings(candles, swingWindow);
  if (highs.length < 2 || lows.length < 2) return "RANGE";

  const [h1, h2] = highs.slice(-2);
  const [l1, l2] = lows.slice(-2);

  const higherHigh = h2.price > h1.price;
  const higherLow = l2.price > l1.price;
  const lowerHigh = h2.price < h1.price;
  const lowerLow = l2.price < l1.price;

  if (higherHigh && higherLow) return "UPTREND";
  if (lowerHigh && lowerLow) return "DOWNTREND";
  return "RANGE";
}

interface Swing {
  index: number;
  price: number;
}

/** 前後 window 本より高い/低い足をスイング点として抽出 */
function findSwings(
  candles: OHLC[],
  window: number,
): { highs: Swing[]; lows: Swing[] } {
  const highs: Swing[] = [];
  const lows: Swing[] = [];

  for (let i = window; i < candles.length - window; i++) {
    let isHigh = true;
    let isLow = true;
    for (let j = i - window; j <= i + window; j++) {
      if (j === i) continue;
      if (candles[j].high >= candles[i].high) isHigh = false;
      if (candles[j].low <= candles[i].low) isLow = false;
    }
    if (isHigh) highs.push({ index: i, price: candles[i].high });
    if (isLow) lows.push({ index: i, price: candles[i].low });
  }
  return { highs, lows };
}

// ============================================================
// サポート / レジスタンス
// ============================================================

/**
 * スイング点を価格帯でクラスタリングしてサポレジを抽出。
 * 反応回数(strength)の多い順に返す。
 */
export function detectSupportResistance(
  candles: OHLC[],
  swingWindow = 3,
  clusterTolerance = 0.0015,
): SupportResistance[] {
  if (candles.length === 0) return [];

  const { highs, lows } = findSwings(candles, swingWindow);
  const currentPrice = candles[candles.length - 1].close;

  const clusters: { sum: number; count: number; price: number }[] = [];
  for (const swing of [...highs, ...lows]) {
    const hit = clusters.find(
      (c) => Math.abs(c.price - swing.price) / c.price <= clusterTolerance,
    );
    if (hit) {
      hit.sum += swing.price;
      hit.count += 1;
      hit.price = hit.sum / hit.count;
    } else {
      clusters.push({ sum: swing.price, count: 1, price: swing.price });
    }
  }

  return clusters
    .map((c) => ({
      price: c.price,
      type: (c.price < currentPrice ? "support" : "resistance") as
        | "support"
        | "resistance",
      strength: c.count,
    }))
    .sort(
      (a, b) =>
        b.strength - a.strength ||
        Math.abs(a.price - currentPrice) - Math.abs(b.price - currentPrice),
    );
}

/** 現在値がサポレジ帯（許容誤差 tolerance）に入っているか */
export function isNearSupportResistance(
  price: number,
  levels: SupportResistance[],
  tolerance = 0.0015,
): { near: boolean; level: SupportResistance | null } {
  let best: SupportResistance | null = null;
  let bestDistance = Infinity;

  for (const level of levels) {
    if (level.price === 0) continue;
    const distance = Math.abs(price - level.price) / level.price;
    if (distance <= tolerance && distance < bestDistance) {
      best = level;
      bestDistance = distance;
    }
  }
  return { near: best !== null, level: best };
}

// ============================================================
// ダイバージェンス / ローソク足パターン
// ============================================================

/**
 * 直近 lookback 本の価格とRSIを前半・後半に分けて比較する。
 * 価格が安値切り下げ・RSIが切り上げ → bullish、その逆 → bearish。
 */
export function detectDivergence(
  closes: number[],
  rsi: number[],
  lookback = 20,
): DivergenceType {
  if (closes.length < lookback || rsi.length < lookback) return "none";

  const start = closes.length - lookback;
  const mid = start + Math.floor(lookback / 2);

  const firstHalf: { price: number; rsi: number }[] = [];
  const secondHalf: { price: number; rsi: number }[] = [];
  for (let i = start; i < closes.length; i++) {
    const r = rsi[i];
    if (r === undefined) continue;
    (i < mid ? firstHalf : secondHalf).push({ price: closes[i], rsi: r });
  }
  if (firstHalf.length === 0 || secondHalf.length === 0) return "none";

  const minBy = (arr: { price: number; rsi: number }[]) =>
    arr.reduce((a, b) => (b.price < a.price ? b : a));
  const maxBy = (arr: { price: number; rsi: number }[]) =>
    arr.reduce((a, b) => (b.price > a.price ? b : a));

  const lowFirst = minBy(firstHalf);
  const lowSecond = minBy(secondHalf);
  if (lowSecond.price < lowFirst.price && lowSecond.rsi > lowFirst.rsi) {
    return "bullish";
  }

  const highFirst = maxBy(firstHalf);
  const highSecond = maxBy(secondHalf);
  if (highSecond.price > highFirst.price && highSecond.rsi < highFirst.rsi) {
    return "bearish";
  }

  return "none";
}

/** 直近3本から反転パターンを検出（優先度: 明けの明星/宵の明星 > 包み足 > ピンバー） */
export function detectCandlePattern(candles: OHLC[]): CandlePattern {
  if (candles.length < 3) return "none";

  const c1 = candles[candles.length - 3];
  const c2 = candles[candles.length - 2];
  const c3 = candles[candles.length - 1];

  const body = (c: OHLC) => Math.abs(c.close - c.open);
  const range = (c: OHLC) => c.high - c.low;
  const isBull = (c: OHLC) => c.close > c.open;
  const isBear = (c: OHLC) => c.close < c.open;

  const c1Body = body(c1);
  const c2Body = body(c2);
  const c3Body = body(c3);
  const c3Range = range(c3);

  // 明けの明星 / 宵の明星: 大陰線 → 小さい足 → 大陽線（またはその逆）
  const midIsSmall = c2Body < c1Body * 0.5 && c2Body < c3Body * 0.5;
  if (midIsSmall && isBear(c1) && isBull(c3) && c3.close > (c1.open + c1.close) / 2) {
    return "morning_star";
  }
  if (midIsSmall && isBull(c1) && isBear(c3) && c3.close < (c1.open + c1.close) / 2) {
    return "evening_star";
  }

  // 包み足: 直前の実体を完全に包む
  if (isBear(c2) && isBull(c3) && c3.open <= c2.close && c3.close >= c2.open && c3Body > c2Body) {
    return "engulfing_bull";
  }
  if (isBull(c2) && isBear(c3) && c3.open >= c2.close && c3.close <= c2.open && c3Body > c2Body) {
    return "engulfing_bear";
  }

  // ピンバー: 実体が小さく、片側のヒゲが全体の2/3以上
  if (c3Range > 0 && c3Body <= c3Range * 0.34) {
    const upperWick = c3.high - Math.max(c3.open, c3.close);
    const lowerWick = Math.min(c3.open, c3.close) - c3.low;
    if (lowerWick >= c3Range * 0.66) return "pin_bar_bull";
    if (upperWick >= c3Range * 0.66) return "pin_bar_bear";
  }

  return "none";
}

// ============================================================
// フィルター系
// ============================================================

/**
 * 押し目 / 戻り目の判定。
 * トレンド方向に沿っていて、価格が20EMAから ATR 1本分以内に引きつけられている状態。
 */
export function isPullback(
  price: number,
  ema20: number,
  ema200: number,
  trend: TrendDirection,
  atr: number,
): boolean {
  if (atr <= 0) return false;
  const distance = Math.abs(price - ema20);
  const nearEMA = distance <= atr;

  if (trend === "UP") return nearEMA && price > ema200;
  if (trend === "DOWN") return nearEMA && price < ema200;
  return false;
}

/** ATRが直近平均と比べて高いか低いか */
export function getATRStatus(atrSeries: number[], currentATR: number): ATRStatus {
  const recent = atrSeries.filter((v) => typeof v === "number" && v > 0).slice(-50);
  if (recent.length < 5 || currentATR <= 0) return "normal";

  const avg = recent.reduce((a, b) => a + b, 0) / recent.length;
  if (avg === 0) return "normal";

  const ratio = currentATR / avg;
  if (ratio < 0.7) return "low";
  if (ratio > 1.5) return "high";
  return "normal";
}

export interface SpreadCheck {
  /** スプレッドを評価できたか。できない場合は判定に使ってはいけない */
  available: boolean;
  /** 許容範囲内か。available が false のときは意味を持たない */
  ok: boolean;
  /** 表示用の説明 */
  description: string;
}

/**
 * スプレッド判定。
 *
 * ローソク足からは実スプレッドを知る術がない。以前はここが常に true を返して
 * おり、条件が無条件で成立してスコアを底上げしていた。評価できないものを
 * 「満たした」と数えるのは誤りなので、実測値が渡されない限り available=false
 * を返し、呼び出し側でスコアの対象から外す。
 *
 * 実運用ではブローカーのbid/askから求めた値を渡すこと。
 */
export function checkSpread(
  spreadPips: number | null | undefined,
  maxSpreadPips: number,
): SpreadCheck {
  if (spreadPips === null || spreadPips === undefined || !Number.isFinite(spreadPips)) {
    return {
      available: false,
      ok: false,
      description: "実スプレッド未取得（判定から除外）",
    };
  }
  const ok = spreadPips <= maxSpreadPips;
  return {
    available: true,
    ok,
    description: ok
      ? `${spreadPips.toFixed(1)} pips（上限 ${maxSpreadPips}）`
      : `${spreadPips.toFixed(1)} pips — 上限 ${maxSpreadPips} を超過`,
  };
}

// ============================================================
// 時間帯
// ============================================================

/** JSTの時刻から取引セッションを判定 */
export function getTimeSessionFromTimestamp(timestamp: number): TimeSession {
  const jstHour = (new Date(timestamp).getUTCHours() + 9) % 24;

  if (jstHour >= 16 && jstHour < 21) return "LONDON";
  if (jstHour >= 21 || jstHour < 2) return "NY";
  if (jstHour >= 9 && jstHour < 15) return "TOKYO";
  if (jstHour >= 6 && jstHour < 9) return "SYDNEY";
  return "OFF_HOURS";
}

export function getCurrentTimeSession(): TimeSession {
  return getTimeSessionFromTimestamp(Date.now());
}

/** セッションごとの信頼度（%）。ロンドン・NYが最も高い */
export function getTimeSessionReliability(session: TimeSession): number {
  switch (session) {
    case "LONDON":
      return 90;
    case "NY":
      return 85;
    case "TOKYO":
      return 65;
    case "SYDNEY":
      return 45;
    default:
      return 40;
  }
}

// ============================================================
// ボリンジャーバンド
// ============================================================

export function calculateBollingerBands(
  closes: number[],
  period = 20,
  stdDevMultiplier = 2,
): BollingerBands | null {
  if (closes.length < period) return null;

  const window = closes.slice(-period);
  const middle = window.reduce((a, b) => a + b, 0) / period;
  const variance =
    window.reduce((sum, v) => sum + (v - middle) ** 2, 0) / period;
  const sd = Math.sqrt(variance);

  const upper = middle + sd * stdDevMultiplier;
  const lower = middle - sd * stdDevMultiplier;
  const price = closes[closes.length - 1];
  const width = upper - lower;

  return {
    upper,
    middle,
    lower,
    percentB: width === 0 ? 0.5 : (price - lower) / width,
    bandwidth: middle === 0 ? 0 : width / middle,
  };
}

export function analyzeBollingerBands(
  closes: number[],
  period = 20,
): { signal: BBSignal; description: string } {
  const bb = calculateBollingerBands(closes, period);
  if (!bb) return { signal: "neutral", description: "データ不足" };

  // 帯幅の履歴からスクイーズ/エクスパンションを判定
  const bandwidths: number[] = [];
  for (let i = period; i <= closes.length; i++) {
    const slice = calculateBollingerBands(closes.slice(0, i), period);
    if (slice) bandwidths.push(slice.bandwidth);
  }
  const recent = bandwidths.slice(-50);
  const avgBandwidth =
    recent.length > 0 ? recent.reduce((a, b) => a + b, 0) / recent.length : bb.bandwidth;

  if (bb.percentB >= 0.95) {
    return { signal: "upper_touch", description: "上バンドタッチ（過熱）" };
  }
  if (bb.percentB <= 0.05) {
    return { signal: "lower_touch", description: "下バンドタッチ（過売り）" };
  }
  if (avgBandwidth > 0 && bb.bandwidth < avgBandwidth * 0.7) {
    return { signal: "squeeze", description: "スクイーズ（ブレイク待ち）" };
  }
  if (avgBandwidth > 0 && bb.bandwidth > avgBandwidth * 1.3) {
    return { signal: "expansion", description: "エクスパンション（トレンド拡大）" };
  }
  return { signal: "neutral", description: "バンド内で推移" };
}

// ============================================================
// MACD
// ============================================================

export function calculateMACD(
  closes: number[],
  fastPeriod = 12,
  slowPeriod = 26,
  signalPeriod = 9,
): MACDResult | null {
  if (closes.length < slowPeriod + signalPeriod) return null;

  const emaFast = calculateEMA(closes, fastPeriod);
  const emaSlow = calculateEMA(closes, slowPeriod);
  if (emaFast.length === 0 || emaSlow.length === 0) return null;

  // MACDライン（slowEMAが立ち上がるインデックス以降のみ）
  const macdLine: number[] = [];
  for (let i = slowPeriod - 1; i < closes.length; i++) {
    const f = emaFast[i];
    const s = emaSlow[i];
    if (f === undefined || s === undefined) continue;
    macdLine.push(f - s);
  }
  if (macdLine.length < signalPeriod + 1) return null;

  const signalLine = calculateEMA(macdLine, signalPeriod);
  if (signalLine.length === 0) return null;

  const lastIdx = macdLine.length - 1;
  const macd = macdLine[lastIdx];
  const signal = signalLine[lastIdx];
  const macdPrev = macdLine[lastIdx - 1];
  const signalPrev = signalLine[lastIdx - 1];
  if (signal === undefined || signalPrev === undefined) return null;

  return {
    macd,
    signal,
    histogram: macd - signal,
    histogramPrev: macdPrev - signalPrev,
  };
}

export function analyzeMACDSignal(
  closes: number[],
): { signal: MACDSignal; description: string } {
  const macd = calculateMACD(closes);
  if (!macd) return { signal: "neutral", description: "データ不足" };

  if (macd.histogramPrev <= 0 && macd.histogram > 0) {
    return { signal: "golden_cross", description: "ゴールデンクロス" };
  }
  if (macd.histogramPrev >= 0 && macd.histogram < 0) {
    return { signal: "dead_cross", description: "デッドクロス" };
  }
  if (macd.histogram > 0) {
    return {
      signal: "bullish",
      description: macd.histogram > macd.histogramPrev ? "上昇モメンタム加速" : "上昇モメンタム減速",
    };
  }
  if (macd.histogram < 0) {
    return {
      signal: "bearish",
      description: macd.histogram < macd.histogramPrev ? "下降モメンタム加速" : "下降モメンタム減速",
    };
  }
  return { signal: "neutral", description: "中立" };
}

/** ボリンジャーバンドとMACDを組み合わせた方向性の目安 */
export function analyzeBBMACDCombo(closes: number[]): {
  direction: "BUY" | "SELL" | "NEUTRAL";
  confidence: number;
  reason: string;
} {
  const bb = calculateBollingerBands(closes);
  const macd = calculateMACD(closes);
  if (!bb || !macd) {
    return { direction: "NEUTRAL", confidence: 0, reason: "データ不足" };
  }

  const reasons: string[] = [];
  let score = 0;

  if (macd.histogram > 0) {
    score += macd.histogram > macd.histogramPrev ? 2 : 1;
    reasons.push("MACDヒストグラムがプラス圏");
  } else if (macd.histogram < 0) {
    score -= macd.histogram < macd.histogramPrev ? 2 : 1;
    reasons.push("MACDヒストグラムがマイナス圏");
  }

  if (bb.percentB >= 0.95) {
    score -= 1;
    reasons.push("上バンド到達で過熱感");
  } else if (bb.percentB <= 0.05) {
    score += 1;
    reasons.push("下バンド到達で反発余地");
  } else if (bb.percentB > 0.5) {
    score += 1;
    reasons.push("バンド上半分で推移");
  } else {
    score -= 1;
    reasons.push("バンド下半分で推移");
  }

  const direction = score >= 2 ? "BUY" : score <= -2 ? "SELL" : "NEUTRAL";
  const confidence = Math.min(Math.round((Math.abs(score) / 3) * 100), 100);
  return { direction, confidence, reason: reasons.join(" / ") };
}
