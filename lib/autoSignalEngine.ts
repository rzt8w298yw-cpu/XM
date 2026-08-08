/**
 * 自動シグナル判定エンジン
 * 実際のチャートデータから13条件を全自動で判定してBUY/SELL/WAITシグナルを出す
 */
import {
  OHLC,
  calculateEMA,
  calculateRSI,
  calculateATR,
  analyzeMarketStructure,
  detectSupportResistance,
  isNearSupportResistance,
  detectDivergence,
  detectCandlePattern,
  determineTrend,
  getEMADirection,
  isPullback,
  getCurrentTimeSession,
  getTimeSessionFromTimestamp,
  getTimeSessionReliability,
  getATRStatus,
  isSpreadNormal,
  calculateBollingerBands,
  analyzeBollingerBands,
  calculateMACD,
  analyzeMACDSignal,
  analyzeBBMACDCombo,
  type TrendDirection,
  type MarketStructure,
  type ATRStatus,
  type DivergenceType,
  type CandlePattern,
  type SupportResistance,
  type TimeSession,
  type BollingerBands,
  type MACDResult,
  type BBSignal,
  type MACDSignal,
} from "./technicalAnalysis";

/**
 * 1H足データを8H足に集約
 */
function aggregate1HTo8H(candles1H: OHLC[]): OHLC[] {
  const result: OHLC[] = [];
  for (let i = 0; i < candles1H.length - 7; i += 8) {
    const chunk = candles1H.slice(i, i + 8);
    result.push({
      timestamp: chunk[0].timestamp,
      open: chunk[0].open,
      high: Math.max(...chunk.map(c => c.high)),
      low: Math.min(...chunk.map(c => c.low)),
      close: chunk[chunk.length - 1].close,
    });
  }
  return result;
}

export type SignalType = "BUY" | "SELL" | "WAIT";

export interface ConditionResult {
  id: string;
  name: string;
  category: "trend" | "entry" | "confirmation" | "filter";
  met: boolean;
  value: string;
  weight: number; // 重要度 1-3
}

export interface ChartDataPoint {
  time: string; // ISO timestamp
  close: number;
  ema20: number;
  ema200: number;
  rsi: number;
  atr: number;
}

export interface SignalResult {
  signal: SignalType;
  confidence: number; // 0-100
  conditions: ConditionResult[];
  analysis: {
    trend1H: TrendDirection;
    trend4H: TrendDirection;
    trendDaily: TrendDirection;
    marketStructure: MarketStructure;
    currentRSI: number;
    currentATR: number;
    atrStatus: ATRStatus;
    divergence: DivergenceType;
    candlePattern: CandlePattern;
    supportResistanceLevels: SupportResistance[];
    nearSR: boolean;
    timeSession: TimeSession;
    timeReliability: number;
    ema20: number;
    ema200: number;
    currentPrice: number;
    // BB + MACD追加
    bollingerBands: BollingerBands | null;
    bbSignal: BBSignal;
    macd: MACDResult | null;
    macdSignal: MACDSignal;
    bbMacdComboDirection: "BUY" | "SELL" | "NEUTRAL";
    bbMacdComboConfidence: number;
    bbMacdComboReason: string;
    // MTFフィルター状態
    mtfFilter: {
      macd4H: { histogram: number; histogramPrev: number; pass: boolean; direction: "rising" | "falling" | "neutral" };
      trend8H: { price: number; ema20: number; ema20Direction: string; pass: boolean; direction: "up" | "down" | "neutral" };
      buyPass: boolean;
      sellPass: boolean;
    };
  };
  chartData: ChartDataPoint[]; // 直近30本のチャートデータ
  timestamp: number;
}

/**
 * マルチタイムフレームのデータからシグナルを自動判定
 */
export function generateSignal(
  candles1H: OHLC[],
  candles4H: OHLC[],
  candlesDaily: OHLC[],
  candles8H?: OHLC[],
  options?: { overrideTimestamp?: number }
): SignalResult {
  // === テクニカル指標の計算 ===
  const closes1H = candles1H.map(c => c.close);
  const closes4H = candles4H.map(c => c.close);
  const closesDaily = candlesDaily.map(c => c.close);

  // 8H足: 渡されなければ1H足から生成
  const effective8H = candles8H && candles8H.length > 0 ? candles8H : aggregate1HTo8H(candles1H);
  const closes8H = effective8H.map(c => c.close);

  // EMA計算
  const ema20_1H = calculateEMA(closes1H, 20);
  const ema200_1H = calculateEMA(closes1H, 200);
  const ema20_4H = calculateEMA(closes4H, 20);
  const ema200_4H = calculateEMA(closes4H, 200);
  const ema20_Daily = calculateEMA(closesDaily, 20);
  const ema200_Daily = calculateEMA(closesDaily, 200);
  const ema20_8H = calculateEMA(closes8H, 20);

  // RSI計算
  const rsi1H = calculateRSI(closes1H, 14);

  // ATR計算
  const atr1H = calculateATR(candles1H, 14);

  // 現在値
  const currentPrice = closes1H[closes1H.length - 1];
  const currentEma20 = ema20_1H.length > 0 ? ema20_1H[ema20_1H.length - 1] : currentPrice;
  const currentEma200 = ema200_1H.length > 0 ? ema200_1H[ema200_1H.length - 1] : currentPrice;
  const currentRSI = rsi1H.length > 0 ? rsi1H[rsi1H.length - 1] : 50;
  const currentATR = atr1H.length > 0 ? atr1H[atr1H.length - 1] : 0;

  // === トレンド判定 ===
  const trend1H = determineTrend(closes1H, ema20_1H, ema200_1H);
  const trend4H = determineTrend(closes4H, ema20_4H, ema200_4H);
  const trendDaily = determineTrend(closesDaily, ema20_Daily, ema200_Daily);

  // === ダウ理論 ===
  const marketStructure = analyzeMarketStructure(candles1H);

  // === サポレジ ===
  const srLevels = detectSupportResistance(candles1H);
  const srCheck = isNearSupportResistance(currentPrice, srLevels, 0.0015);

  // === ダイバージェンス ===
  const divergence = detectDivergence(closes1H, rsi1H, 20);

  // === ローソク足パターン ===
  const candlePattern = detectCandlePattern(candles1H);

  // === ATRステータス ===
  const atrStatus = getATRStatus(atr1H, currentATR);

  // === 時間帯 ===
  // バックテスト時はoverrideTimestampでセッション判定
  const timeSession = options?.overrideTimestamp
    ? getTimeSessionFromTimestamp(options.overrideTimestamp)
    : getCurrentTimeSession();
  const timeReliability = getTimeSessionReliability(timeSession);

  // === EMA方向 ===
  const ema20Direction = getEMADirection(ema20_1H, 5);

  // === 押し目/戻り目 ===
  const pullbackDetected = isPullback(currentPrice, currentEma20, currentEma200, trend1H, currentATR);

  // === スプレッド ===
  const spreadOk = isSpreadNormal(currentPrice);

  // ===== 13条件の判定 =====
  const conditions: ConditionResult[] = [];

  // --- トレンド確認 (3条件) ---
  // 1. 1Hトレンド確認
  conditions.push({
    id: "trend_1h",
    name: "1H トレンド確認",
    category: "trend",
    met: trend1H !== "FLAT",
    value: trend1H === "UP" ? "上昇トレンド" : trend1H === "DOWN" ? "下降トレンド" : "レンジ",
    weight: 3,
  });

  // 2. MTF整合性（最重要条件 - 重み5）
  const mtfAligned = (trend1H === trend4H) || (trend1H === trendDaily);
  const mtfStrong = (trend1H === trend4H) && (trend1H === trendDaily); // 全一致
  conditions.push({
    id: "mtf_alignment",
    name: "MTF整合性",
    category: "trend",
    met: mtfAligned,
    value: mtfStrong ? `全一致: ${trend1H}` : mtfAligned ? `1H=${trend1H}, 4H=${trend4H}` : `不一致: 1H=${trend1H}, 4H=${trend4H}, D=${trendDaily}`,
    weight: 5,
  });

  // 3. ダウ理論構造
  // トレンド方向と高値安値の切り上げ/切り下げが一致している場合のみ成立。
  // 逆行している構造（上昇トレンド中の切り下げなど）は加点しない。
  const structureAligned = (trend1H === "UP" && marketStructure === "UPTREND") ||
                           (trend1H === "DOWN" && marketStructure === "DOWNTREND");
  conditions.push({
    id: "market_structure",
    name: "ダウ理論構造",
    category: "trend",
    met: structureAligned,
    value: marketStructure === "UPTREND" ? "高値安値切り上げ" : marketStructure === "DOWNTREND" ? "高値安値切り下げ" : "レンジ",
    weight: 2,
  });

  // --- エントリー条件 (3条件) ---
  // 4. 20EMA方向
  const emaDirectionOk = (trend1H === "UP" && ema20Direction === "rising") ||
                         (trend1H === "DOWN" && ema20Direction === "falling");
  conditions.push({
    id: "ema20dir",
    name: "20EMA方向",
    category: "entry",
    met: emaDirectionOk,
    value: ema20Direction === "rising" ? "上向き" : ema20Direction === "falling" ? "下向き" : "横ばい",
    weight: 2,
  });

  // 5. 押し目/戻り目（高的中率条件 - 重み4）
  conditions.push({
    id: "pullback",
    name: "押し目/戻り目",
    category: "entry",
    met: pullbackDetected,
    value: pullbackDetected ? "EMA付近に引きつけ確認" : "EMAから離れている",
    weight: 4,
  });

  // 6. サポレジ確認（高的中率条件 - 重み4）
  conditions.push({
    id: "support_resistance",
    name: "サポレジ確認",
    category: "entry",
    met: srCheck.near,
    value: srCheck.near ? `${srCheck.level!.type === "support" ? "サポート" : "レジスタンス"}付近 (強度${srCheck.level!.strength})` : "サポレジから離れている",
    weight: 4,
  });

  // --- 確認シグナル (3条件) ---
  // 7. RSI水準（ロンドン時間は厳格化: BUY 45-65, SELL 35-55）
  const isLondonSession = timeSession === "LONDON";
  const rsiOk = isLondonSession
    ? (trend1H === "UP" && currentRSI >= 45 && currentRSI <= 65) ||
      (trend1H === "DOWN" && currentRSI <= 55 && currentRSI >= 35) ||
      (currentRSI <= 30 || currentRSI >= 70)
    : (trend1H === "UP" && currentRSI >= 40 && currentRSI <= 70) ||
      (trend1H === "DOWN" && currentRSI <= 60 && currentRSI >= 30) ||
      (currentRSI <= 30 || currentRSI >= 70);
  conditions.push({
    id: "rsi",
    name: "RSI水準",
    category: "confirmation",
    met: rsiOk,
    value: `RSI: ${currentRSI.toFixed(1)}`,
    weight: 2,
  });

  // 8. ダイバージェンス
  // ダイバージェンスは反転指標なので、トレンドと同じ向きのものはほとんど出現しない
  // （計測では相場付きによらず0.2〜0.7%）。順張り一致を成立条件にすると条件が死ぬため、
  // 「トレンドに逆行するダイバージェンスが出ていないこと」を成立条件とする。
  // 上昇トレンド中のベアリッシュ・ダイバージェンスは天井警戒シグナルなので不成立にする。
  const divergenceOpposing = (trend1H === "UP" && divergence === "bearish") ||
                             (trend1H === "DOWN" && divergence === "bullish");
  const divergenceOk = !divergenceOpposing;
  conditions.push({
    id: "divergence",
    name: "ダイバージェンス",
    category: "confirmation",
    met: divergenceOk,
    value: divergence === "bullish" ? "ブリッシュ（買い示唆）" : divergence === "bearish" ? "ベアリッシュ（売り示唆）" : "なし",
    weight: 2,
  });

  // 9. 反転ローソク足（重要確認条件 - 重み4）
  const candleOk = (trend1H === "UP" && (candlePattern === "pin_bar_bull" || candlePattern === "engulfing_bull" || candlePattern === "morning_star")) ||
                   (trend1H === "DOWN" && (candlePattern === "pin_bar_bear" || candlePattern === "engulfing_bear" || candlePattern === "evening_star"));
  const candleLabel: Record<CandlePattern, string> = {
    pin_bar_bull: "ブルピンバー",
    pin_bar_bear: "ベアピンバー",
    engulfing_bull: "ブル包み足",
    engulfing_bear: "ベア包み足",
    morning_star: "明けの明星",
    evening_star: "宵の明星",
    none: "パターンなし",
  };
  conditions.push({
    id: "candle",
    name: "反転ローソク足",
    category: "confirmation",
    met: candleOk,
    value: candleLabel[candlePattern],
    weight: 4,
  });

  // --- フィルター (4条件) ---
  // 10. ボラティリティ（normalまたはhighでOK、lowのみNG）
  conditions.push({
    id: "atr_filter",
    name: "ボラティリティ",
    category: "filter",
    met: atrStatus !== "low",
    value: atrStatus === "low" ? "低すぎ（様子見）" : atrStatus === "high" ? "やや高い（注意）" : "適正",
    weight: 2,
  });

  // 11. 時間帯
  const timeOk = timeReliability >= 70;
  conditions.push({
    id: "time_filter",
    name: "時間帯",
    category: "filter",
    met: timeOk,
    value: `${timeSession} (信頼度${timeReliability}%)`,
    weight: 1,
  });

  // 12. 経済指標
  // リアルタイムカレンダーAPIは未接続のため、定期的な重要指標発表時間帯（JST）で推定。
  // 主要な重要指標発表時間（JST）: 21:30 米国雇用統計/CPI/GDP, 03:00 FOMC, 12:00 日銀
  const evalDate = new Date(options?.overrideTimestamp ?? Date.now());
  const jstHour = (evalDate.getUTCHours() + 9) % 24;
  const jstMinute = evalDate.getUTCMinutes();
  const totalMinutes = jstHour * 60 + jstMinute;
  // 重要指標発表前後30分は危険時間帯としてマーク
  const dangerWindows = [
    21 * 60 + 30, // 米国雇用統計/CPI/GDP
    3 * 60,       // FOMC
    12 * 60,      // 日銀
    22 * 60,      // ISM
  ];
  const nearIndicator = dangerWindows.some(w => Math.abs(totalMinutes - w) <= 30 || Math.abs(totalMinutes - w + 1440) <= 30);
  const economicOk = !nearIndicator;
  conditions.push({
    id: "economic_filter",
    name: "経済指標",
    category: "filter",
    met: economicOk,
    value: economicOk ? "指標発表なし（推定）" : "指標発表前後30分（注意）",
    weight: 3,
  });

  // 13. スプレッド
  conditions.push({
    id: "spread_filter",
    name: "スプレッド",
    category: "filter",
    met: spreadOk,
    value: spreadOk ? "通常範囲" : "拡大中（注意）",
    weight: 1,
  });

  // ===== BB + MACD 計算 =====
  const bb = calculateBollingerBands(closes1H);
  const bbAnalysis = analyzeBollingerBands(closes1H);
  const macd = calculateMACD(closes1H);
  const macdAnalysis = analyzeMACDSignal(closes1H);
  const bbMacdCombo = analyzeBBMACDCombo(closes1H);

  // 14. ボリンジャーバンド条件
  const bbConditionMet = (() => {
    if (!bb) return false;
    if (trend1H === "UP") return bb.percentB < 0.85; // 上バンド過熱でない
    if (trend1H === "DOWN") return bb.percentB > 0.15; // 下バンド過熱でない
    return true;
  })();
  conditions.push({
    id: "bollinger_bands",
    name: "ボリンジャーバンド",
    category: "confirmation",
    met: bbConditionMet,
    value: bb ? `%B: ${(bb.percentB * 100).toFixed(0)}% / 帯幅: ${(bb.bandwidth * 100).toFixed(2)}%` : "データ不足",
    weight: 3,
  });

  // 15. MACD条件
  const macdConditionMet = (() => {
    if (!macd) return false;
    if (trend1H === "UP") return macd.histogram > 0 || (macd.histogramPrev < 0 && macd.histogram >= 0);
    if (trend1H === "DOWN") return macd.histogram < 0 || (macd.histogramPrev > 0 && macd.histogram <= 0);
    return false;
  })();
  conditions.push({
    id: "macd",
    name: "MACD",
    category: "confirmation",
    met: macdConditionMet,
    value: macd ? `ヒストグラム: ${macd.histogram.toFixed(4)} / ${macdAnalysis.description}` : "データ不足",
    weight: 3,
  });

  // ===== シグナル判定 =====
  const trendConditions = conditions.filter(c => c.category === "trend");
  const entryConditions = conditions.filter(c => c.category === "entry");
  const confirmationConditions = conditions.filter(c => c.category === "confirmation");
  const filterConditions = conditions.filter(c => c.category === "filter");

  // === 改善版シグナル判定ロジック ===
  // 必須条件: トレンド条件のうち「1Hトレンド」と「MTF整合性」は必須
  const trend1HMet = trendConditions.find(c => c.id === "trend_1h")?.met ?? false;
  const mtfMet = trendConditions.find(c => c.id === "mtf_alignment")?.met ?? false;
  const coreConditionsMet = trend1HMet && mtfMet;

  // フィルター: 経済指標は必須、時間帯はボーナス
  const economicFilterOk = filterConditions.find(c => c.id === "economic_filter")?.met ?? true;

  // エントリー条件: 3つ中1つ以上（閾値を緩和してシグナル頻度を上げる）
  const entryMetCount = entryConditions.filter(c => c.met).length;
  const entryOk = entryMetCount >= 1;

  // 確認シグナル: 3つ中1つ以上
  const confirmMetCount = confirmationConditions.filter(c => c.met).length;
  const confirmOk = confirmMetCount >= 1;

  // シグナル決定（コア条件 + エントリー + 確認 + 経済指標）
  // ★BUY: 日足RANGE以上で発動（閾値65%）— 実データバックテストで最良結果
  // ★SELL A型: 完全逆転型（EMA下向き+RSI+MACD下降+BB+日足DOWN、閾値65%）
  let signal: SignalType = "WAIT";
  if (coreConditionsMet && entryOk && confirmOk && economicFilterOk) {
    if (trend1H === "UP" && trendDaily !== "DOWN") {
      signal = "BUY";
    }
  }

  // === SELL A型 判定（独立スコアリング — 改善案1: 閾値65%） ===
  // BUYの完全逆転条件: EMA20下向き + EMA200下抜け + RSI適正 + MACD下降加速 + BB下半分 + 日足DOWN + 戻り目
  // RSIフィルターで過売り排除を維持しつつ、閾値65%で頻度確保
  let sellScoreValue = 0; // SELL A型スコアを保持（信頼度表示用）
  if (signal === "WAIT" && economicFilterOk) {
    const sellScore = calculateSellScoreA(
      currentPrice, ema20_1H, ema200_1H, currentRSI, macd, bb, timeSession, trendDaily, candles1H
    );
    sellScoreValue = sellScore;
    if (sellScore >= 0.65) {
      signal = "SELL";
    }
  }

  // ===== MTFフィルター: 4H MACD + 8H トレンド =====
  // BUY: 4H MACD厳格(histogram > 0 かつ上昇中) AND 8H UP(price > EMA20 かつ EMA20上昇)
  // SELL: 4H MACD厳格(histogram < 0 かつ下降中) AND 8H DOWN(price < EMA20 かつ EMA20下降)
  const macd4H = calculateMACD(closes4H);
  const ema20_8HDir = getEMADirection(ema20_8H, 3);
  const current8HPrice = closes8H.length > 0 ? closes8H[closes8H.length - 1] : 0;
  const current8HEMA20 = ema20_8H.length > 0 ? ema20_8H[ema20_8H.length - 1] : 0;

  // BUY側MTF判定
  const macd4HBuyPass = macd4H !== null && macd4H.histogram > 0 && macd4H.histogram > macd4H.histogramPrev;
  const trend8HBuyPass = current8HPrice > current8HEMA20 && ema20_8HDir === "rising";
  const mtfBuyPass = macd4HBuyPass && trend8HBuyPass;

  // SELL側MTF判定
  const macd4HSellPass = macd4H !== null && macd4H.histogram < 0 && macd4H.histogram < macd4H.histogramPrev;
  const trend8HSellPass = current8HPrice < current8HEMA20 && ema20_8HDir === "falling";
  const mtfSellPass = macd4HSellPass && trend8HSellPass;

  // MTFフィルター状態オブジェクト（APIレスポンス用）
  const macd4HDirection: "rising" | "falling" | "neutral" = macd4H === null ? "neutral" :
    (macd4H.histogram > 0 && macd4H.histogram > macd4H.histogramPrev) ? "rising" :
    (macd4H.histogram < 0 && macd4H.histogram < macd4H.histogramPrev) ? "falling" : "neutral";
  const trend8HDirection: "up" | "down" | "neutral" =
    (current8HPrice > current8HEMA20 && ema20_8HDir === "rising") ? "up" :
    (current8HPrice < current8HEMA20 && ema20_8HDir === "falling") ? "down" : "neutral";

  const mtfFilterState = {
    macd4H: {
      histogram: macd4H?.histogram ?? 0,
      histogramPrev: macd4H?.histogramPrev ?? 0,
      pass: signal === "BUY" ? macd4HBuyPass : signal === "SELL" ? macd4HSellPass : false,
      direction: macd4HDirection,
    },
    trend8H: {
      price: current8HPrice,
      ema20: current8HEMA20,
      ema20Direction: ema20_8HDir,
      pass: signal === "BUY" ? trend8HBuyPass : signal === "SELL" ? trend8HSellPass : false,
      direction: trend8HDirection,
    },
    buyPass: mtfBuyPass,
    sellPass: mtfSellPass,
  };

  if (signal === "BUY" && !mtfBuyPass) {
    signal = "WAIT"; // 4H MACD厳格 AND 8H UPを満たさない場合はBUYを拒否
  }

  if (signal === "SELL" && !mtfSellPass) {
    signal = "WAIT"; // 4H MACD下降 AND 8H DOWNを満たさない場合はSELLを拒否
  }

  // ===== ロンドン+NY時間帯フィルター（改善案1: セッション拡大） =====
  // ロンドン(JST 16-21) または NY(JST 21-翌2) 以外はシグナルをWAITに変換
  if (signal !== "WAIT" && timeSession !== "LONDON" && timeSession !== "NY") {
    signal = "WAIT";
  }

  // ===== BUYスコアフィルター（改善案1: 閾値65%） =====
  // BUYのみ重み付きスコアでフィルタリング（SELLは独自スコアで判定済み）
  if (signal === "BUY") {
    const preFilterWeight = conditions.filter(c => c.met).reduce((sum, c) => sum + c.weight, 0);
    const totalWeightPre = conditions.reduce((sum, c) => sum + c.weight, 0);
    const weightedScoreRatio = preFilterWeight / totalWeightPre;
    if (weightedScoreRatio < 0.65) {
      signal = "WAIT"; // BUYスコア65%未満は除外（改善案1）
    }
  }

  // BUY過熱フィルター: BB上バンド超え or MACDデッドクロス直後は除外
  if (signal === "BUY" && macd && bb) {
    if (bb.percentB >= 0.95) signal = "WAIT"; // BB上バンド超え
    if (macd.histogramPrev > 0 && macd.histogram <= 0) signal = "WAIT"; // MACDデッドクロス直後
    if (macd.histogram < 0 && macd.histogram < macd.histogramPrev) signal = "WAIT"; // 下降モメンタム加速中
  }

  // SELL過売りフィルター: BB下バンド超え or MACDゴールデンクロス直後は除外
  if (signal === "SELL" && macd && bb) {
    if (bb.percentB <= 0.05) signal = "WAIT"; // BB下バンド超え（過売り）
    if (macd.histogramPrev < 0 && macd.histogram >= 0) signal = "WAIT"; // MACDゴールデンクロス直後
  }

  // ===== RSI追加フィルター（Filter E — 最適化結果） =====
  // BUY: RSI < 70（買われすぎでないことを確認）
  // SELL: RSI > 30（売られすぎでないことを確認）
  if (signal === "BUY" && currentRSI >= 70) {
    signal = "WAIT"; // RSI過熱 — BUY除外
  }
  if (signal === "SELL" && currentRSI <= 30) {
    signal = "WAIT"; // RSI過売り — SELL除外
  }

  // ===== 信頼度スコア計算 =====
  const totalWeight = conditions.reduce((sum, c) => sum + c.weight, 0);
  const metWeight = conditions.filter(c => c.met).reduce((sum, c) => sum + c.weight, 0);
  const baseScore = Math.round((metWeight / totalWeight) * 100);

  // 時間帯係数
  const timeFactor = timeReliability / 100;

  // ATR係数
  const atrFactor = atrStatus === "normal" ? 1.0 : atrStatus === "low" ? 0.6 : 0.8;

  // SELL A型の場合はsellScoreベースの信頼度を使用
  let confidence: number;
  if (signal === "SELL" && sellScoreValue > 0) {
    // SELL A型: sellScore(0-1) * 100 * 時間帯係数 * ATR係数
    confidence = Math.round(sellScoreValue * 100 * timeFactor * atrFactor);
  } else {
    confidence = Math.round(baseScore * timeFactor * atrFactor);
  }

  // === チャートデータの生成（直近30本） ===
  const chartLength = Math.min(30, closes1H.length);
  const startIdx = closes1H.length - chartLength;
  const chartData: ChartDataPoint[] = [];
  for (let i = startIdx; i < closes1H.length; i++) {
    const candleTime = candles1H[i]?.timestamp
      ? new Date(candles1H[i].timestamp).toISOString()
      : new Date(Date.now() - (closes1H.length - 1 - i) * 3600000).toISOString();
    chartData.push({
      time: candleTime,
      close: closes1H[i],
      ema20: ema20_1H[i] ?? closes1H[i],
      ema200: ema200_1H[i] ?? closes1H[i],
      rsi: rsi1H[i] ?? 50,
      atr: atr1H[i] ?? 0,
    });
  }

  return {
    signal,
    confidence: Math.min(confidence, 100),
    conditions,
    analysis: {
      trend1H,
      trend4H,
      trendDaily,
      marketStructure,
      currentRSI,
      currentATR,
      atrStatus,
      divergence,
      candlePattern,
      supportResistanceLevels: srLevels.slice(0, 5),
      nearSR: srCheck.near,
      timeSession,
      timeReliability,
      ema20: currentEma20,
      ema200: currentEma200,
      currentPrice,
      // BB + MACD
      bollingerBands: bb,
      bbSignal: bbAnalysis.signal,
      macd,
      macdSignal: macdAnalysis.signal,
      bbMacdComboDirection: bbMacdCombo.direction,
      bbMacdComboConfidence: bbMacdCombo.confidence,
      bbMacdComboReason: bbMacdCombo.reason,
      // MTFフィルター状態
      mtfFilter: mtfFilterState,
    },
    chartData,
    timestamp: Date.now(),
  };
}

/**
 * SELL A型 スコアリング関数
 * BUYの完全逆転条件で独立にスコアを計算
 * バックテスト実証: 閾値60%で65回、勝率69.2%、PF 2.21、+1103pips
 */
function calculateSellScoreA(
  currentPrice: number,
  ema20_1H: number[],
  ema200_1H: number[],
  currentRSI: number,
  macd: { histogram: number; histogramPrev: number } | null,
  bb: { percentB: number } | null,
  timeSession: TimeSession,
  trendDaily: TrendDirection,
  candles1H: OHLC[]
): number {
  const lastIdx = ema20_1H.length - 1;
  const prevIdx = lastIdx - 1;
  if (lastIdx < 1) return 0;

  const ema20 = ema20_1H[lastIdx];
  const ema20Prev = ema20_1H[prevIdx];
  const ema200 = ema200_1H[lastIdx];

  let score = 0;
  let maxScore = 0;

  // 1. EMA20下向き（価格 < EMA20 && EMA20下降中） - 重み3
  maxScore += 3;
  if (currentPrice < ema20 && ema20 < ema20Prev) score += 3;

  // 2. EMA200下抜け（価格 < EMA200） - 重み2
  maxScore += 2;
  if (currentPrice < ema200) score += 2;

  // 3. RSI適正帯（ロンドン: 35-55、NY: 30-60） - 重み2
  maxScore += 2;
  const isLondon = timeSession === "LONDON";
  if (isLondon) {
    if (currentRSI >= 35 && currentRSI <= 55) score += 2;
  } else {
    if (currentRSI >= 30 && currentRSI <= 60) score += 2;
  }

  // 4. MACD下降加速（ヒストグラム < 0 && 前回より下降） - 重み3
  maxScore += 3;
  if (macd && macd.histogram < 0 && macd.histogram < macd.histogramPrev) score += 3;

  // 5. BB下半分（percentB < 0.5 && > 0.05） - 重み2
  maxScore += 2;
  if (bb && bb.percentB < 0.5 && bb.percentB > 0.05) score += 2;

  // 6. 日足DOWN - 重み3
  maxScore += 3;
  if (trendDaily === "DOWN") score += 3;

  // 7. 戻り目（価格 < EMA20 && 価格 > 前回安値） - 重み1
  maxScore += 1;
  const prevLow = candles1H.length >= 2 ? candles1H[candles1H.length - 2]?.low : 0;
  if (currentPrice < ema20 && currentPrice > (prevLow || 0)) score += 1;

  return maxScore > 0 ? score / maxScore : 0;
}
