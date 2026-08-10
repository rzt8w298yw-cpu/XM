/**
 * 月初の効果を測る
 *
 * 「月が変わった最初の営業日に、前月の方向と逆へ入り、n営業日持つ」の
 * リターンを取り出す。終値の列だけがあれば計算できる形にしてあるのは、
 * 手持ちのOHLCとは別の出所（対ドル日次レート、1971年〜）で同じことを
 * 確かめるため。標本の外で確かめられなければ、事後に見つけたものは
 * 何も主張できない。
 *
 * ここは先読みを一切してはいけない場所なので、i より後ろの値を触らない。
 * 「今日が月末最終営業日か」は翌営業日を見ないと分からないため使わず、
 * 「前の足と月が変わったか」だけで月初を判定する。
 */

export interface MonthEffectInput {
  /** YYYY-MM-DD の昇順。営業日のみ（休日の行は含めない） */
  dates: string[];
  /** dates と同じ長さの終値 */
  values: number[];
  /** 何営業日ぶんの方向を「前月の方向」とみなすか */
  lookback: number;
  /** 何営業日持つか */
  hold: number;
  /** リターンを割るばらつきを、直近何営業日から求めるか */
  volatilityWindow?: number;
}

export interface MonthEffectSample {
  /** dates 上の位置 */
  index: number;
  date: string;
  year: number;
  /** 前月と逆に入る向き。+1 = 買い, -1 = 売り */
  sign: number;
  /** 入った日から hold 日後までのリターン（ばらつきで割った値、向きを掛ける前） */
  rawReturn: number;
  /** 向きを掛けた後。プラスなら逆張りが当たっている */
  signedReturn: number;
}

/**
 * 直近 window 営業日の、対数変化率の標準偏差。
 * 通貨ごとに値動きの大きさが違うので、そのまま平均すると
 * 動きの大きい通貨の話になってしまう。割って揃える。
 */
export function trailingVolatility(values: number[], end: number, window: number): number {
  if (end < window || window < 2) return NaN;
  const changes: number[] = [];
  for (let i = end - window + 1; i <= end; i++) {
    if (values[i - 1] <= 0 || values[i] <= 0) return NaN;
    changes.push(Math.log(values[i] / values[i - 1]));
  }
  const mean = changes.reduce((a, b) => a + b, 0) / changes.length;
  const variance = changes.reduce((s, v) => s + (v - mean) ** 2, 0) / changes.length;
  return Math.sqrt(variance);
}

/** 前の営業日と月が変わっていれば、その日が月初の最初の営業日 */
export function isFirstTradingDayOfMonth(dates: string[], i: number): boolean {
  if (i <= 0) return false;
  return dates[i].slice(0, 7) !== dates[i - 1].slice(0, 7);
}

export function collectMonthEffect(input: MonthEffectInput): MonthEffectSample[] {
  const { dates, values, lookback, hold } = input;
  const volatilityWindow = input.volatilityWindow ?? 60;
  if (dates.length !== values.length) {
    throw new Error("dates と values の長さが一致しません");
  }

  const out: MonthEffectSample[] = [];
  const start = Math.max(lookback, volatilityWindow + 1);

  for (let i = start; i + hold < values.length; i++) {
    if (!isFirstTradingDayOfMonth(dates, i)) continue;
    if (values[i] <= 0 || values[i - lookback] <= 0) continue;

    const previousMove = Math.log(values[i] / values[i - lookback]);
    if (previousMove === 0) continue;

    const volatility = trailingVolatility(values, i, volatilityWindow);
    if (!Number.isFinite(volatility) || volatility <= 0) continue;

    // 前月と逆へ入る
    const sign = previousMove > 0 ? -1 : 1;
    const forward = Math.log(values[i + hold] / values[i]);
    const scaled = forward / (volatility * Math.sqrt(hold));

    out.push({
      index: i,
      date: dates[i],
      year: Number(dates[i].slice(0, 4)),
      sign,
      rawReturn: scaled,
      signedReturn: scaled * sign,
    });
  }
  return out;
}

/** 決まった種から同じ並びを返す小さな乱数 */
export function makeRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function mean(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length;
}

/**
 * 向きだけを入れ替えた分布と比べる並べ替え検定。
 *
 * t検定は観測が独立である前提を置くが、月初どうしは同じ相場の同じ局面を
 * 共有していて独立ではない。そのまま使うと有意に出やすくなる。
 * 向きをコインで決め直す帰無仮説なら、重なりの構造は帰無側にも同じだけ
 * 入るので、そこは打ち消される。
 *
 * `twoSided` が false なら「逆張りが効いている側」だけを見る。
 */
export function permutationTest(
  samples: { rawReturn: number; sign: number }[],
  seed: number,
  permutations = 20_000,
  twoSided = false,
): { actual: number; p: number } {
  if (samples.length === 0) return { actual: 0, p: 1 };

  const raw = samples.map((s) => s.rawReturn);
  const actual = mean(samples.map((s) => s.rawReturn * s.sign));

  const rand = makeRandom(seed);
  let atLeastAsExtreme = 0;
  for (let p = 0; p < permutations; p++) {
    let total = 0;
    for (let i = 0; i < raw.length; i++) total += rand() < 0.5 ? raw[i] : -raw[i];
    const value = total / raw.length;
    if (twoSided ? Math.abs(value) >= Math.abs(actual) : value >= actual) atLeastAsExtreme++;
  }
  return { actual, p: atLeastAsExtreme / permutations };
}
