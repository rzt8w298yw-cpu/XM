/**
 * バックテスト基盤
 *
 * 1H足を1本ずつ前進させながら `generateSignal` を呼び、BUY/SELLが出たら
 * ATRベースの損切り/利確に到達するまで先のローソク足でシミュレートする。
 *
 * 先読み（lookahead）を避けるための約束事:
 * - 判定に渡すのは評価中の足までのウィンドウのみ。
 * - 日足は「その時点で確定済み」のものだけ渡す（形成中の日足の終値は使えない）。
 * - エントリーはシグナルが出た足の終値ではなく、次の足の始値で約定させる。
 * - 同じ足の中で利確・損切りの両方に触れた場合は損切りを優先する（悲観側）。
 * - 損切りと時間切れの決済は不利な方向に滑らせる（指値で約定する利確は滑らせない）。
 */
import {
  generateSignal,
  type SignalThresholds,
  type SignalType,
} from "./autoSignalEngine";
import { aggregate } from "./marketData";
import type { OHLC } from "./technicalAnalysis";
import { getTimeSessionFromTimestamp, type TimeSession } from "./technicalAnalysis";

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

export interface BacktestConfig {
  /** 1pipあたりの価格差 */
  pipSize: number;
  /** 損切り幅 = ATR * この倍率 */
  atrStopMultiplier: number;
  /** 利確幅 = 損切り幅 * この倍率 */
  riskRewardRatio: number;
  /** 往復のスプレッド/コスト（pips）。全トレードの損益から差し引く */
  spreadPips: number;
  /**
   * 損切りの滑り（pips）。損切りに達するのは値動きが速い局面なので、
   * 実際の約定は指定レートより不利になる。ここを0にすると成績が
   * 実態より良く出る。
   */
  stopSlippagePips: number;
  /** 判定に渡す1H足の本数。本番アプリの取得本数に合わせる */
  windowSize: number;
  /** 決済されないまま保有し続ける上限（1H足の本数） */
  maxHoldingBars: number;
  /**
   * 損切り・利確を使うか。false なら maxHoldingBars 本後の終値で決済する。
   *
   * 損切りと利確は経路に依存する。行き先が同じでも、途中で損切りに触れば
   * 負けになる。そのため「エントリーに情報が無い」のか「情報はあるが決済が
   * 捨てている」のかを、損切りを挟んだ計測では区別できない。
   * これを false にすると、方向が当たっているかだけを測れる。
   */
  useStops?: boolean;
  /**
   * 対照実験の候補をロンドン・NY時間に絞るか。既定は絞る。
   *
   * **日足では必ず false にすること。** 日足の足の時刻は 22:00 UTC で
   * 固定されていて、どちらのセッションにも該当しない。絞ったままだと
   * 候補が1本も残らず、対照は0件・勝率0%を返す。それを戦略の勝率と
   * 比べると必ず「ランダムを上回った」になる——比較そのものが
   * 行われていないのに。
   */
  restrictToSessions?: boolean;
  /** 閾値の上書き */
  thresholds?: Partial<SignalThresholds>;
}

export const DEFAULT_BACKTEST_CONFIG: BacktestConfig = {
  pipSize: 0.01,
  atrStopMultiplier: 1.5,
  riskRewardRatio: 2,
  spreadPips: 1.0,
  stopSlippagePips: 0.5,
  windowSize: 1000,
  maxHoldingBars: 120,
};

export type ExitReason = "take_profit" | "stop_loss" | "timeout" | "end_of_data";

export interface Trade {
  direction: Exclude<SignalType, "WAIT">;
  entryTime: number;
  entryPrice: number;
  exitTime: number;
  exitPrice: number;
  stopLoss: number;
  takeProfit: number;
  /** スプレッド控除後の損益（pips） */
  pips: number;
  exitReason: ExitReason;
  holdingBars: number;
  confidence: number;
  session: TimeSession;
}

export interface BacktestResult {
  trades: Trade[];
  /** ポジション保有中で判定をスキップした足の本数 */
  barsInPosition: number;
  /** 判定を実行した足の本数 */
  barsEvaluated: number;
  stats: BacktestStats;
}

export interface BacktestStats {
  trades: number;
  wins: number;
  losses: number;
  winRate: number;
  netPips: number;
  grossProfitPips: number;
  grossLossPips: number;
  /** 総利益 / 総損失。損失0なら Infinity */
  profitFactor: number;
  /** 1トレードあたりの期待値（pips） */
  expectancyPips: number;
  /** 累積損益の最大落ち込み幅（pips） */
  maxDrawdownPips: number;
  averageHoldingBars: number;
  byDirection: { BUY: DirectionStats; SELL: DirectionStats };
}

export interface DirectionStats {
  trades: number;
  wins: number;
  winRate: number;
  netPips: number;
  profitFactor: number;
}

/** ある足で出たシグナル。決済条件を変えて何度も試せるよう、判定結果だけを保持する */
export interface SignalHit {
  /** candles1H 上のインデックス */
  index: number;
  direction: Exclude<SignalType, "WAIT">;
  atr: number;
  confidence: number;
}

export interface SignalScan {
  hits: SignalHit[];
  barsEvaluated: number;
}

/**
 * 1H足を前進させながら判定だけを行い、シグナルが出た位置を集める。
 *
 * 決済条件（損切り幅・リスクリワード）は判定結果に影響しないので、
 * 判定と決済を分けておくと、同じ判定結果に対して決済条件だけを何通りも
 * 試せる。パラメータ探索では判定が支配的に重いので、この分離が効く。
 *
 * ポジションの保有で判定をスキップする挙動は決済条件に依存するため、
 * ここでは行わない（保有の重なりは `simulateFromSignals` 側で解決する）。
 */
export function collectSignals(
  candles1H: OHLC[],
  candlesDaily: OHLC[],
  config: Partial<BacktestConfig> = {},
): SignalScan {
  const cfg = { ...DEFAULT_BACKTEST_CONFIG, ...config };
  const hits: SignalHit[] = [];
  let barsEvaluated = 0;

  // ウォームアップ: 1H足のEMA200と、日足のEMA200が計算できるところから始める
  const firstBar = Math.max(cfg.windowSize, 250);

  for (let i = firstBar; i < candles1H.length - 1; i++) {
    const bar = candles1H[i];
    // 評価中の足が閉じた時刻。ここまでの情報しか使ってはいけない
    const barCloseTime = bar.timestamp + HOUR_MS;

    const window1H = candles1H.slice(i - cfg.windowSize + 1, i + 1);
    const dailyClosed = closedDailyCandles(candlesDaily, barCloseTime);
    if (dailyClosed.length < 210) continue;

    barsEvaluated++;

    const result = generateSignal(
      window1H,
      aggregate(window1H, 4),
      dailyClosed,
      aggregate(window1H, 8),
      { overrideTimestamp: bar.timestamp, thresholds: cfg.thresholds },
    );

    if (result.signal === "WAIT") continue;
    const atr = result.analysis.currentATR;
    if (atr <= 0) continue;

    hits.push({
      index: i,
      direction: result.signal,
      atr,
      confidence: result.confidence,
    });
  }

  return { hits, barsEvaluated };
}

/**
 * その時刻までに「確定済み」の日足だけを返す。
 *
 * 形成中の日足を渡すと、まだ確定していない終値でトレンドを判定することになり、
 * 未来の情報が判定に混入する。バックテストの成績を実際より良く見せる典型的な
 * 経路なので、切り出して単体で検証できるようにしてある。
 */
export function closedDailyCandles(candlesDaily: OHLC[], atTime: number): OHLC[] {
  return candlesDaily.filter((d) => d.timestamp + DAY_MS <= atTime);
}

/**
 * 集めたシグナルを、指定の決済条件で順にトレードにしていく。
 * 保有中に出たシグナルは見送る（同時に1ポジションのみ）。
 */
export function simulateFromSignals(
  scan: SignalScan,
  candles1H: OHLC[],
  config: Partial<BacktestConfig> = {},
): BacktestResult {
  const cfg = { ...DEFAULT_BACKTEST_CONFIG, ...config };
  const trades: Trade[] = [];

  let barsInPosition = 0;
  let occupiedUntil = -1;

  for (const hit of scan.hits) {
    if (hit.index <= occupiedUntil) continue;

    const trade = simulateTrade(
      candles1H, hit.index, hit.direction, hit.atr, hit.confidence, cfg,
    );
    if (!trade) continue;

    trades.push(trade);
    barsInPosition += trade.holdingBars;
    occupiedUntil = hit.index + trade.holdingBars;
  }

  return {
    trades,
    barsInPosition,
    barsEvaluated: scan.barsEvaluated,
    stats: summarize(trades),
  };
}

/**
 * バックテストを実行する。
 * candles1H は時系列昇順、candlesDaily も昇順であること。
 */
export function runBacktest(
  candles1H: OHLC[],
  candlesDaily: OHLC[],
  config: Partial<BacktestConfig> = {},
): BacktestResult {
  const scan = collectSignals(candles1H, candlesDaily, config);
  return simulateFromSignals(scan, candles1H, config);
}

/**
 * シグナルが出た足の「次の足の始値」で入り、損切り/利確に触れるまで前進させる。
 * 決済ロジックはバックテスト結果を左右する中核なので、単体でテストできるよう公開している。
 */
export function simulateTrade(
  candles1H: OHLC[],
  signalIndex: number,
  direction: Exclude<SignalType, "WAIT">,
  atr: number,
  confidence: number,
  cfg: BacktestConfig,
): Trade | null {
  const entryIndex = signalIndex + 1;
  if (entryIndex >= candles1H.length) return null;

  const entryPrice = candles1H[entryIndex].open;
  const sign = direction === "BUY" ? 1 : -1;
  const stopDistance = atr * cfg.atrStopMultiplier;
  const targetDistance = stopDistance * cfg.riskRewardRatio;
  const stopLoss = entryPrice - stopDistance * sign;
  const takeProfit = entryPrice + targetDistance * sign;

  // maxHoldingBars 本ぶん保有したら打ち切る（エントリー足を1本目と数える）
  const lastIndex = Math.min(entryIndex + cfg.maxHoldingBars - 1, candles1H.length - 1);

  const useStops = cfg.useStops !== false;
  for (let j = entryIndex; useStops && j <= lastIndex; j++) {
    const candle = candles1H[j];
    const hitStop = direction === "BUY" ? candle.low <= stopLoss : candle.high >= stopLoss;
    const hitTarget = direction === "BUY" ? candle.high >= takeProfit : candle.low <= takeProfit;

    // 同じ足で両方に触れた場合、足の中の到達順は1H足からは判別できない。
    // 成績を楽観的に見積もらないよう損切り側を採用する。
    if (hitStop) {
      // 損切りは不利な方向に滑る。BUYなら想定より安く、SELLなら高く約定する
      const filled = stopLoss - cfg.stopSlippagePips * cfg.pipSize * sign;
      return buildTrade(direction, candles1H, entryIndex, j, entryPrice, filled, stopLoss, takeProfit, "stop_loss", confidence, cfg);
    }
    if (hitTarget) {
      return buildTrade(direction, candles1H, entryIndex, j, entryPrice, takeProfit, stopLoss, takeProfit, "take_profit", confidence, cfg);
    }
  }

  const exitIndex = lastIndex;
  const reason: ExitReason =
    exitIndex >= candles1H.length - 1 && exitIndex < entryIndex + cfg.maxHoldingBars - 1
      ? "end_of_data"
      : "timeout";
  // 時間切れの決済も成行なので不利側に滑る
  const marketExit = candles1H[exitIndex].close - cfg.stopSlippagePips * cfg.pipSize * sign;
  return buildTrade(
    direction, candles1H, entryIndex, exitIndex, entryPrice,
    marketExit, stopLoss, takeProfit, reason, confidence, cfg,
  );
}

function buildTrade(
  direction: Exclude<SignalType, "WAIT">,
  candles1H: OHLC[],
  entryIndex: number,
  exitIndex: number,
  entryPrice: number,
  exitPrice: number,
  stopLoss: number,
  takeProfit: number,
  exitReason: ExitReason,
  confidence: number,
  cfg: BacktestConfig,
): Trade {
  const sign = direction === "BUY" ? 1 : -1;
  const rawPips = ((exitPrice - entryPrice) * sign) / cfg.pipSize;

  return {
    direction,
    entryTime: candles1H[entryIndex].timestamp,
    entryPrice,
    exitTime: candles1H[exitIndex].timestamp,
    exitPrice,
    stopLoss,
    takeProfit,
    pips: rawPips - cfg.spreadPips,
    exitReason,
    holdingBars: exitIndex - entryIndex + 1,
    confidence,
    session: getTimeSessionFromTimestamp(candles1H[entryIndex].timestamp),
  };
}

// ============================================================
// 対照実験: ランダムエントリー
// ============================================================

/**
 * 同じ値動きに対してランダムにエントリーした場合の成績を出す。
 *
 * 戦略の数値だけを見ても、それが値動きの構造を捉えた結果なのか、
 * 単に「損切り1に対して利確2」の賭けを繰り返した結果なのかは区別できない。
 * エントリー本数・損切り幅・利確幅・取引セッションを戦略側と揃えたうえで
 * 入る場所だけを乱数にすることで、その差分を見る。
 */
export function runRandomEntryControl(
  candles1H: OHLC[],
  atrSeries: number[],
  tradeCount: number,
  seed: number,
  config: Partial<BacktestConfig> = {},
): BacktestResult {
  const cfg = { ...DEFAULT_BACKTEST_CONFIG, ...config };
  const rand = mulberry32(seed);
  const trades: Trade[] = [];

  const firstBar = Math.max(cfg.windowSize, 250);
  // 戦略と同じくロンドン・NY時間だけを候補にする
  const restrictToSessions = cfg.restrictToSessions !== false;
  const candidates: number[] = [];
  for (let i = firstBar; i < candles1H.length - 1; i++) {
    const atr = atrSeries[i];
    if (atr === undefined || atr <= 0) continue;
    if (restrictToSessions) {
      const session = getTimeSessionFromTimestamp(candles1H[i].timestamp);
      if (session !== "LONDON" && session !== "NY") continue;
    }
    candidates.push(i);
  }
  /*
   * 候補が無いまま「0件の対照」を返してはいけない。
   *
   * 0件の統計は勝率0%になり、どんな戦略でもそれを上回る。つまり
   * 比較が行われていないことが「圧勝」として出力される。日足に
   * セッション絞り込みを掛けたときに実際にこれが起きた。黙って
   * 空を返すより、呼び出し側を止めるほうがいい。
   */
  if (candidates.length === 0) {
    throw new Error(
      "対照実験の候補が1本もありません。" +
        (restrictToSessions
          ? "日足など、ロンドン・NY時間に当たらない足では restrictToSessions: false を指定してください。"
          : "ATRが有効な足がありません。"),
    );
  }

  const used: { from: number; to: number }[] = [];
  let attempts = 0;
  const maxAttempts = tradeCount * 200;

  while (trades.length < tradeCount && attempts < maxAttempts) {
    attempts++;
    const index = candidates[Math.floor(rand() * candidates.length)];
    // 保有期間が既存のトレードと重ならないようにする（同時1ポジション）
    if (used.some((span) => index >= span.from && index <= span.to)) continue;

    const direction = rand() < 0.5 ? "BUY" : "SELL";
    const trade = simulateTrade(candles1H, index, direction, atrSeries[index], 0, cfg);
    if (!trade) continue;

    const span = { from: index, to: index + trade.holdingBars };
    if (used.some((other) => span.from <= other.to && other.from <= span.to)) continue;

    used.push(span);
    trades.push(trade);
  }

  trades.sort((a, b) => a.entryTime - b.entryTime);
  return {
    trades,
    barsInPosition: 0,
    barsEvaluated: candidates.length,
    stats: summarize(trades),
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

// ============================================================
// 集計
// ============================================================

export function summarize(trades: Trade[]): BacktestStats {
  const wins = trades.filter((t) => t.pips > 0);
  const losses = trades.filter((t) => t.pips <= 0);

  const grossProfit = wins.reduce((sum, t) => sum + t.pips, 0);
  const grossLoss = Math.abs(losses.reduce((sum, t) => sum + t.pips, 0));
  const netPips = grossProfit - grossLoss;

  // 累積損益の山からの落ち込みを追う
  let peak = 0;
  let cumulative = 0;
  let maxDrawdown = 0;
  for (const trade of trades) {
    cumulative += trade.pips;
    if (cumulative > peak) peak = cumulative;
    maxDrawdown = Math.max(maxDrawdown, peak - cumulative);
  }

  return {
    trades: trades.length,
    wins: wins.length,
    losses: losses.length,
    winRate: trades.length === 0 ? 0 : (wins.length / trades.length) * 100,
    netPips,
    grossProfitPips: grossProfit,
    grossLossPips: grossLoss,
    profitFactor: grossLoss === 0 ? (grossProfit > 0 ? Infinity : 0) : grossProfit / grossLoss,
    expectancyPips: trades.length === 0 ? 0 : netPips / trades.length,
    maxDrawdownPips: maxDrawdown,
    averageHoldingBars:
      trades.length === 0
        ? 0
        : trades.reduce((sum, t) => sum + t.holdingBars, 0) / trades.length,
    byDirection: {
      BUY: directionStats(trades.filter((t) => t.direction === "BUY")),
      SELL: directionStats(trades.filter((t) => t.direction === "SELL")),
    },
  };
}

function directionStats(trades: Trade[]): DirectionStats {
  const wins = trades.filter((t) => t.pips > 0);
  const grossProfit = wins.reduce((sum, t) => sum + t.pips, 0);
  const grossLoss = Math.abs(
    trades.filter((t) => t.pips <= 0).reduce((sum, t) => sum + t.pips, 0),
  );

  return {
    trades: trades.length,
    wins: wins.length,
    winRate: trades.length === 0 ? 0 : (wins.length / trades.length) * 100,
    netPips: grossProfit - grossLoss,
    profitFactor: grossLoss === 0 ? (grossProfit > 0 ? Infinity : 0) : grossProfit / grossLoss,
  };
}

// ============================================================
// 対照実験の判定
// ============================================================

/**
 * 戦略とランダムエントリーの比較結果。
 *
 * 判定を文言の組み立てから切り離してある。この一式で最も重要な結論を
 * 出す分岐なので、画面出力の中に埋めるとテストできない。
 */
export type ControlVerdict =
  /** ランダムの散らばりの中にある。優位性があるとは言えない */
  | "indistinguishable"
  /** ランダムの全本を上回った */
  | "above"
  /** ランダムの全本を下回った。判定が逆に働いている疑い */
  | "below";

export interface ControlComparison {
  verdict: ControlVerdict;
  /** ランダムの勝率の最小 */
  lowestWinRate: number;
  /** ランダムの勝率の最大 */
  highestWinRate: number;
  /** 損益で戦略以上だったランダムの本数 */
  beatenBy: number;
  runs: number;
}

/**
 * 戦略の勝率がランダムの散らばりに収まっているかを判定する。
 *
 * **境界は「中に入っている」側に倒す。** ちょうど最大値と並んだだけで
 * 「上回った」と言うと、乱数の引き1つで結論が変わる。優位だと言うには
 * 全本をはっきり超えている必要がある。
 */
export function compareWithControl(
  strategy: BacktestStats,
  controls: BacktestStats[],
): ControlComparison {
  if (controls.length === 0) {
    throw new Error("対照実験の結果が1本もありません");
  }

  const winRates = controls.map((c) => c.winRate);
  const lowestWinRate = Math.min(...winRates);
  const highestWinRate = Math.max(...winRates);
  const beatenBy = controls.filter((c) => c.netPips >= strategy.netPips).length;

  let verdict: ControlVerdict = "indistinguishable";
  if (strategy.winRate > highestWinRate) verdict = "above";
  else if (strategy.winRate < lowestWinRate) verdict = "below";

  return { verdict, lowestWinRate, highestWinRate, beatenBy, runs: controls.length };
}
