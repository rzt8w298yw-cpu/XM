/**
 * 広く試すためのエントリールール一式
 *
 * `hypotheses.ts` の15件では足りないので、テクニカル分析の主要な流派を
 * ひと通り並べる。順張り、逆張り、ブレイクアウト、プライスアクション、
 * 価格構造、時間——それぞれの代表的な形。
 *
 * ## 目新しさは狙わない
 *
 * ここに並ぶのはどれも教科書に載っている形で、独自の工夫は入れていない。
 * **目新しさは検証の役に立たない。** 珍しいルールほど、たまたま当たった
 * 場合にそれを疑う根拠が無くなる。よく知られた形なら、他人の検証結果と
 * 突き合わせられる。
 *
 * ## フィルターを分けてある
 *
 * 「押し目買い」と「上昇トレンド中の押し目買い」は別のルールではなく、
 * 同じルターに条件を掛けたものとして扱う。こうすると
 * ルール数 × フィルター数の組み合わせを機械的に試せる。
 *
 * ただし**組み合わせを増やすほど、偶然に当たるものが出やすくなる。**
 * 試行回数は必ず数えて、結果と一緒に出すこと。
 */
import {
  bollingerSqueeze,
  calculateADX,
  calculateCCI,
  calculateKeltner,
  calculateParabolicSAR,
  calculatePivots,
  calculateROC,
  calculateSlope,
  calculateStochastic,
  calculateWilliamsR,
  distanceToRoundNumber,
  narrowestRange,
  retracementRatio,
} from "./indicators";
import {
  calculateATR,
  calculateEMA,
  calculateRSI,
  calculateSMA,
  type OHLC,
} from "./technicalAnalysis";

export type Direction = "BUY" | "SELL";

/** ルールが参照できるものすべて。1回だけ作って使い回す */
export interface WideContext {
  candles: OHLC[];
  i: number;
  pipSize: number;

  atr: number[];
  atrAverage: number[];

  ema20: number[];
  ema50: number[];
  ema200: number[];
  sma20: number[];
  sd20: number[];

  rsi2: number[];
  rsi7: number[];
  rsi14: number[];

  bbUpper: number[];
  bbLower: number[];
  bbMiddle: number[];
  percentB: number[];
  squeeze: boolean[];

  macd: number[];
  macdSignal: number[];
  macdHist: number[];

  stochK: number[];
  stochD: number[];
  cci: number[];
  williamsR: number[];
  roc: number[];

  adx: number[];
  plusDI: number[];
  minusDI: number[];
  slope20: number[];

  keltnerUpper: number[];
  keltnerLower: number[];

  sarRising: boolean[];

  pivot: number[];
  r1: number[];
  s1: number[];

  nr7: boolean[];

  hourUtc: number[];
  dayOfWeek: number[];
  dayOfMonth: number[];
}

const ok = (v: number | undefined): v is number => v !== undefined && Number.isFinite(v);

/** 標準偏差の系列（ボリンジャーと z スコアで使う） */
function rollingSd(values: number[], period: number, means: number[]): number[] {
  const out = new Array<number>(values.length).fill(NaN);
  for (let i = period - 1; i < values.length; i++) {
    const mean = means[i];
    if (!ok(mean)) continue;
    let variance = 0;
    for (let j = i - period + 1; j <= i; j++) variance += (values[j] - mean) ** 2;
    out[i] = Math.sqrt(variance / period);
  }
  return out;
}

/** MACD を系列として組む（既存の実装は最新値しか返さないため） */
function macdSeries(closes: number[]): {
  macd: number[];
  signal: number[];
  histogram: number[];
} {
  const fast = calculateEMA(closes, 12);
  const slow = calculateEMA(closes, 26);
  const macd = closes.map((_, i) => (ok(fast[i]) && ok(slow[i]) ? fast[i] - slow[i] : NaN));

  // シグナルは MACD の EMA。NaN 区間を挟むと EMA が壊れるので、
  // 値が揃ったところから別配列で計算して元の位置に戻す
  const firstValid = macd.findIndex((v) => Number.isFinite(v));
  const signal = new Array<number>(closes.length).fill(NaN);
  if (firstValid !== -1) {
    const signalPart = calculateEMA(macd.slice(firstValid), 9);
    for (let i = 0; i < signalPart.length; i++) signal[firstValid + i] = signalPart[i];
  }

  const histogram = macd.map((v, i) => (ok(v) && ok(signal[i]) ? v - signal[i] : NaN));
  return { macd, signal, histogram };
}

export function buildWideContext(candles: OHLC[], pipSize: number): WideContext {
  const closes = candles.map((c) => c.close);
  const atr = calculateATR(candles, 14);
  const ema20 = calculateEMA(closes, 20);
  const sma20 = calculateSMA(closes, 20);
  const sd20 = rollingSd(closes, 20, sma20);

  const bbUpper = sma20.map((m, i) => (ok(m) && ok(sd20[i]) ? m + 2 * sd20[i] : NaN));
  const bbLower = sma20.map((m, i) => (ok(m) && ok(sd20[i]) ? m - 2 * sd20[i] : NaN));
  const percentB = closes.map((c, i) => {
    const width = bbUpper[i] - bbLower[i];
    return ok(width) && width !== 0 ? (c - bbLower[i]) / width : NaN;
  });

  const { macd, signal, histogram } = macdSeries(closes);
  const { k, d } = calculateStochastic(candles, 14, 3, 3);
  const { adx, plusDI, minusDI } = calculateADX(candles, 14);
  const keltner = calculateKeltner(candles, ema20, atr, 2);
  const { rising } = calculateParabolicSAR(candles);
  const pivots = calculatePivots(candles);

  return {
    candles,
    i: 0,
    pipSize,
    atr,
    atrAverage: calculateSMA(atr, 50),
    ema20,
    ema50: calculateEMA(closes, 50),
    ema200: calculateEMA(closes, 200),
    sma20,
    sd20,
    rsi2: calculateRSI(closes, 2),
    rsi7: calculateRSI(closes, 7),
    rsi14: calculateRSI(closes, 14),
    bbUpper,
    bbLower,
    bbMiddle: sma20,
    percentB,
    squeeze: bollingerSqueeze(bbUpper, bbLower, sma20, 50),
    macd,
    macdSignal: signal,
    macdHist: histogram,
    stochK: k,
    stochD: d,
    cci: calculateCCI(candles, 20),
    williamsR: calculateWilliamsR(candles, 14),
    roc: calculateROC(closes, 10),
    adx,
    plusDI,
    minusDI,
    slope20: calculateSlope(closes, 20),
    keltnerUpper: keltner.upper,
    keltnerLower: keltner.lower,
    sarRising: rising,
    pivot: pivots.pivot,
    r1: pivots.r1,
    s1: pivots.s1,
    nr7: narrowestRange(candles, 7),
    hourUtc: candles.map((c) => new Date(c.timestamp).getUTCHours()),
    dayOfWeek: candles.map((c) => new Date(c.timestamp).getUTCDay()),
    dayOfMonth: candles.map((c) => new Date(c.timestamp).getUTCDate()),
  };
}

export interface WideRule {
  id: string;
  /** 何を狙っているか。結果を読むときに要る */
  idea: string;
  family: "trend" | "reversion" | "breakout" | "priceAction" | "structure" | "time";
  decide(ctx: WideContext): Direction | null;
}

/** 直近 lookback 本の高安（当該足を含まない） */
function priorRange(candles: OHLC[], i: number, lookback: number) {
  if (i - lookback < 0) return null;
  let high = -Infinity;
  let low = Infinity;
  for (let j = i - lookback; j < i; j++) {
    if (candles[j].high > high) high = candles[j].high;
    if (candles[j].low < low) low = candles[j].low;
  }
  return { high, low };
}

/** 系列が閾値を上抜けたか（前の足は下、今の足は上） */
function crossedUp(series: number[], i: number, level: number): boolean {
  return ok(series[i - 1]) && ok(series[i]) && series[i - 1] <= level && series[i] > level;
}

function crossedDown(series: number[], i: number, level: number): boolean {
  return ok(series[i - 1]) && ok(series[i]) && series[i - 1] >= level && series[i] < level;
}

/** 系列Aが系列Bを上抜けたか */
function crossedOver(a: number[], b: number[], i: number): boolean {
  return (
    ok(a[i - 1]) && ok(b[i - 1]) && ok(a[i]) && ok(b[i]) && a[i - 1] <= b[i - 1] && a[i] > b[i]
  );
}

function crossedUnder(a: number[], b: number[], i: number): boolean {
  return (
    ok(a[i - 1]) && ok(b[i - 1]) && ok(a[i]) && ok(b[i]) && a[i - 1] >= b[i - 1] && a[i] < b[i]
  );
}

// ============================================================
// 順張り
// ============================================================

const macdCross: WideRule = {
  id: "macd_cross",
  idea: "MACDがシグナル線を抜けた方向に付く",
  family: "trend",
  decide: ({ macd, macdSignal, i }) => {
    if (crossedOver(macd, macdSignal, i)) return "BUY";
    if (crossedUnder(macd, macdSignal, i)) return "SELL";
    return null;
  },
};

const macdZero: WideRule = {
  id: "macd_zero",
  idea: "MACDが0を抜けた＝短期と長期の平均が入れ替わった",
  family: "trend",
  decide: ({ macd, i }) => {
    if (crossedUp(macd, i, 0)) return "BUY";
    if (crossedDown(macd, i, 0)) return "SELL";
    return null;
  },
};

const adxDiCross: WideRule = {
  id: "adx_di_cross",
  idea: "トレンドが出ている（ADX>25）ときのDIのクロス",
  family: "trend",
  decide: ({ adx, plusDI, minusDI, i }) => {
    if (!ok(adx[i]) || adx[i] < 25) return null;
    if (crossedOver(plusDI, minusDI, i)) return "BUY";
    if (crossedUnder(plusDI, minusDI, i)) return "SELL";
    return null;
  },
};

const sarFlip: WideRule = {
  id: "sar_flip",
  idea: "パラボリックSARが反転した方向に付く",
  family: "trend",
  decide: ({ sarRising, i }) => {
    if (i < 1) return null;
    if (!sarRising[i - 1] && sarRising[i]) return "BUY";
    if (sarRising[i - 1] && !sarRising[i]) return "SELL";
    return null;
  },
};

const slopeTurn: WideRule = {
  id: "slope_turn",
  idea: "回帰直線の傾きが符号を変えた＝トレンドの向きが変わった",
  family: "trend",
  decide: ({ slope20, i }) => {
    if (crossedUp(slope20, i, 0)) return "BUY";
    if (crossedDown(slope20, i, 0)) return "SELL";
    return null;
  },
};

const rocThreshold: WideRule = {
  id: "roc_threshold",
  idea: "10本前からの変化率が一定を超えた方向に付く",
  family: "trend",
  decide: ({ roc, i }) => {
    if (crossedUp(roc, i, 0.5)) return "BUY";
    if (crossedDown(roc, i, -0.5)) return "SELL";
    return null;
  },
};

const emaStack: WideRule = {
  id: "ema_stack",
  idea: "EMAが順に並んだ状態で、短期に押したところ",
  family: "trend",
  decide: ({ ema20, ema50, ema200, candles, i }) => {
    if (!ok(ema20[i]) || !ok(ema50[i]) || !ok(ema200[i])) return null;
    const close = candles[i].close;
    if (ema20[i] > ema50[i] && ema50[i] > ema200[i] && candles[i].low <= ema20[i] && close > ema20[i]) {
      return "BUY";
    }
    if (ema20[i] < ema50[i] && ema50[i] < ema200[i] && candles[i].high >= ema20[i] && close < ema20[i]) {
      return "SELL";
    }
    return null;
  },
};

// ============================================================
// 逆張り
// ============================================================

const stochReversion: WideRule = {
  id: "stoch_reversion",
  idea: "ストキャスが売られすぎ/買われすぎから戻り始めたところ",
  family: "reversion",
  decide: ({ stochK, i }) => {
    if (crossedUp(stochK, i, 20)) return "BUY";
    if (crossedDown(stochK, i, 80)) return "SELL";
    return null;
  },
};

const stochCross: WideRule = {
  id: "stoch_cross",
  idea: "極端な水準での %K と %D のクロス",
  family: "reversion",
  decide: ({ stochK, stochD, i }) => {
    if (!ok(stochK[i])) return null;
    if (stochK[i] < 30 && crossedOver(stochK, stochD, i)) return "BUY";
    if (stochK[i] > 70 && crossedUnder(stochK, stochD, i)) return "SELL";
    return null;
  },
};

const cciReversion: WideRule = {
  id: "cci_reversion",
  idea: "CCIが±100の外から内に戻ったところ",
  family: "reversion",
  decide: ({ cci, i }) => {
    if (crossedUp(cci, i, -100)) return "BUY";
    if (crossedDown(cci, i, 100)) return "SELL";
    return null;
  },
};

const williamsReversion: WideRule = {
  id: "williams_reversion",
  idea: "Williams %R が -80 / -20 を抜けたところ",
  family: "reversion",
  decide: ({ williamsR, i }) => {
    if (crossedUp(williamsR, i, -80)) return "BUY";
    if (crossedDown(williamsR, i, -20)) return "SELL";
    return null;
  },
};

const keltnerReversion: WideRule = {
  id: "keltner_reversion",
  idea: "ケルトナーチャネルの外で終えたら戻りを狙う",
  family: "reversion",
  decide: ({ candles, keltnerUpper, keltnerLower, i }) => {
    const close = candles[i].close;
    if (ok(keltnerLower[i]) && close < keltnerLower[i]) return "BUY";
    if (ok(keltnerUpper[i]) && close > keltnerUpper[i]) return "SELL";
    return null;
  },
};

const zScoreReversion: WideRule = {
  id: "zscore_reversion",
  idea: "移動平均から標準偏差2つ以上離れたら戻りを狙う",
  family: "reversion",
  decide: ({ candles, sma20, sd20, i }) => {
    if (!ok(sma20[i]) || !ok(sd20[i]) || sd20[i] === 0) return null;
    const z = (candles[i].close - sma20[i]) / sd20[i];
    if (z < -2) return "BUY";
    if (z > 2) return "SELL";
    return null;
  },
};

const rsi7Reversion: WideRule = {
  id: "rsi7_reversion",
  idea: "短期RSIの行き過ぎ（14本より反応が速い）",
  family: "reversion",
  decide: ({ rsi7, i }) => {
    if (crossedUp(rsi7, i, 30)) return "BUY";
    if (crossedDown(rsi7, i, 70)) return "SELL";
    return null;
  },
};

const roundNumberFade: WideRule = {
  id: "round_number_fade",
  idea: "きりのいい価格に届いたら跳ね返りを狙う（注文が溜まりやすい）",
  family: "reversion",
  decide: ({ candles, i, pipSize }) => {
    const close = candles[i].close;
    // 1.00（ドル円なら155.00のような水準）までの距離
    const distance = distanceToRoundNumber(close, 1, pipSize);
    if (Math.abs(distance) > 10) return null;
    // 上から接近＝上値が重いとみて売り、下から接近＝買い
    if (distance < 0 && candles[i].high > close) return "BUY";
    if (distance > 0 && candles[i].low < close) return "SELL";
    return null;
  },
};

// ============================================================
// ブレイクアウト
// ============================================================

const squeezeBreakout: WideRule = {
  id: "squeeze_breakout",
  idea: "バンド幅が縮んだ直後の抜けに付く",
  family: "breakout",
  decide: ({ squeeze, candles, bbUpper, bbLower, i }) => {
    if (i < 1 || !squeeze[i - 1]) return null;
    if (ok(bbUpper[i]) && candles[i].close > bbUpper[i]) return "BUY";
    if (ok(bbLower[i]) && candles[i].close < bbLower[i]) return "SELL";
    return null;
  },
};

const nr7Breakout: WideRule = {
  id: "nr7_breakout",
  idea: "直近7本で最も狭い足の翌足で、その高安を抜けた方向",
  family: "breakout",
  decide: ({ nr7, candles, i }) => {
    if (i < 1 || !nr7[i - 1]) return null;
    if (candles[i].close > candles[i - 1].high) return "BUY";
    if (candles[i].close < candles[i - 1].low) return "SELL";
    return null;
  },
};

const pivotBreak: WideRule = {
  id: "pivot_break",
  idea: "ピボットのR1/S1を抜けた方向",
  family: "breakout",
  decide: ({ candles, r1, s1, i }) => {
    if (i < 1) return null;
    const close = candles[i].close;
    if (ok(r1[i]) && candles[i - 1].close <= r1[i] && close > r1[i]) return "BUY";
    if (ok(s1[i]) && candles[i - 1].close >= s1[i] && close < s1[i]) return "SELL";
    return null;
  },
};

const atrExpansion: WideRule = {
  id: "atr_expansion",
  idea: "値幅が平常の2倍に広がった方向に付く",
  family: "breakout",
  decide: ({ candles, atr, i }) => {
    if (!ok(atr[i]) || atr[i] <= 0) return null;
    const range = candles[i].high - candles[i].low;
    if (range < atr[i] * 2) return null;
    const body = candles[i].close - candles[i].open;
    if (body > 0) return "BUY";
    if (body < 0) return "SELL";
    return null;
  },
};

const donchian10: WideRule = {
  id: "donchian10",
  idea: "直近10本の高安を更新した方向",
  family: "breakout",
  decide: ({ candles, i }) => {
    const range = priorRange(candles, i, 10);
    if (!range) return null;
    if (candles[i].close > range.high) return "BUY";
    if (candles[i].close < range.low) return "SELL";
    return null;
  },
};

const donchianFade: WideRule = {
  id: "donchian_fade",
  idea: "20本の高安を更新したら、逆に戻りを狙う（ブレイクの騙し）",
  family: "breakout",
  decide: ({ candles, i }) => {
    const range = priorRange(candles, i, 20);
    if (!range) return null;
    if (candles[i].close > range.high) return "SELL";
    if (candles[i].close < range.low) return "BUY";
    return null;
  },
};

// ============================================================
// プライスアクション
// ============================================================

const engulfing: WideRule = {
  id: "engulfing",
  idea: "前の足を包む足が出た方向",
  family: "priceAction",
  decide: ({ candles, i }) => {
    if (i < 1) return null;
    const prev = candles[i - 1];
    const cur = candles[i];
    const prevDown = prev.close < prev.open;
    const prevUp = prev.close > prev.open;
    const curUp = cur.close > cur.open;
    const curDown = cur.close < cur.open;
    // 実体が前の足の実体を完全に含む
    if (prevDown && curUp && cur.open <= prev.close && cur.close >= prev.open) return "BUY";
    if (prevUp && curDown && cur.open >= prev.close && cur.close <= prev.open) return "SELL";
    return null;
  },
};

const pinBar: WideRule = {
  id: "pin_bar",
  idea: "長いヒゲが出た側と逆に付く（そちらは跳ね返された）",
  family: "priceAction",
  decide: ({ candles, i }) => {
    const c = candles[i];
    const range = c.high - c.low;
    if (range === 0) return null;
    const body = Math.abs(c.close - c.open);
    if (body > range * 0.35) return null;
    const upperWick = c.high - Math.max(c.open, c.close);
    const lowerWick = Math.min(c.open, c.close) - c.low;
    if (lowerWick > range * 0.6) return "BUY";
    if (upperWick > range * 0.6) return "SELL";
    return null;
  },
};

const threeBarReversal: WideRule = {
  id: "three_bar_reversal",
  idea: "3本続けて同方向に進んだ後の反転",
  family: "priceAction",
  decide: ({ candles, i }) => {
    if (i < 3) return null;
    const down = [1, 2, 3].every((k) => candles[i - k].close < candles[i - k].open);
    const up = [1, 2, 3].every((k) => candles[i - k].close > candles[i - k].open);
    const cur = candles[i];
    if (down && cur.close > cur.open) return "BUY";
    if (up && cur.close < cur.open) return "SELL";
    return null;
  },
};

const outsideBar: WideRule = {
  id: "outside_bar",
  idea: "前の足の高安を両方超えた足の終値方向",
  family: "priceAction",
  decide: ({ candles, i }) => {
    if (i < 1) return null;
    const prev = candles[i - 1];
    const cur = candles[i];
    if (!(cur.high > prev.high && cur.low < prev.low)) return null;
    if (cur.close > cur.open) return "BUY";
    if (cur.close < cur.open) return "SELL";
    return null;
  },
};

const gapFade: WideRule = {
  id: "gap_fade",
  idea: "窓を開けて始まったら、埋める方向に付く",
  family: "priceAction",
  decide: ({ candles, atr, i }) => {
    if (i < 1 || !ok(atr[i]) || atr[i] <= 0) return null;
    const gap = candles[i].open - candles[i - 1].close;
    if (Math.abs(gap) < atr[i] * 0.5) return null;
    return gap > 0 ? "SELL" : "BUY";
  },
};

// ============================================================
// 価格構造
// ============================================================

const fibRetrace: WideRule = {
  id: "fib_retrace",
  idea: "直近の値幅を38.2〜61.8%戻したところで、元の方向に付く",
  family: "structure",
  decide: ({ candles, i }) => {
    const result = retracementRatio(candles, i, 50);
    if (!result) return null;
    if (result.ratio < 0.382 || result.ratio > 0.618) return null;
    return result.upswing ? "BUY" : "SELL";
  },
};

const fibFade: WideRule = {
  id: "fib_fade",
  idea: "深く戻した（61.8%超）ら、戻りの方向が本流とみて付く",
  family: "structure",
  decide: ({ candles, i }) => {
    const result = retracementRatio(candles, i, 50);
    if (!result) return null;
    if (result.ratio < 0.786) return null;
    return result.upswing ? "SELL" : "BUY";
  },
};

const bbMiddleCross: WideRule = {
  id: "bb_middle_cross",
  idea: "終値がバンド中心線を抜けた方向",
  family: "structure",
  decide: ({ candles, bbMiddle, i }) => {
    if (i < 1 || !ok(bbMiddle[i]) || !ok(bbMiddle[i - 1])) return null;
    if (candles[i - 1].close <= bbMiddle[i - 1] && candles[i].close > bbMiddle[i]) return "BUY";
    if (candles[i - 1].close >= bbMiddle[i - 1] && candles[i].close < bbMiddle[i]) return "SELL";
    return null;
  },
};

// ============================================================
// 時間
// ============================================================

const weekdayEffect: WideRule = {
  id: "weekday_monday_buy",
  idea: "週明けは前週の流れが続く、という言い伝えを確かめる",
  family: "time",
  decide: ({ dayOfWeek, candles, i }) => {
    if (dayOfWeek[i] !== 1) return null;
    if (i < 1) return null;
    return candles[i - 1].close > candles[i - 1].open ? "BUY" : "SELL";
  },
};

const hourOpenMomentum: WideRule = {
  id: "hour_open_momentum",
  idea: "ロンドン開始（UTC7時）の1本目の方向に付く",
  family: "time",
  decide: ({ hourUtc, candles, i }) => {
    if (hourUtc[i] !== 7) return null;
    const body = candles[i].close - candles[i].open;
    if (body > 0) return "BUY";
    if (body < 0) return "SELL";
    return null;
  },
};

const nyOpenFade: WideRule = {
  id: "ny_open_fade",
  idea: "NY開始（UTC13時）の動きに逆らう",
  family: "time",
  decide: ({ hourUtc, candles, i }) => {
    if (hourUtc[i] !== 13) return null;
    const body = candles[i].close - candles[i].open;
    if (body > 0) return "SELL";
    if (body < 0) return "BUY";
    return null;
  },
};

const monthStartReversal: WideRule = {
  id: "month_start_reversal",
  idea: "月初は前月の流れが反転する（実需のフローが一巡する）",
  family: "time",
  decide: ({ dayOfMonth, candles, i }) => {
    if (i < 1) return null;
    // 前の足より日付が小さくなった＝月が変わった
    if (dayOfMonth[i] >= dayOfMonth[i - 1]) return null;
    return candles[i - 1].close > candles[i - 1].open ? "SELL" : "BUY";
  },
};

export const WIDE_RULES: WideRule[] = [
  macdCross,
  macdZero,
  adxDiCross,
  sarFlip,
  slopeTurn,
  rocThreshold,
  emaStack,
  stochReversion,
  stochCross,
  cciReversion,
  williamsReversion,
  keltnerReversion,
  zScoreReversion,
  rsi7Reversion,
  roundNumberFade,
  squeezeBreakout,
  nr7Breakout,
  pivotBreak,
  atrExpansion,
  donchian10,
  donchianFade,
  engulfing,
  pinBar,
  threeBarReversal,
  outsideBar,
  gapFade,
  fibRetrace,
  fibFade,
  bbMiddleCross,
  weekdayEffect,
  hourOpenMomentum,
  nyOpenFade,
  monthStartReversal,
];

// ============================================================
// フィルター
// ============================================================

/**
 * エントリーに掛ける条件。
 *
 * 「押し目買い」と「上昇トレンド中の押し目買い」を別のルールとして書くと、
 * 同じ条件を何度も書き写すことになる。掛け合わせにしておけば機械的に
 * 全組み合わせを試せる——ただし試行回数はその分だけ増える。
 */
export interface RuleFilter {
  id: string;
  idea: string;
  allows(ctx: WideContext, direction: Direction): boolean;
}

export const FILTERS: RuleFilter[] = [
  {
    id: "none",
    idea: "条件なし",
    allows: () => true,
  },
  {
    id: "with_trend",
    idea: "EMA200 の側にだけ入る",
    allows: ({ candles, ema200, i }, direction) => {
      if (!ok(ema200[i])) return false;
      return direction === "BUY" ? candles[i].close > ema200[i] : candles[i].close < ema200[i];
    },
  },
  {
    id: "against_trend",
    idea: "EMA200 と逆側にだけ入る",
    allows: ({ candles, ema200, i }, direction) => {
      if (!ok(ema200[i])) return false;
      return direction === "BUY" ? candles[i].close < ema200[i] : candles[i].close > ema200[i];
    },
  },
  {
    id: "adx_trending",
    idea: "トレンドが出ているとき（ADX > 25）だけ",
    allows: ({ adx, i }) => ok(adx[i]) && adx[i] > 25,
  },
  {
    id: "adx_ranging",
    idea: "トレンドが無いとき（ADX < 20）だけ",
    allows: ({ adx, i }) => ok(adx[i]) && adx[i] < 20,
  },
  {
    id: "high_volatility",
    idea: "値動きが平常より大きいとき（ATR > 平均）",
    allows: ({ atr, atrAverage, i }) => ok(atr[i]) && ok(atrAverage[i]) && atr[i] > atrAverage[i],
  },
  {
    id: "low_volatility",
    idea: "値動きが平常より小さいとき（ATR < 平均）",
    allows: ({ atr, atrAverage, i }) => ok(atr[i]) && ok(atrAverage[i]) && atr[i] < atrAverage[i],
  },
  {
    id: "london_ny",
    idea: "ロンドン・NY時間だけ（UTC 7〜20時）",
    allows: ({ hourUtc, i }) => hourUtc[i] >= 7 && hourUtc[i] < 21,
  },
  {
    id: "tokyo",
    idea: "東京時間だけ（UTC 0〜7時）",
    allows: ({ hourUtc, i }) => hourUtc[i] < 7,
  },
];

/** ルールとフィルターを合わせて走査する */
export function scanWideRule(
  rule: WideRule,
  filter: RuleFilter,
  ctx: WideContext,
  fromIndex: number,
  toIndex: number,
): { hits: { index: number; direction: Direction; atr: number; confidence: number }[]; barsEvaluated: number } {
  const hits: { index: number; direction: Direction; atr: number; confidence: number }[] = [];
  let barsEvaluated = 0;

  /*
   * `i` は複製せずに書き換える。
   *
   * 素直に書くなら足ごとに `{ ...ctx, i }` を作るところだが、この探索は
   * 30以上のルール × 9つのフィルター × 2つの足で走査を繰り返すので、
   * 5万本の足に対して数千万回の複製になる。ctx が持つのは配列への参照
   * だけで、ルールもフィルターも読むだけなので、位置を書き換えて渡す。
   */
  const scoped = ctx;

  // 指標のウォームアップが済むところから。EMA200 が要るので250本
  for (let i = Math.max(fromIndex, 250); i < Math.min(toIndex, ctx.candles.length - 1); i++) {
    const atr = ctx.atr[i];
    if (!ok(atr) || atr <= 0) continue;
    barsEvaluated++;

    scoped.i = i;
    const direction = rule.decide(scoped);
    if (direction === null) continue;
    if (!filter.allows(scoped, direction)) continue;

    hits.push({ index: i, direction, atr, confidence: 50 });
  }

  return { hits, barsEvaluated };
}
