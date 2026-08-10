/**
 * エントリー仮説
 *
 * 既存の15条件は実データでランダムエントリーと区別がつかなかった。そこで
 * 条件の閾値をいじるのではなく、**入り方の発想そのもの**を差し替えて、
 * 同じ土俵（同じ値動き・同じコスト・同じ決済条件）で比べられるようにする。
 *
 * 各ルールは「その足までの情報だけ」で向きを決める。指標の系列は事前に
 * 全体を計算するが、いずれも左から右に積む因果的な計算なので、
 * `series[i]` は `closes[0..i]` しか使っていない。
 *
 * 重要: ここにルールを足すこと自体は改善ではない。試した数だけ、偶然
 * 良く見えるものが出る。判断は `scripts/hypothesis.ts` の手順（学習期間と
 * 検証期間の分離 + 2種類の対照実験）に従うこと。
 */
import {
  calculateATR,
  calculateEMA,
  calculateRSI,
  getTimeSessionFromTimestamp,
  type OHLC,
} from "./technicalAnalysis";

export type Direction = "BUY" | "SELL";

/** ルールが参照してよい、事前計算済みの系列 */
export interface RuleContext {
  candles: OHLC[];
  /** 判定対象の足 */
  i: number;
  atr: number[];
  ema20: number[];
  ema50: number[];
  ema200: number[];
  rsi: number[];
  /** ボリンジャーバンド内の位置。0 = 下バンド, 1 = 上バンド */
  percentB: number[];
  /** その足のUTC時刻（0〜23） */
  hourUtc: number[];
}

export interface EntryRule {
  id: string;
  name: string;
  /** 何を狙っているか。結果を読むときに必要 */
  idea: string;
  decide(ctx: RuleContext): Direction | null;
}

/**
 * 系列をまとめて用意する。
 * ボリンジャーは既存の実装が最新値しか返さないので、ここで移動平均と
 * 標準偏差から系列として組む（計算は同じ）。
 */
export function buildContext(candles: OHLC[], bbPeriod = 20, bbMult = 2): RuleContext {
  const closes = candles.map((c) => c.close);
  const percentB = new Array<number>(candles.length).fill(NaN);

  // 累積和から分散を出す形（E[x²]-E[x]²）は速いが、為替のように
  // 平均に対して分散が極端に小さいと桁落ちする。窓が20本なら素直に
  // 2周した方が安く、既存の実装と同じ値になる。
  for (let i = bbPeriod - 1; i < closes.length; i++) {
    let sum = 0;
    for (let j = i - bbPeriod + 1; j <= i; j++) sum += closes[j];
    const mean = sum / bbPeriod;

    let variance = 0;
    for (let j = i - bbPeriod + 1; j <= i; j++) variance += (closes[j] - mean) ** 2;
    variance /= bbPeriod;

    const sd = Math.sqrt(variance);
    const width = 2 * bbMult * sd;
    percentB[i] = width === 0 ? 0.5 : (closes[i] - (mean - bbMult * sd)) / width;
  }

  return {
    candles,
    i: 0,
    atr: calculateATR(candles, 14),
    ema20: calculateEMA(closes, 20),
    ema50: calculateEMA(closes, 50),
    ema200: calculateEMA(closes, 200),
    rsi: calculateRSI(closes, 14),
    percentB,
    hourUtc: candles.map((c) => new Date(c.timestamp).getUTCHours()),
  };
}

/** 直近 lookback 本の高値・安値（当該足を含まない） */
function priorRange(candles: OHLC[], i: number, lookback: number): { high: number; low: number } | null {
  if (i - lookback < 0) return null;
  let high = -Infinity;
  let low = Infinity;
  for (let j = i - lookback; j < i; j++) {
    if (candles[j].high > high) high = candles[j].high;
    if (candles[j].low < low) low = candles[j].low;
  }
  return { high, low };
}

const ok = (v: number | undefined): v is number => v !== undefined && Number.isFinite(v);

/**
 * 逆張り: バンドの外側で入る。
 * 1時間足の短期的な行き過ぎは戻りやすい、という前提。
 */
export const bbReversion: EntryRule = {
  id: "bb_reversion",
  name: "ボリンジャー逆張り",
  idea: "バンドの外まで伸びたら反対側に入る（短期の行き過ぎは戻る）",
  decide({ percentB, i }) {
    const b = percentB[i];
    if (!ok(b)) return null;
    if (b <= 0.02) return "BUY";
    if (b >= 0.98) return "SELL";
    return null;
  },
};

/**
 * 逆張り: RSIが極値から戻り始めたところで入る。
 * 「行き過ぎ」だけでなく「戻り始め」を待つぶん、bb_reversion より遅い。
 */
export const rsiReversion: EntryRule = {
  id: "rsi_reversion",
  name: "RSI反転",
  idea: "RSIが30を上抜け／70を下抜けした足で入る（極値からの折り返し）",
  decide({ rsi, i }) {
    const now = rsi[i];
    const prev = rsi[i - 1];
    if (!ok(now) || !ok(prev)) return null;
    if (prev <= 30 && now > 30) return "BUY";
    if (prev >= 70 && now < 70) return "SELL";
    return null;
  },
};

/**
 * 順張り: フィルターを何も付けない素の追随。
 * 既存エンジンの15条件が効いているかどうかの基準線になる。
 */
export const plainMomentum: EntryRule = {
  id: "plain_momentum",
  name: "素の順張り",
  idea: "24本前より上でEMA20の上ならBUY（条件を足さない追随）",
  decide({ candles, ema20, i }) {
    if (i < 24) return null;
    const e = ema20[i];
    if (!ok(e)) return null;
    const now = candles[i].close;
    const past = candles[i - 24].close;
    if (now > past && now > e) return "BUY";
    if (now < past && now < e) return "SELL";
    return null;
  },
};

/**
 * ロンドン開始のブレイク。
 * 東京時間（UTC 0〜7時）に作ったレンジを、ロンドン最初の足が抜けた方向に入る。
 * FXの時間帯ごとの性質の違いを使う、という前提。
 */
export const londonBreakout: EntryRule = {
  id: "london_breakout",
  name: "ロンドン開始のブレイク",
  idea: "東京時間のレンジを、ロンドン最初の足が抜けた方向に入る",
  decide({ candles, hourUtc, i }) {
    // UTC 7時 = 夏時間のロンドン開始。冬は8時だが、揃えず1本だけ見る
    if (hourUtc[i] !== 7) return null;
    const range = priorRange(candles, i, 7);
    if (!range) return null;
    const c = candles[i];
    if (c.close > range.high) return "BUY";
    if (c.close < range.low) return "SELL";
    return null;
  },
};

/**
 * 東京仲値の前後。
 * ドル円は9:55 JST（UTC 0:55）の仲値決めに向けて実需の買いが出やすく、
 * その後に戻る、という言われ方をする。UTC 0時足の動いた方向に対して
 * 1時足で逆に入り、その「戻り」を取れるかを見る。
 */
export const tokyoFixFade: EntryRule = {
  id: "tokyo_fix_fade",
  name: "東京仲値の戻り",
  idea: "仲値に向けて動いた方向と逆に入る（実需で動いた分は戻る）",
  decide({ candles, hourUtc, i }) {
    if (hourUtc[i] !== 1) return null;
    const fixBar = candles[i - 1];
    if (!fixBar) return null;
    const move = fixBar.close - fixBar.open;
    const body = Math.abs(move);
    const range = fixBar.high - fixBar.low;
    // 方向がはっきりしている足だけを対象にする
    if (range <= 0 || body / range < 0.5) return null;
    return move > 0 ? "SELL" : "BUY";
  },
};

/**
 * 日足の方向に沿った押し目・戻り目。
 * 既存エンジンと発想は近いが、条件を日足EMA200と1H RSIの2つだけに絞る。
 * 条件を減らすと良くなるのか悪くなるのかを見るため。
 */
export const trendPullback: EntryRule = {
  id: "trend_pullback",
  name: "上位足に沿った押し目",
  idea: "EMA200の上でRSIが40未満ならBUY（大きな流れの方向に引きつけて入る）",
  decide({ candles, ema200, rsi, i }) {
    const e = ema200[i];
    const r = rsi[i];
    if (!ok(e) || !ok(r)) return null;
    const price = candles[i].close;
    if (price > e && r < 40) return "BUY";
    if (price < e && r > 60) return "SELL";
    return null;
  },
};

/**
 * 時間帯だけで入る。
 * 「入る向きに情報がある」のか「入る時刻に情報がある」のかを分けるための対照。
 * ロンドン時間に、その日ここまでの方向に沿って入るだけ。
 */
export const sessionDrift: EntryRule = {
  id: "session_drift",
  name: "ロンドン時間の継続",
  idea: "ロンドン時間に、その日ここまで動いた方向へ入るだけ",
  decide({ candles, hourUtc, i }) {
    const session = getTimeSessionFromTimestamp(candles[i].timestamp);
    if (session !== "LONDON") return null;
    if (hourUtc[i] < 1) return null;
    const range = priorRange(candles, i, Math.min(hourUtc[i], 8));
    if (!range) return null;
    const mid = (range.high + range.low) / 2;
    return candles[i].close > mid ? "BUY" : "SELL";
  },
};

export const ALL_RULES: EntryRule[] = [
  bbReversion,
  rsiReversion,
  plainMomentum,
  londonBreakout,
  tokyoFixFade,
  trendPullback,
  sessionDrift,
];

/**
 * ルールを走らせてシグナルの位置を集める。`collectSignals` と同じ形を返すので、
 * 決済とコストの扱いは既存のバックテストとまったく同じになる。
 */
export function scanRule(
  rule: EntryRule,
  ctx: RuleContext,
  fromIndex: number,
  toIndex: number,
): { hits: { index: number; direction: Direction; atr: number; confidence: number }[]; barsEvaluated: number } {
  const hits: { index: number; direction: Direction; atr: number; confidence: number }[] = [];
  let barsEvaluated = 0;

  for (let i = Math.max(fromIndex, 250); i < Math.min(toIndex, ctx.candles.length - 1); i++) {
    const atr = ctx.atr[i];
    if (!ok(atr) || atr <= 0) continue;
    barsEvaluated++;

    const direction = rule.decide({ ...ctx, i });
    if (direction === null) continue;
    hits.push({ index: i, direction, atr, confidence: 50 });
  }

  return { hits, barsEvaluated };
}
