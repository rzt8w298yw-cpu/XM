/**
 * ミューテーションテスト
 *
 *   npm run mutate
 *   npm run mutate -- --filter backtest
 *
 * テストの件数は品質の証明にならない。コードにわざと小さなバグを入れて
 * テストが落ちるかを確かめ、**落ちなかったもの＝テストの穴**を洗い出す。
 *
 * 各ミューテーションは適用→テスト実行→復元の順で処理し、復元は必ず
 * finally で行う。中断されてもソースが書き換わったまま残らないよう、
 * 開始前にワーキングツリーが綺麗であることを確認する。
 */
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

interface Mutation {
  /** どの挙動を壊すのか */
  description: string;
  file: string;
  find: string;
  replace: string;
}

/**
 * 意味のある壊し方だけを並べる。
 * 「消しても誰も困らない」変更（等価ミューテーション）は避け、
 * 実際に損益や判定が変わる箇所を狙う。
 */
const MUTATIONS: Mutation[] = [
  // --- 決済ロジック（損益に直結） ---
  {
    description: "決済: 損切り判定の不等号を反転",
    file: "lib/backtest.ts",
    find: "direction === \"BUY\" ? candle.low <= stopLoss : candle.high >= stopLoss",
    replace: "direction === \"BUY\" ? candle.low < stopLoss : candle.high > stopLoss",
  },
  {
    description: "決済: 同一足で両側に触れた時に利確を優先（楽観側に倒す）",
    file: "lib/backtest.ts",
    find: "    if (hitStop) {\n      // 損切りは不利な方向に滑る。BUYなら想定より安く、SELLなら高く約定する\n      const filled = stopLoss - cfg.stopSlippagePips * cfg.pipSize * sign;\n      return buildTrade(direction, candles1H, entryIndex, j, entryPrice, filled, stopLoss, takeProfit, \"stop_loss\", confidence, cfg);\n    }\n    if (hitTarget) {",
    replace: "    if (hitTarget) {\n      return buildTrade(direction, candles1H, entryIndex, j, entryPrice, takeProfit, stopLoss, takeProfit, \"take_profit\", confidence, cfg);\n    }\n    if (hitStop) {\n      const filled = stopLoss - cfg.stopSlippagePips * cfg.pipSize * sign;\n      return buildTrade(direction, candles1H, entryIndex, j, entryPrice, filled, stopLoss, takeProfit, \"stop_loss\", confidence, cfg);\n    }\n    if (false) {",
  },
  {
    description: "決済: エントリーをシグナル足の終値にする（先読み）",
    file: "lib/backtest.ts",
    find: "const entryPrice = candles1H[entryIndex].open;",
    replace: "const entryPrice = candles1H[signalIndex].close;",
  },
  {
    description: "決済: スプレッドを差し引かない",
    file: "lib/backtest.ts",
    find: "pips: rawPips - cfg.spreadPips,",
    replace: "pips: rawPips,",
  },
  {
    description: "決済: 利確幅の計算からリスクリワードを落とす",
    file: "lib/backtest.ts",
    find: "const targetDistance = stopDistance * cfg.riskRewardRatio;",
    replace: "const targetDistance = stopDistance;",
  },
  // --- 集計（成績の見え方に直結） ---
  {
    description: "集計: 勝ちの判定を pips >= 0 にする（引き分けを勝ち扱い）",
    file: "lib/backtest.ts",
    find: "const wins = trades.filter((t) => t.pips > 0);\n  const losses = trades.filter((t) => t.pips <= 0);",
    replace: "const wins = trades.filter((t) => t.pips >= 0);\n  const losses = trades.filter((t) => t.pips < 0);",
  },
  {
    description: "集計: 最大ドローダウンを常に0にする",
    file: "lib/backtest.ts",
    find: "maxDrawdown = Math.max(maxDrawdown, peak - cumulative);",
    replace: "maxDrawdown = Math.max(maxDrawdown, 0);",
  },
  // --- 先読み防止 ---
  {
    description: "バックテスト: 未確定の日足も判定に渡す（先読み）",
    file: "lib/backtest.ts",
    find: "return candlesDaily.filter((d) => d.timestamp + DAY_MS <= atTime);",
    replace: "return candlesDaily.filter((d) => d.timestamp <= atTime);",
  },
  // --- 指標 ---
  {
    description: "EMA: 平滑化係数の分母をずらす",
    file: "lib/technicalAnalysis.ts",
    find: "const k = 2 / (period + 1);",
    replace: "const k = 2 / period;",
  },
  {
    description: "RSI: Wilder平滑を単純平均にする",
    file: "lib/technicalAnalysis.ts",
    find: "avgGain = (avgGain * (period - 1) + gain) / period;",
    replace: "avgGain = (avgGain + gain) / 2;",
  },
  {
    description: "ATR: TrueRangeから前日終値との比較を落とす",
    file: "lib/technicalAnalysis.ts",
    find: "    trueRanges[i] = Math.max(\n      c.high - c.low,\n      Math.abs(c.high - prevClose),\n      Math.abs(c.low - prevClose),\n    );",
    replace: "    trueRanges[i] = c.high - c.low;",
  },
  {
    description: "ボリンジャーバンド: 標準偏差の倍率を無視",
    file: "lib/technicalAnalysis.ts",
    find: "const upper = middle + sd * stdDevMultiplier;",
    replace: "const upper = middle + sd;",
  },
  {
    description: "セッション: ロンドンの開始を1時間ずらす",
    file: "lib/technicalAnalysis.ts",
    find: "if (jstHour >= 16 && jstHour < 21) return \"LONDON\";",
    replace: "if (jstHour >= 17 && jstHour < 21) return \"LONDON\";",
  },
  {
    description: "上位足集約: 絶対時刻ではなく先頭からの本数で区切る",
    file: "lib/marketData.ts",
    find: "const key = Math.floor(candle.timestamp / bucketMs) * bucketMs;",
    replace: "const key = Math.floor(candles1H.indexOf(candle) / factor) * bucketMs;",
  },
  // --- エンジンのゲート ---
  {
    description: "エンジン: 逆行ダイバージェンスを再び成立扱いにする",
    file: "lib/autoSignalEngine.ts",
    find: "const divergenceOk = !divergenceOpposing;",
    replace: "const divergenceOk = true;",
  },
  {
    description: "エンジン: セッションフィルターを無効化",
    file: "lib/autoSignalEngine.ts",
    find: "if (signal !== \"WAIT\" && timeSession !== \"LONDON\" && timeSession !== \"NY\") {",
    replace: "if (false) {",
  },
  {
    description: "エンジン: BUYのスコア閾値を無視",
    file: "lib/autoSignalEngine.ts",
    find: "if (weightedScoreRatio < thresholds.buyScoreMin) {",
    replace: "if (false) {",
  },
  {
    description: "エンジン: MTFフィルターを無効化（BUY側）",
    file: "lib/autoSignalEngine.ts",
    find: "if (signal === \"BUY\" && !mtfBuyPass) {",
    replace: "if (false) {",
  },
  // --- 資金管理 ---
  {
    description: "ロット: 刻みを切り捨てではなく切り上げる（リスク超過）",
    file: "lib/positionSizing.ts",
    find: "const steps = Math.floor(rawLots / lotStep.step);",
    replace: "const steps = Math.ceil(rawLots / lotStep.step);",
  },
  // --- 状態の永続化 ---
  {
    description: "状態保存: 原子的な書き込みをやめる",
    file: "lib/signalState.ts",
    find: "    writeFileSync(tmpPath, JSON.stringify(state, null, 2), \"utf8\");\n    renameSync(tmpPath, path);",
    replace: "    writeFileSync(path, JSON.stringify(state, null, 2), \"utf8\");",
  },
  // --- 通知 ---
  {
    description: "通知: 状態が変わらなくても毎回通知する",
    file: "lib/notifier.ts",
    find: "if (current === previousSignal) continue;",
    replace: "if (false) continue;",
  },
  // --- 未検証だった指標 ---
  {
    description: "ダウ理論: 高値切り上げの判定を反転",
    file: "lib/technicalAnalysis.ts",
    find: "  const higherHigh = h2.price > h1.price;",
    replace: "  const higherHigh = h2.price < h1.price;",
  },
  {
    description: "ダウ理論: スイング抽出の窓を無視して隣接足だけ見る",
    file: "lib/technicalAnalysis.ts",
    find: "  for (let i = window; i < candles.length - window; i++) {",
    replace: "  for (let i = 1; i < candles.length - 1; i++) {",
  },
  {
    description: "サポレジ: クラスタの許容幅を100倍に広げる",
    file: "lib/technicalAnalysis.ts",
    find: "    } else if (bandBottom > 0 && (swing.price - bandBottom) / bandBottom <= clusterTolerance) {",
    replace: "    } else if (bandBottom > 0 && (swing.price - bandBottom) / bandBottom <= clusterTolerance * 100) {",
  },
  {
    description: "サポレジ: 帯の下端ではなく直前の点から測る（連鎖を許す）",
    file: "lib/technicalAnalysis.ts",
    find: "      current.push(swing);\n    } else {\n      clusters.push(current);",
    replace: "      current.push(swing);\n      bandBottom = swing.price;\n    } else {\n      clusters.push(current);",
  },
  {
    description: "サポレジ: 価格順に並べずに検出順のまま帯を切る",
    file: "lib/technicalAnalysis.ts",
    find: "  const sorted = [...highs, ...lows].sort((a, b) => a.price - b.price);",
    replace: "  const sorted = [...highs, ...lows];",
  },
  {
    description: "サポレジ: 強度を訪問回数ではなくピボット本数にする",
    file: "lib/technicalAnalysis.ts",
    find: "        strength: countVisits(members, swingWindow * 2),",
    replace: "        strength: members.length,",
  },
  {
    description: "サポレジ: 別の訪問とみなす間隔を広げる",
    file: "lib/technicalAnalysis.ts",
    find: "    if (byTime[i].index - byTime[i - 1].index >= gapBars) visits++;",
    replace: "    if (byTime[i].index - byTime[i - 1].index >= gapBars * 4) visits++;",
  },
  {
    description: "サポレジ: サポートとレジスタンスの区別を逆にする",
    file: "lib/technicalAnalysis.ts",
    find: "        type: (price < currentPrice ? \"support\" : \"resistance\") as",
    replace: "        type: (price > currentPrice ? \"support\" : \"resistance\") as",
  },
  {
    description: "サポレジ近接: 許容幅の判定を常に真にする",
    file: "lib/technicalAnalysis.ts",
    find: "    if (distance <= tolerance && distance < bestDistance) {",
    replace: "    if (distance < bestDistance) {",
  },
  {
    description: "ダイバージェンス: 価格とRSIの比較方向を揃えてしまう",
    file: "lib/technicalAnalysis.ts",
    find: "  if (lowSecond.price < lowFirst.price && lowSecond.rsi > lowFirst.rsi) {",
    replace: "  if (lowSecond.price < lowFirst.price && lowSecond.rsi < lowFirst.rsi) {",
  },
  {
    description: "ローソク足: 包み足の実体の大小比較を落とす",
    file: "lib/technicalAnalysis.ts",
    find: "  if (isBear(c2) && isBull(c3) && c3.open <= c2.close && c3.close >= c2.open && c3Body > c2Body) {",
    replace: "  if (isBear(c2) && isBull(c3) && c3.open <= c2.close && c3.close >= c2.open) {",
  },
  {
    description: "ローソク足: ピンバーのヒゲの閾値を半分に緩める",
    file: "lib/technicalAnalysis.ts",
    find: "    if (lowerWick >= c3Range * 0.66) return \"pin_bar_bull\";",
    replace: "    if (lowerWick >= c3Range * 0.33) return \"pin_bar_bull\";",
  },
  {
    description: "押し目: EMAからの距離の判定をATR2倍に緩める",
    file: "lib/technicalAnalysis.ts",
    find: "  const nearEMA = distance <= atr;",
    replace: "  const nearEMA = distance <= atr * 2;",
  },
  {
    description: "押し目: 200EMAとの位置関係を無視する",
    file: "lib/technicalAnalysis.ts",
    find: "  if (trend === \"UP\") return nearEMA && price > ema200;",
    replace: "  if (trend === \"UP\") return nearEMA;",
  },
  {
    description: "ATR状態: 低ボラの閾値を判定しない",
    file: "lib/technicalAnalysis.ts",
    find: "  if (ratio < 0.7) return \"low\";",
    replace: "  if (ratio < 0.0) return \"low\";",
  },
  {
    description: "トレンド判定: 20EMAと200EMAの位置関係を落とす",
    file: "lib/technicalAnalysis.ts",
    find: "  if (price > e20 && e20 > e200 && dir20 !== \"falling\") return \"UP\";",
    replace: "  if (price > e20 && dir20 !== \"falling\") return \"UP\";",
  },
  {
    description: "EMA方向: 傾きの閾値を無視して符号だけで判定",
    file: "lib/technicalAnalysis.ts",
    find: "  const threshold = 0.0002;",
    replace: "  const threshold = 0;",
  },
  {
    description: "MACD: ヒストグラムの前回値を今回値と同じにする",
    file: "lib/technicalAnalysis.ts",
    find: "    histogramPrev: macdPrev - signalPrev,",
    replace: "    histogramPrev: macd - signal,",
  },
  // --- スコア計算 ---
  {
    description: "スコア: 評価できない条件も分母に数える",
    file: "lib/autoSignalEngine.ts",
    find: "    if (condition.available === false) continue;",
    replace: "    if (false) continue;",
  },
  {
    description: "スプレッド: 未取得でも評価済みとして扱う",
    file: "lib/technicalAnalysis.ts",
    find: "      available: false,\n      ok: false,\n      description: \"実スプレッド未取得（判定から除外）\",",
    replace: "      available: true,\n      ok: true,\n      description: \"実スプレッド未取得（判定から除外）\",",
  },
  {
    description: "スプレッド: 上限との比較を常に真にする",
    file: "lib/technicalAnalysis.ts",
    find: "  const ok = spreadPips <= maxSpreadPips;",
    replace: "  const ok = true;",
  },
  // --- 経済指標カレンダー ---
  {
    description: "カレンダー: 実予定があっても推定に落とす",
    file: "lib/economicCalendar.ts",
    find: "  if (events && events.length > 0) {",
    replace: "  if (false) {",
  },
  {
    description: "カレンダー: 発表前は避けず発表後だけ避ける",
    file: "lib/economicCalendar.ts",
    find: "    const near = events.find((e) => Math.abs(e.timestamp - atTime) <= windowMs);",
    replace: "    const near = events.find((e) => atTime - e.timestamp >= 0 && atTime - e.timestamp <= windowMs);",
  },
  {
    description: "カレンダー: 日付をまたぐ距離を見ない",
    file: "lib/economicCalendar.ts",
    find: "    if (Math.min(direct, wrapped) <= avoidMinutes) {",
    replace: "    if (direct <= avoidMinutes) {",
  },
  // --- ロット計算 ---
  {
    description: "ロット: 換算レート不明でも1として計算してしまう",
    file: "lib/lotPlan.ts",
    find: "  if (rate === undefined || !Number.isFinite(rate) || rate <= 0) {",
    replace: "  if (false) {",
  },
  {
    description: "ロット: 決済通貨と口座通貨の一致判定を常に真にする",
    file: "lib/lotPlan.ts",
    find: "  const sameCurrency = input.spec.quoteCurrency === accountCurrency;",
    replace: "  const sameCurrency = true;",
  },
  {
    description: "ロット: 残高未設定でも計算する",
    file: "lib/lotPlan.ts",
    find: "  if (input.accountBalance <= 0) return null;",
    replace: "  if (false) return null;",
  },
  // --- 資産曲線 ---
  {
    description: "資産曲線: 最高値の更新をしない（ドローダウンが常に0）",
    file: "lib/equityCurve.ts",
    find: "    if (equity > peak) peak = equity;",
    replace: "    peak = equity;",
  },
  {
    description: "連敗: 勝ちで連敗をリセットしない",
    file: "lib/equityCurve.ts",
    find: "      currentWin++;\n      currentLoss = 0;",
    replace: "      currentWin++;",
  },
  {
    description: "偏り: 勝ちの降順ソートをやめる（最大の勝ちを取り違える）",
    file: "lib/equityCurve.ts",
    find: "  const wins = trades.filter((t) => t.pips > 0).map((t) => t.pips).sort((a, b) => b - a);",
    replace: "  const wins = trades.filter((t) => t.pips > 0).map((t) => t.pips);",
  },
  // --- エントリー仮説 ---
  {
    description: "仮説: percentBを1本先の終値で計算する（未来を見る）",
    file: "lib/hypotheses.ts",
    find: "    percentB[i] = width === 0 ? 0.5 : (closes[i] - (mean - bbMult * sd)) / width;",
    replace:
      "    percentB[i] = width === 0 ? 0.5 : ((closes[i + 1] ?? closes[i]) - (mean - bbMult * sd)) / width;",
  },
  {
    description: "仮説: RSI反転を「またいだ足」ではなく水準で入る",
    file: "lib/hypotheses.ts",
    find: "    if (prev <= 30 && now > 30) return \"BUY\";",
    replace: "    if (now < 30) return \"BUY\";",
  },
  {
    description: "仮説: 素の順張りからEMA20の条件を落とす",
    file: "lib/hypotheses.ts",
    find: "    if (now > past && now > e) return \"BUY\";",
    replace: "    if (now > past) return \"BUY\";",
  },
  {
    description: "仮説: ロンドン開始のブレイクが時間帯を見なくなる",
    file: "lib/hypotheses.ts",
    find: "    if (hourUtc[i] !== 7) return null;",
    replace: "    if (hourUtc[i] === 24) return null;",
  },
  {
    description: "仮説: 東京仲値の戻りが順張りになる（向きを反転）",
    file: "lib/hypotheses.ts",
    find: "    return move > 0 ? \"SELL\" : \"BUY\";",
    replace: "    return move > 0 ? \"BUY\" : \"SELL\";",
  },
  {
    description: "仮説: 押し目買いの判定からRSIの条件を落とす",
    file: "lib/hypotheses.ts",
    find: "    if (price > e && r < 40) return \"BUY\";",
    replace: "    if (price > e) return \"BUY\";",
  },
  {
    description: "仮説: 検証範囲の下限を無視して集計する",
    file: "lib/hypotheses.ts",
    find: "  for (let i = Math.max(fromIndex, 250); i < Math.min(toIndex, ctx.candles.length - 1); i++) {",
    replace: "  for (let i = 250; i < Math.min(toIndex, ctx.candles.length - 1); i++) {",
  },
  {
    description: "仮説(日足): 20日ブレイクを19日で判定する",
    file: "lib/hypotheses.ts",
    find: "    const range = donchian(candles, i, 20);",
    replace: "    const range = donchian(candles, i, 19);",
  },
  {
    description: "仮説(日足): 移動平均クロスを水準判定にする",
    file: "lib/hypotheses.ts",
    find: "    if (fastPrev <= slowPrev && fast > slow) return \"BUY\";",
    replace: "    if (fast > slow) return \"BUY\";",
  },
  {
    description: "仮説(日足): 時系列モメンタムを毎日入り直す形にする",
    file: "lib/hypotheses.ts",
    find: "    if (prev <= 0 && now > 0) return \"BUY\";",
    replace: "    if (now > 0) return \"BUY\";",
  },
  {
    description: "仮説(日足): 短期逆張りから長期の方向の条件を落とす",
    file: "lib/hypotheses.ts",
    find: "    if (price > slow && r < 10) return \"BUY\";",
    replace: "    if (r < 10) return \"BUY\";",
  },
  {
    description: "仮説(日足): インサイドバーの判定を常に真にする",
    file: "lib/hypotheses.ts",
    find: "    const isInside = prev.high <= before.high && prev.low >= before.low;",
    replace: "    const isInside = true;",
  },
  {
    description: "仮説(日足): 月初の判定を翌足の日付から求める（先読み）",
    file: "lib/hypotheses.ts",
    find: "    if (month === prevMonth) return null;",
    replace: "    const nextMonth = candles[i + 1] ? new Date(candles[i + 1].timestamp).getUTCMonth() : month;\n    if (nextMonth === month) return null;",
  },
  // --- 月初の効果（標本の外での検証） ---
  {
    description: "月初: 判定を翌営業日の月から求める（先読み）",
    file: "lib/monthEffect.ts",
    find: "  return dates[i].slice(0, 7) !== dates[i - 1].slice(0, 7);",
    replace: "  return dates[i + 1] !== undefined && dates[i + 1].slice(0, 7) !== dates[i].slice(0, 7);",
  },
  {
    description: "月初: 前月と逆ではなく順方向に入る",
    file: "lib/monthEffect.ts",
    find: "    const sign = previousMove > 0 ? -1 : 1;",
    replace: "    const sign = previousMove > 0 ? 1 : -1;",
  },
  {
    description: "月初: リターンをばらつきで割らない（大きく動く通貨に引きずられる）",
    file: "lib/monthEffect.ts",
    find: "    const scaled = forward / (volatility * Math.sqrt(hold));",
    replace: "    const scaled = forward;",
  },
  {
    description: "月初: hold日後ではなく hold+5日後の値を使う（先読み）",
    file: "lib/monthEffect.ts",
    find: "    const forward = Math.log(values[i + hold] / values[i]);",
    replace: "    const forward = Math.log((values[i + hold + 5] ?? values[i + hold]) / values[i]);",
  },
  {
    description: "並べ替え検定: 向きを入れ替えず常に元のまま足す（p値が0になる）",
    file: "lib/monthEffect.ts",
    find: "    for (let i = 0; i < raw.length; i++) total += rand() < 0.5 ? raw[i] : -raw[i];",
    replace: "    for (let i = 0; i < raw.length; i++) total += raw[i];",
  },
  {
    description: "ばらつき: 標準偏差ではなく分散を返す",
    file: "lib/monthEffect.ts",
    find: "  return Math.sqrt(variance);\n}\n\n/** 前の営業日と月が変わっていれば",
    replace: "  return variance;\n}\n\n/** 前の営業日と月が変わっていれば",
  },
  {
    description: "決済: 時間決済を指定しても損切り・利確を使い続ける",
    file: "lib/backtest.ts",
    find: "  const useStops = cfg.useStops !== false;",
    replace: "  const useStops = true;",
  },
  // --- 勝つために必要な数字 ---
  {
    description: "必要的中率: コストを足さない（必要水準が低く見える）",
    file: "lib/edgeMath.ts",
    find: "  const requiredWinRate = ((stop + cost) / (target + stop)) * 100;",
    replace: "  const requiredWinRate = (stop / (target + stop)) * 100;",
  },
  {
    description: "必要的中率: 利確幅にリスクリワードを掛けない",
    file: "lib/edgeMath.ts",
    find: "  const target = stop * rr;",
    replace: "  const target = stop;",
  },
  {
    description: "必要件数: 二乗を取らない（必要件数が桁で小さくなる）",
    file: "lib/edgeMath.ts",
    find: "  const trades = Math.ceil((z / ratio) ** 2);",
    replace: "  const trades = Math.ceil(z / ratio);",
  },
  {
    description: "必要件数: 期待値がマイナスでも件数を返す",
    file: "lib/edgeMath.ts",
    find: "  if (!Number.isFinite(expectancyPips) || expectancyPips <= 0) {",
    replace: "  if (false) {",
  },
  {
    description: "破産: 賭け金を残高比ではなく固定にする",
    file: "lib/edgeMath.ts",
    find: "      const stake = balance * risk;",
    replace: "      const stake = risk;",
  },
  {
    description: "破産: 破産水準に触れても続行する",
    file: "lib/edgeMath.ts",
    find: "      if (balance <= ruinLevel) {",
    replace: "      if (false) {",
  },
  {
    description: "破産: 期待値の計算からリスクリワードを落とす",
    file: "lib/edgeMath.ts",
    find: "  const edgePerTrade = p * risk * input.riskRewardRatio - (1 - p) * risk;",
    replace: "  const edgePerTrade = p * risk - (1 - p) * risk;",
  },
  // `maxSafeRiskPercent` の break を continue にする変更は入れていない。
  // 破産確率はリスク割合に対して単調に上がるので、打ち切っても最後まで
  // 見ても答えが変わらない（400通りの種で探しても差が出なかった）。
  // 何も検証しないミューテーションは、通っても落ちても意味が無い。
  {
    description: "符号の監視: 直前の窓と比べず、常に反転なしとする",
    file: "lib/edgeMath.ts",
    find: "    Math.sign(latest.mean) !== Math.sign(previous.mean);",
    replace: "    false;",
  },
  {
    description: "実績判定: 損益分岐を下回っていても件数の話にする",
    file: "lib/edgeMath.ts",
    find: "  if (expectancyPips <= 0 || (Number.isFinite(requiredWinRate) && winRate < requiredWinRate)) {",
    replace: "  if (false) {",
  },
  {
    description: "実績判定: 件数が足りなくても「基準を超えている」と言う",
    file: "lib/edgeMath.ts",
    find: "  } else if (trades < tradesNeeded) {",
    replace: "  } else if (false) {",
  },
  {
    description: "実績判定: 損益分岐を想定のRRで出す（実測の幅を使わない）",
    file: "lib/edgeMath.ts",
    find: "          stopDistancePips: avgLossPips,\n          riskRewardRatio: avgWinPips / avgLossPips,",
    replace: "          stopDistancePips: avgLossPips,\n          riskRewardRatio: 2,",
  },
  // --- CSV ---
  {
    description: "CSV: 空セルを0として受け入れる",
    file: "lib/csv.ts",
    find: "if (raw === undefined || raw === \"\") return null;",
    replace: "if (raw === undefined) return null;",
  },
];

function isWorkingTreeClean(): boolean {
  const status = execSync("git status --porcelain", { encoding: "utf8" });
  return status.trim() === "";
}

function runTests(): boolean {
  try {
    execSync("npx vitest run --silent", { stdio: "pipe", encoding: "utf8" });
    return true; // 通った = ミューテーションを検出できなかった
  } catch {
    return false; // 落ちた = 検出できた
  }
}

function main() {
  const filterArg = process.argv.indexOf("--filter");
  const filter = filterArg !== -1 ? process.argv[filterArg + 1] : null;

  if (!isWorkingTreeClean()) {
    console.error(
      "ワーキングツリーに変更があります。ミューテーションはソースを一時的に書き換えるため、",
    );
    console.error("先にコミットするか退避してから実行してください。");
    process.exit(1);
  }

  const targets = filter
    ? MUTATIONS.filter((m) => m.file.includes(filter) || m.description.includes(filter))
    : MUTATIONS;

  if (targets.length === 0) {
    console.error(`--filter "${filter}" に合致するミューテーションがありません`);
    process.exit(1);
  }

  console.log(`${targets.length}件のミューテーションを試します。`);
  console.log("落ちなかったもの＝テストの穴です。\n");

  const survivors: Mutation[] = [];
  // リファクタで対象の文字列が変わると、そのミューテーションは何も検証しない。
  // 黙って通ると「守られている」と誤解するので、見失いは失敗として扱う。
  const unapplied: Mutation[] = [];
  let killed = 0;

  targets.forEach((mutation, index) => {
    const original = readFileSync(mutation.file, "utf8");
    const occurrences = original.split(mutation.find).length - 1;

    if (occurrences !== 1) {
      unapplied.push(mutation);
      console.log(
        `  [${index + 1}/${targets.length}] ⚠ 適用できません（該当${occurrences}箇所）: ${mutation.description}`,
      );
      return;
    }

    try {
      writeFileSync(mutation.file, original.replace(mutation.find, mutation.replace), "utf8");
      const passed = runTests();

      if (passed) {
        survivors.push(mutation);
        console.log(`  [${index + 1}/${targets.length}] ✗ 生存: ${mutation.description}`);
      } else {
        killed++;
        console.log(`  [${index + 1}/${targets.length}] ✓ 検出: ${mutation.description}`);
      }
    } finally {
      // 何があっても必ず元に戻す
      writeFileSync(mutation.file, original, "utf8");
    }
  });

  console.log("");
  console.log("=".repeat(70));
  console.log(
    `検出 ${killed} / 生存 ${survivors.length}` +
      (unapplied.length > 0 ? ` / 適用不可 ${unapplied.length}` : ""),
  );
  console.log("=".repeat(70));

  if (unapplied.length > 0) {
    console.log("\n対象の文字列が見つからず、何も検証できなかったもの:");
    for (const mutation of unapplied) {
      console.log(`  - ${mutation.description}`);
      console.log(`    ${mutation.file}`);
    }
    console.log("\nコードの変更に追随できていません。定義を更新してください。");
  }

  if (survivors.length > 0) {
    console.log("\nテストが見逃した変更:");
    for (const survivor of survivors) {
      console.log(`  - ${survivor.description}`);
      console.log(`    ${survivor.file}`);
    }
    console.log("\nこれらはバグを入れてもテストが通る箇所です。");
  }

  if (!isWorkingTreeClean()) {
    console.error("\n⚠ ワーキングツリーが元に戻っていません。git status を確認してください。");
    process.exit(1);
  }

  process.exit(survivors.length > 0 || unapplied.length > 0 ? 1 : 0);
}

main();
