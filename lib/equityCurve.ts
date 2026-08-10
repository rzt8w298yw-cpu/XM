/**
 * 資産曲線とドローダウン
 *
 * 「損益+700pips」という1つの数字だけでは、成績の質は判断できない。
 * 前半で稼いで後半は崩れているのか、一定して積み上がっているのか、
 * 一度の大勝ちに支えられているのかで意味がまったく違う。
 *
 * ここではトレード列から資産曲線とドローダウンの推移を作り、
 * それらを見分けるための指標も出す。
 */
import type { Trade } from "./backtest";

export interface EquityPoint {
  /** 何トレード目か（0は開始時点） */
  index: number;
  /** 決済時刻。開始時点はnull */
  time: number | null;
  /** 累積損益（pips） */
  equity: number;
  /** その時点までの最高値 */
  peak: number;
  /** 最高値からの落ち込み（pips、0以上） */
  drawdown: number;
}

export function buildEquityCurve(trades: Trade[]): EquityPoint[] {
  const points: EquityPoint[] = [
    { index: 0, time: null, equity: 0, peak: 0, drawdown: 0 },
  ];

  let equity = 0;
  let peak = 0;

  trades.forEach((trade, i) => {
    equity += trade.pips;
    if (equity > peak) peak = equity;
    points.push({
      index: i + 1,
      time: trade.exitTime,
      equity,
      peak,
      drawdown: peak - equity,
    });
  });

  return points;
}

export interface StreakStats {
  /** 連勝の最大 */
  longestWin: number;
  /** 連敗の最大 */
  longestLoss: number;
}

export function calculateStreaks(trades: Trade[]): StreakStats {
  let longestWin = 0;
  let longestLoss = 0;
  let currentWin = 0;
  let currentLoss = 0;

  for (const trade of trades) {
    if (trade.pips > 0) {
      currentWin++;
      currentLoss = 0;
      if (currentWin > longestWin) longestWin = currentWin;
    } else {
      currentLoss++;
      currentWin = 0;
      if (currentLoss > longestLoss) longestLoss = currentLoss;
    }
  }

  return { longestWin, longestLoss };
}

export interface ConcentrationStats {
  /** 最大の勝ちトレードが総利益に占める割合（%） */
  topWinShare: number;
  /** 上位3件の勝ちが総利益に占める割合（%） */
  top3WinShare: number;
  /** 最大の負けトレード（pips、負の値） */
  worstLoss: number;
}

/**
 * 利益が一部のトレードに偏っていないかを見る。
 *
 * 総利益の大半を1〜2回の大勝ちが占めている場合、その相場が来なければ
 * 成立しない戦略ということになる。平均や合計だけでは見えない。
 */
export function calculateConcentration(trades: Trade[]): ConcentrationStats {
  const wins = trades.filter((t) => t.pips > 0).map((t) => t.pips).sort((a, b) => b - a);
  const grossProfit = wins.reduce((sum, p) => sum + p, 0);
  const losses = trades.filter((t) => t.pips <= 0).map((t) => t.pips);

  const share = (n: number) =>
    grossProfit === 0 ? 0 : (wins.slice(0, n).reduce((s, p) => s + p, 0) / grossProfit) * 100;

  return {
    topWinShare: share(1),
    top3WinShare: share(3),
    worstLoss: losses.length === 0 ? 0 : Math.min(...losses),
  };
}

/**
 * 期間を等分して、成績が期間によって偏っていないかを見る。
 * 前半だけで稼いで後半は崩れている、といった形が見える。
 */
export function splitByPeriod(
  trades: Trade[],
  segments = 4,
): { label: string; trades: number; netPips: number; winRate: number }[] {
  if (trades.length === 0 || segments < 1) return [];

  const perSegment = Math.ceil(trades.length / segments);
  const result: { label: string; trades: number; netPips: number; winRate: number }[] = [];

  for (let i = 0; i < segments; i++) {
    const slice = trades.slice(i * perSegment, (i + 1) * perSegment);
    if (slice.length === 0) continue;

    const wins = slice.filter((t) => t.pips > 0).length;
    result.push({
      label: `${i * perSegment + 1}〜${i * perSegment + slice.length}件目`,
      trades: slice.length,
      netPips: slice.reduce((sum, t) => sum + t.pips, 0),
      winRate: (wins / slice.length) * 100,
    });
  }

  return result;
}

/**
 * 資産曲線を端末に描く（縦軸は自動スケール）。
 * グラフを別途開かなくても形が分かるようにするため。
 */
export function renderSparkline(points: EquityPoint[], width = 60, height = 8): string[] {
  if (points.length < 2) return [];

  const values = points.map((p) => p.equity);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;

  // 横方向に間引く
  const sampled: number[] = [];
  for (let x = 0; x < width; x++) {
    const index = Math.round((x / (width - 1)) * (points.length - 1));
    sampled.push(values[index]);
  }

  const rows: string[] = [];
  for (let row = 0; row < height; row++) {
    // 上の行ほど高い値
    const upper = max - (row / height) * span;
    const lower = max - ((row + 1) / height) * span;
    let line = "";
    for (const value of sampled) {
      if (value >= lower && value <= upper) line += "●";
      else if (row === height - 1 && value < lower) line += "●";
      else line += " ";
    }
    rows.push(line);
  }
  return rows;
}
