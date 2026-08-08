/**
 * 為替レートの模擬生成
 *
 * 単純なランダムウォークは実際の値動きと性質が違いすぎて、戦略の検証に使うと
 * 誤った結論を導く。ここではドル円の1H足に見られる性質を再現する。
 *
 * - ボラティリティのクラスタリング（GARCH(1,1)型）— 荒れた時間帯は荒れ続ける
 * - セッションごとのボラティリティ差 — ロンドン・NYが大きく、深夜は小さい
 * - 週末の空白と、週明けの窓開け
 * - 緩やかに切り替わるトレンド（レジーム）
 * - 1時間を12本の5分足に分けて高値・安値を作る（ヒゲの形が現実に近くなる）
 *
 * ここで生成されるのは「ドル円らしい統計的性質を持つ架空の値動き」であって、
 * 実際のドル円の歴史ではない。過去の成績を測る用途には使えない。
 */
import type { OHLC } from "./technicalAnalysis";

const HOUR_MS = 3_600_000;
const SUB_STEPS = 12; // 1時間を5分×12本に分割

export interface SimulatorConfig {
  /** 開始価格 */
  startPrice: number;
  /** 生成する1H足の本数（週末は含まない） */
  bars: number;
  /** 1時間あたりの基準ボラティリティ（対数収益率の標準偏差） */
  baseVolatility: number;
  /** GARCH: 直前の変動が次のボラティリティに影響する度合い */
  alpha: number;
  /** GARCH: ボラティリティの持続性 */
  beta: number;
  /** レジーム（トレンド）の平均継続時間（時間） */
  regimeMeanHours: number;
  /** レジームのドリフト強度。基準ボラティリティに対する倍率 */
  regimeDriftScale: number;
  /** 週明けの窓開けの大きさ。基準ボラティリティに対する倍率 */
  weekendGapScale: number;
  /** 生成開始時刻（UTC） */
  startTime: number;
}

/** ドル円の1H足に近い既定値。年率ボラティリティ約9%相当 */
export const USDJPY_LIKE: Omit<SimulatorConfig, "bars" | "startTime"> = {
  startPrice: 150,
  baseVolatility: 0.0011,
  alpha: 0.09,
  beta: 0.88,
  regimeMeanHours: 220,
  regimeDriftScale: 0.35,
  weekendGapScale: 2.0,
};

/** セッションごとのボラティリティ倍率（JSTの時刻で切り替える） */
function sessionVolatility(timestamp: number): number {
  const jstHour = (new Date(timestamp).getUTCHours() + 9) % 24;
  if (jstHour >= 16 && jstHour < 21) return 1.35; // ロンドン
  if (jstHour >= 21 || jstHour < 2) return 1.45;  // NY（ロンドンと重なる時間を含む）
  if (jstHour >= 9 && jstHour < 15) return 0.95;  // 東京
  if (jstHour >= 2 && jstHour < 6) return 0.55;   // NY引け後
  return 0.7;
}

/** 為替市場が開いているか（月曜〜金曜。土日は閉場） */
function isMarketOpen(timestamp: number): boolean {
  const date = new Date(timestamp);
  const day = date.getUTCDay();
  const hour = date.getUTCHours();
  if (day === 6) return false;                 // 土曜
  if (day === 0) return hour >= 22;            // 日曜はNY時間の開始から
  if (day === 5) return hour < 22;             // 金曜はNY引けまで
  return true;
}

export function createSimulator(seed: number, overrides: Partial<SimulatorConfig> = {}) {
  const config: SimulatorConfig = {
    ...USDJPY_LIKE,
    bars: 8000,
    startTime: Date.UTC(2023, 0, 2, 0, 0, 0), // 月曜から開始
    ...overrides,
  };
  return generate(seed, config);
}

function generate(seed: number, config: SimulatorConfig): OHLC[] {
  const rand = mulberry32(seed);
  const gauss = makeGaussian(rand);

  const candles: OHLC[] = [];
  let price = config.startPrice;
  let variance = config.baseVolatility ** 2;
  let drift = 0;

  // レジームの切り替えは幾何分布で近似する
  const regimeSwitchProbability = 1 / config.regimeMeanHours;

  let timestamp = config.startTime;
  let previousWasOpen = true;

  while (candles.length < config.bars) {
    if (!isMarketOpen(timestamp)) {
      previousWasOpen = false;
      timestamp += HOUR_MS;
      continue;
    }

    if (rand() < regimeSwitchProbability) {
      drift = gauss() * config.baseVolatility * config.regimeDriftScale;
    }

    const sessionScale = sessionVolatility(timestamp);

    // 週明けは窓を開けて始まる
    if (!previousWasOpen && candles.length > 0) {
      price *= Math.exp(gauss() * config.baseVolatility * config.weekendGapScale);
    }
    previousWasOpen = true;

    const open = price;
    let high = open;
    let low = open;

    // 1時間を5分足に分割して高値・安値を作る
    const hourSigma = Math.sqrt(variance) * sessionScale;
    const stepSigma = hourSigma / Math.sqrt(SUB_STEPS);
    const stepDrift = drift / SUB_STEPS;
    let hourReturn = 0;

    for (let step = 0; step < SUB_STEPS; step++) {
      const stepReturn = stepDrift + gauss() * stepSigma;
      hourReturn += stepReturn;
      price *= Math.exp(stepReturn);
      if (price > high) high = price;
      if (price < low) low = price;
    }

    candles.push({ timestamp, open, high, low, close: price });

    // GARCH(1,1): 次の時間のボラティリティを更新する
    const omega = config.baseVolatility ** 2 * (1 - config.alpha - config.beta);
    variance = omega + config.alpha * hourReturn ** 2 + config.beta * variance;

    timestamp += HOUR_MS;
  }

  return candles;
}

function makeGaussian(rand: () => number): () => number {
  let spare: number | null = null;
  return () => {
    if (spare !== null) {
      const value = spare;
      spare = null;
      return value;
    }
    // Box-Muller法
    let u = 0;
    let v = 0;
    let s = 0;
    do {
      u = rand() * 2 - 1;
      v = rand() * 2 - 1;
      s = u * u + v * v;
    } while (s === 0 || s >= 1);
    const factor = Math.sqrt((-2 * Math.log(s)) / s);
    spare = v * factor;
    return u * factor;
  };
}

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
