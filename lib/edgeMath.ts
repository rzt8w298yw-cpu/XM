/**
 * 勝つために必要な数字を、予測せずに出す
 *
 * このリポジトリの検証で分かったのは「価格から方向は当てられなかった」
 * ことだった。当てられないなら、当てにいかないところで勝負を決めるしかない。
 *
 * ここにあるのは予測を1つも含まない4つの計算で、どれも当たり外れが無い。
 *
 *   1. 必要的中率   … あなたのコストで、損益が±0になる的中率
 *   2. 必要件数     … 「運ではない」と言うのに要るトレード数
 *   3. 破産確率     … その枚数で口座がどこまで減りうるか
 *   4. 符号の監視   … 効いていた向きが変わっていないか
 *
 * 1と2は、ほとんどの手法が最初から成立していないことを示す。
 * 3は、成立していても枚数で壊れることを示す。
 * どちらも予測より確かで、どちらも普通のツールが出してくれない。
 */

// ============================================================
// 1. 必要的中率
// ============================================================

export interface RequiredAccuracyInput {
  /** 損切りまでの距離（pips） */
  stopDistancePips: number;
  /** 利確幅 ÷ 損切り幅 */
  riskRewardRatio: number;
  /** 往復のコスト（pips）。スプレッド + 滑り */
  costPips: number;
}

export interface RequiredAccuracy {
  /** コストが無いとした場合の損益分岐的中率（%） */
  idealWinRate: number;
  /** 実際のコストを踏まえた損益分岐的中率（%） */
  requiredWinRate: number;
  /** コストが押し上げたぶん（ポイント） */
  costPenalty: number;
  /** 損切り幅に対するコストの比率（%） */
  costAsShareOfStop: number;
  warnings: string[];
}

/**
 * 損益が±0になる的中率を求める。
 *
 *   勝ち: +利確幅 - コスト
 *   負け: -損切り幅 - コスト
 *   期待値0 →  p = (損切り幅 + コスト) / (利確幅 + 損切り幅)
 *
 * コストが損切り幅に対して大きいほど、必要な的中率が跳ね上がる。
 * 1時間足でATRが10 pipsしかない場面に往復2 pips払うのが厳しいのは、
 * 勘の問題ではなくこの式の問題。
 */
export function requiredAccuracy(input: RequiredAccuracyInput): RequiredAccuracy {
  const { stopDistancePips: stop, riskRewardRatio: rr, costPips: cost } = input;
  const warnings: string[] = [];

  if (!Number.isFinite(stop) || stop <= 0 || !Number.isFinite(rr) || rr <= 0 ||
      !Number.isFinite(cost) || cost < 0) {
    return {
      idealWinRate: NaN, requiredWinRate: NaN, costPenalty: NaN, costAsShareOfStop: NaN,
      warnings: ["損切り幅とリスクリワードは正の数、コストは0以上である必要があります"],
    };
  }

  const target = stop * rr;
  const idealWinRate = (stop / (target + stop)) * 100;
  const requiredWinRate = ((stop + cost) / (target + stop)) * 100;
  const costAsShareOfStop = (cost / stop) * 100;

  if (requiredWinRate >= 100) {
    warnings.push(
      "コストが大きすぎて、全勝しても損益が±0に届きません。" +
        "損切りを広げるか、コストの安い銘柄・時間足にしてください",
    );
  } else if (requiredWinRate > 60) {
    warnings.push(
      `損益分岐に必要な的中率が ${requiredWinRate.toFixed(1)}% です。` +
        "実データで確認できた的中率がこれを超えていない限り、期待値はマイナスです",
    );
  }
  if (costAsShareOfStop > 10) {
    warnings.push(
      `コストが損切り幅の ${costAsShareOfStop.toFixed(1)}% を占めます。` +
        "損切りを広げるか、上位足に移すとこの比率は下がります",
    );
  }

  return {
    idealWinRate,
    requiredWinRate,
    costPenalty: requiredWinRate - idealWinRate,
    costAsShareOfStop,
    warnings,
  };
}

// ============================================================
// 2. 必要件数
// ============================================================

export interface TrackRecordInput {
  /** 1トレードあたりの平均損益（pips） */
  expectancyPips: number;
  /** 1トレードあたりの損益のばらつき（標準偏差、pips） */
  stdDevPips: number;
  /** 求める確からしさ。0.95 なら「運で説明できる確率5%未満」 */
  confidence?: number;
}

export interface TrackRecordNeed {
  /** 必要なトレード数 */
  trades: number;
  /** 1トレードあたりの情報比（期待値 ÷ ばらつき） */
  ratio: number;
  message: string;
}

/** 正規分布の上側確率に対応する値。よく使う水準だけ持つ */
const Z_SCORES: { confidence: number; z: number }[] = [
  { confidence: 0.90, z: 1.2816 },
  { confidence: 0.95, z: 1.6449 },
  { confidence: 0.99, z: 2.3263 },
];

export function zScoreFor(confidence: number): number {
  const found = Z_SCORES.find((entry) => Math.abs(entry.confidence - confidence) < 1e-9);
  if (!found) {
    throw new Error(
      `対応していない確からしさです: ${confidence}（${Z_SCORES.map((e) => e.confidence).join(", ")} のいずれか）`,
    );
  }
  return found.z;
}

/**
 * 「運ではない」と言うのに必要なトレード数。
 *
 * 平均がゼロという前提が棄却できるまでに要る件数なので、
 *
 *   n ≧ ( z × ばらつき / 期待値 )²
 *
 * 期待値がばらつきに対して小さいほど、必要件数は二乗で増える。
 * 1トレードで平均+1 pips・ばらつき30 pipsなら、95%で言い切るのに
 * 2400件を超える。フォワードテスト20件で判断できないのはこのため。
 */
export function tradesNeededToConfirm(input: TrackRecordInput): TrackRecordNeed {
  const confidence = input.confidence ?? 0.95;
  const z = zScoreFor(confidence);
  const { expectancyPips, stdDevPips } = input;

  if (!Number.isFinite(stdDevPips) || stdDevPips <= 0) {
    return { trades: Infinity, ratio: NaN, message: "ばらつきが正の数ではありません" };
  }
  if (!Number.isFinite(expectancyPips) || expectancyPips <= 0) {
    return {
      trades: Infinity,
      ratio: Number.isFinite(expectancyPips) ? expectancyPips / stdDevPips : NaN,
      message: "期待値がプラスではないので、何件積んでも「勝てる」とは言えません",
    };
  }

  const ratio = expectancyPips / stdDevPips;
  const trades = Math.ceil((z / ratio) ** 2);
  return {
    trades,
    ratio,
    message:
      `1トレードあたり平均 ${expectancyPips.toFixed(2)} pips・ばらつき ${stdDevPips.toFixed(1)} pips なら、` +
      `運で説明できないと言うのに ${trades.toLocaleString("en-US")} 件が要ります`,
  };
}

// ============================================================
// 3. 破産確率
// ============================================================

export interface RuinInput {
  /** 的中率（%） */
  winRate: number;
  /** 利確幅 ÷ 損切り幅 */
  riskRewardRatio: number;
  /** 1トレードで賭ける残高の割合（%） */
  riskPercent: number;
  /** どこまで減ったら「終わり」とみなすか（残高の減少率、%） */
  ruinThresholdPercent: number;
  /** 何トレード先まで見るか */
  trades: number;
  /** 試行回数 */
  paths?: number;
  seed?: number;
}

export interface RuinResult {
  /** 破産水準に触れた試行の割合（%） */
  ruinProbability: number;
  /** 最終残高の中央値（開始を100とした値） */
  medianFinalBalance: number;
  /** 最大ドローダウンの中央値（%） */
  medianMaxDrawdown: number;
  /** 期待値がプラスかどうか（1トレードあたり、残高比） */
  edgePerTrade: number;
  warnings: string[];
}

function makeRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function median(values: number[]): number {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/**
 * 決まった割合を賭け続けたときに、どこまで減りうるかを数える。
 *
 * 式で閉じた形もあるが、前提を置くたびに現実から離れる。ここは素直に
 * 何千回も回して数える。種を固定してあるので結果は毎回同じになる。
 *
 * **期待値がプラスでも破産する。** 勝率40%・RR1:2・1回2%なら期待値は
 * プラスだが、連敗は必ず来る。的中率だけを見て枚数を決めると、
 * 「正しい手法で退場する」ことになる。
 */
export function simulateRuin(input: RuinInput): RuinResult {
  const paths = input.paths ?? 5000;
  const seed = input.seed ?? 12345;
  const warnings: string[] = [];

  const p = input.winRate / 100;
  const risk = input.riskPercent / 100;
  const ruinLevel = 1 - input.ruinThresholdPercent / 100;

  if (!(p >= 0 && p <= 1) || !(risk > 0 && risk < 1) ||
      !(input.riskRewardRatio > 0) || !(ruinLevel >= 0 && ruinLevel < 1) ||
      !Number.isFinite(input.trades) || input.trades < 1) {
    return {
      ruinProbability: NaN, medianFinalBalance: NaN, medianMaxDrawdown: NaN,
      edgePerTrade: NaN,
      warnings: ["的中率0〜100%・リスク割合0〜100%・破産水準0〜100%・件数1以上で指定してください"],
    };
  }

  // 1トレードあたりの、残高に対する期待変化
  const edgePerTrade = p * risk * input.riskRewardRatio - (1 - p) * risk;

  const rand = makeRandom(seed);
  let ruined = 0;
  const finals: number[] = [];
  const drawdowns: number[] = [];

  for (let path = 0; path < paths; path++) {
    let balance = 1;
    let peak = 1;
    let maxDrawdown = 0;
    let hitRuin = false;

    for (let t = 0; t < input.trades; t++) {
      // 残高に対する割合で賭ける（負けるほど賭け金も減る）
      const stake = balance * risk;
      balance += rand() < p ? stake * input.riskRewardRatio : -stake;

      if (balance > peak) peak = balance;
      const drawdown = (peak - balance) / peak;
      if (drawdown > maxDrawdown) maxDrawdown = drawdown;

      if (balance <= ruinLevel) {
        hitRuin = true;
        break;
      }
    }

    if (hitRuin) ruined++;
    finals.push(balance * 100);
    drawdowns.push(maxDrawdown * 100);
  }

  const ruinProbability = (ruined / paths) * 100;

  if (edgePerTrade <= 0) {
    warnings.push(
      "1トレードあたりの期待値がマイナスです。枚数を落としても、遅くなるだけで結末は変わりません",
    );
  }
  if (ruinProbability > 5) {
    warnings.push(
      `${input.trades}件のうちに残高が${input.ruinThresholdPercent}%減る確率が ` +
        `${ruinProbability.toFixed(1)}% あります。リスク割合を下げてください`,
    );
  }

  return {
    ruinProbability,
    medianFinalBalance: median(finals),
    medianMaxDrawdown: median(drawdowns),
    edgePerTrade,
    warnings,
  };
}

/**
 * 破産確率を目標以下に収めるリスク割合を探す。
 *
 * 「何%賭けてよいか」は感覚で決められがちだが、決めるべきなのは
 * 賭ける割合ではなく、許容する破産確率のほう。
 */
export function maxSafeRiskPercent(
  base: Omit<RuinInput, "riskPercent">,
  targetRuinPercent: number,
  candidates = [0.25, 0.5, 0.75, 1, 1.5, 2, 3, 5],
): { riskPercent: number | null; ruinProbability: number } {
  let best: { riskPercent: number; ruinProbability: number } | null = null;

  for (const riskPercent of [...candidates].sort((a, b) => a - b)) {
    const result = simulateRuin({ ...base, riskPercent });
    if (result.ruinProbability <= targetRuinPercent) {
      best = { riskPercent, ruinProbability: result.ruinProbability };
    } else {
      break; // リスクを上げれば破産確率は上がる一方なので、ここで打ち切る
    }
  }

  return best ?? { riskPercent: null, ruinProbability: NaN };
}

// ============================================================
// 4. 符号の監視
// ============================================================

export interface RegimeWindow {
  label: string;
  /** その窓での平均（プラスなら効いている向き） */
  mean: number;
  samples: number;
}

export interface RegimeStatus {
  windows: RegimeWindow[];
  /** 直近の窓の符号 */
  currentSign: 1 | -1 | 0;
  /** 直近の窓と、その1つ前で符号が違うか */
  flipped: boolean;
  message: string;
}

/**
 * 効いていた向きが変わっていないかを、窓をずらしながら見る。
 *
 * 月初の逆張りは1971〜2011年に -0.079、2012年以降に +0.13〜+0.20 と
 * **符号が入れ替わった**。しかも一度に反転したのではなく、55年かけて
 * 少しずつ動いた。だからこの種の効果は「見つけたら終わり」ではなく
 * 「効いている間だけ使い、変わったらやめる」ものになる。
 *
 * 変化を検知する道具が無ければ、やめる判断ができない。
 */
export function trackRegime(
  samples: { year: number; signedReturn: number }[],
  windowYears = 5,
): RegimeStatus {
  if (samples.length === 0) {
    return { windows: [], currentSign: 0, flipped: false, message: "データがありません" };
  }

  const years = samples.map((s) => s.year);
  const first = Math.min(...years);
  const last = Math.max(...years);

  const windows: RegimeWindow[] = [];
  for (let start = first; start <= last; start += windowYears) {
    const end = Math.min(start + windowYears - 1, last);
    const subset = samples.filter((s) => s.year >= start && s.year <= end);
    if (subset.length < 20) continue;
    windows.push({
      label: `${start}〜${end}`,
      mean: subset.reduce((sum, s) => sum + s.signedReturn, 0) / subset.length,
      samples: subset.length,
    });
  }

  if (windows.length === 0) {
    return { windows, currentSign: 0, flipped: false, message: "窓に足りる件数がありません" };
  }

  const latest = windows[windows.length - 1];
  const previous = windows.length >= 2 ? windows[windows.length - 2] : null;
  const currentSign = latest.mean > 0 ? 1 : latest.mean < 0 ? -1 : 0;
  const flipped =
    previous !== null && Math.sign(previous.mean) !== 0 &&
    Math.sign(latest.mean) !== Math.sign(previous.mean);

  let message: string;
  if (flipped) {
    message =
      `直近（${latest.label}）で符号が反転しています。` +
      `前の窓 ${previous!.mean.toFixed(3)} → 今 ${latest.mean.toFixed(3)}。使うのをやめる判断が要ります`;
  } else if (currentSign > 0) {
    message = `直近（${latest.label}）は ${latest.mean.toFixed(3)} で、効いている向きのままです`;
  } else {
    message = `直近（${latest.label}）は ${latest.mean.toFixed(3)} で、逆向きです`;
  }

  return { windows, currentSign, flipped, message };
}

// ============================================================
// 5. 実績の判定
// ============================================================

export type TrackRecordVerdict =
  | "件数不足"
  | "損益分岐を下回る"
  | "基準を超えている";

export interface TrackRecordJudgement {
  trades: number;
  winRate: number;
  /** 1トレードあたりの平均損益（pips） */
  expectancyPips: number;
  stdDevPips: number;
  /** 勝ちトレードの平均（pips） */
  avgWinPips: number;
  /** 負けトレードの平均（pips、正の数） */
  avgLossPips: number;
  /** 実測の決済条件で損益が±0になる的中率（%） */
  requiredWinRate: number;
  /** 「運ではない」と言うのに要る件数 */
  tradesNeeded: number;
  verdict: TrackRecordVerdict;
  message: string;
}

/**
 * 決着したトレードの損益から、その実績が何を言えるのかを判定する。
 *
 * フォワードテストの出力は「勝率」と「合計pips」で終わりがちだが、
 * その2つだけでは何も決まらない。決まるのは次の3つが揃ったとき。
 *
 *   - 実測の決済条件で、損益分岐の的中率がいくつか
 *   - 実測の的中率がそれを超えているか
 *   - 超えていたとして、それを言い切れるだけの件数があるか
 *
 * 3つ目が抜けると「20件やって勝ち越したから本物」になる。
 * ここでは3つを同時に見て、足りないものを名指しする。
 *
 * `pipsPerTrade` はコスト控除後の実現損益（バックテストと同じ形）。
 * `costPips` は損益分岐の計算に使う往復コスト。
 */
export function judgeTrackRecord(
  pipsPerTrade: number[],
  costPips: number,
): TrackRecordJudgement {
  const trades = pipsPerTrade.length;
  if (trades === 0) {
    return {
      trades: 0, winRate: 0, expectancyPips: 0, stdDevPips: 0,
      avgWinPips: 0, avgLossPips: 0, requiredWinRate: NaN, tradesNeeded: Infinity,
      verdict: "件数不足",
      message: "決着したトレードがありません",
    };
  }

  const wins = pipsPerTrade.filter((p) => p > 0);
  const losses = pipsPerTrade.filter((p) => p <= 0);
  const winRate = (wins.length / trades) * 100;
  const expectancyPips = pipsPerTrade.reduce((a, b) => a + b, 0) / trades;
  const variance =
    pipsPerTrade.reduce((s, p) => s + (p - expectancyPips) ** 2, 0) / trades;
  const stdDevPips = Math.sqrt(variance);

  const avgWinPips = wins.length === 0 ? 0 : wins.reduce((a, b) => a + b, 0) / wins.length;
  const avgLossPips =
    losses.length === 0 ? 0 : Math.abs(losses.reduce((a, b) => a + b, 0) / losses.length);

  // 実測の勝ち負けの幅で損益分岐を出す。想定の損切り利確ではなく、
  // 実際に起きた決済の形で測らないと、水準がずれる
  const requiredWinRate =
    avgWinPips > 0 && avgLossPips > 0
      ? requiredAccuracy({
          stopDistancePips: avgLossPips,
          riskRewardRatio: avgWinPips / avgLossPips,
          costPips,
        }).requiredWinRate
      : NaN;

  const need = tradesNeededToConfirm({ expectancyPips, stdDevPips });
  const tradesNeeded = need.trades;

  let verdict: TrackRecordVerdict;
  let message: string;

  if (expectancyPips <= 0 || (Number.isFinite(requiredWinRate) && winRate < requiredWinRate)) {
    verdict = "損益分岐を下回る";
    message =
      `的中率 ${winRate.toFixed(1)}% に対して、実測の決済条件での損益分岐は ` +
      `${Number.isFinite(requiredWinRate) ? requiredWinRate.toFixed(1) : "—"}% です。` +
      "件数を積んでも期待値はプラスになりません";
  } else if (trades < tradesNeeded) {
    verdict = "件数不足";
    message =
      `いまの成績なら「運ではない」と言うのに ${tradesNeeded.toLocaleString("en-US")} 件が要ります。` +
      `あと ${(tradesNeeded - trades).toLocaleString("en-US")} 件です。` +
      "ここで判断すると、勝っていても負けていても運を読んでいることになります";
  } else {
    verdict = "基準を超えている";
    message =
      `${trades} 件は、必要件数 ${tradesNeeded.toLocaleString("en-US")} 件を満たしています。` +
      `損益分岐 ${requiredWinRate.toFixed(1)}% に対して的中率 ${winRate.toFixed(1)}% です`;
  }

  return {
    trades, winRate, expectancyPips, stdDevPips,
    avgWinPips, avgLossPips, requiredWinRate, tradesNeeded,
    verdict, message,
  };
}
