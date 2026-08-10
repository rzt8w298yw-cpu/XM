/**
 * 資産曲線と成績の質を見る指標の検証。
 *
 * 「損益+700pips」という1つの数字では、一定して積み上がったのか
 * 1回の大勝ちに支えられているのかが区別できない。ここはその区別を
 * つけるための計算を固定する。
 */
import { describe, expect, it } from "vitest";
import {
  buildEquityCurve,
  calculateConcentration,
  calculateStreaks,
  renderSparkline,
  splitByPeriod,
} from "../lib/equityCurve";
import type { Trade } from "../lib/backtest";

function trade(pips: number, exitTime = 0): Trade {
  return {
    direction: "BUY", entryTime: 0, entryPrice: 150, exitTime, exitPrice: 150,
    stopLoss: 149, takeProfit: 152, pips,
    exitReason: pips > 0 ? "take_profit" : "stop_loss",
    holdingBars: 1, confidence: 50, session: "LONDON",
  };
}

describe("buildEquityCurve", () => {
  it("開始点を含めて累積損益を積む", () => {
    const points = buildEquityCurve([trade(10), trade(-4), trade(6)]);
    expect(points.map((p) => p.equity)).toEqual([0, 10, 6, 12]);
    expect(points[0].time).toBeNull();
  });

  it("最高値とそこからの落ち込みを追う", () => {
    const points = buildEquityCurve([trade(10), trade(-4), trade(-3)]);
    expect(points.map((p) => p.peak)).toEqual([0, 10, 10, 10]);
    expect(points.map((p) => p.drawdown)).toEqual([0, 0, 4, 7]);
  });

  it("ドローダウンは負にならない", () => {
    const points = buildEquityCurve([trade(5), trade(5)]);
    expect(points.every((p) => p.drawdown >= 0)).toBe(true);
  });

  it("トレードが無ければ開始点だけ", () => {
    expect(buildEquityCurve([])).toHaveLength(1);
  });
});

describe("calculateStreaks", () => {
  it("最大の連勝と連敗を数える", () => {
    const trades = [10, 5, 3, -2, -4, -1, -5, 8].map((p) => trade(p));
    const streaks = calculateStreaks(trades);
    expect(streaks.longestWin).toBe(3);
    expect(streaks.longestLoss).toBe(4);
  });

  it("引き分けは負け扱い（勝ちの定義に合わせる）", () => {
    expect(calculateStreaks([trade(0), trade(0)]).longestLoss).toBe(2);
  });

  it("トレードが無ければ0", () => {
    expect(calculateStreaks([])).toEqual({ longestWin: 0, longestLoss: 0 });
  });
});

describe("calculateConcentration", () => {
  it("最大の勝ちが総利益に占める割合を出す", () => {
    // 総利益 100。最大は 60 なので60%
    const trades = [trade(60), trade(30), trade(10), trade(-20)];
    const result = calculateConcentration(trades);
    expect(result.topWinShare).toBeCloseTo(60, 6);
    expect(result.top3WinShare).toBeCloseTo(100, 6);
  });

  it("利益が分散していれば偏りは小さい", () => {
    const trades = Array.from({ length: 10 }, () => trade(10));
    expect(calculateConcentration(trades).topWinShare).toBeCloseTo(10, 6);
  });

  it("最大の負けを返す", () => {
    expect(calculateConcentration([trade(10), trade(-30), trade(-5)]).worstLoss).toBe(-30);
  });

  it("勝ちが無ければゼロ除算しない", () => {
    const result = calculateConcentration([trade(-10)]);
    expect(result.topWinShare).toBe(0);
    expect(result.worstLoss).toBe(-10);
  });
});

describe("splitByPeriod", () => {
  it("期間を等分して成績の偏りを見る", () => {
    // 前半は勝ち、後半は負け
    const trades = [10, 10, 10, 10, -5, -5, -5, -5].map((p) => trade(p));
    const segments = splitByPeriod(trades, 2);
    expect(segments).toHaveLength(2);
    expect(segments[0].netPips).toBe(40);
    expect(segments[0].winRate).toBe(100);
    expect(segments[1].netPips).toBe(-20);
    expect(segments[1].winRate).toBe(0);
  });

  it("割り切れなくても全件を含める", () => {
    const trades = Array.from({ length: 7 }, () => trade(1));
    const segments = splitByPeriod(trades, 3);
    expect(segments.reduce((sum, s) => sum + s.trades, 0)).toBe(7);
  });

  it("トレードが無ければ空", () => {
    expect(splitByPeriod([], 4)).toEqual([]);
  });
});

describe("renderSparkline", () => {
  it("指定した幅と高さで描く", () => {
    const points = buildEquityCurve([trade(10), trade(-5), trade(20)]);
    const rows = renderSparkline(points, 20, 5);
    expect(rows).toHaveLength(5);
    expect(rows.every((r) => r.length === 20)).toBe(true);
  });

  it("点が足りなければ描かない", () => {
    expect(renderSparkline(buildEquityCurve([]), 20, 5)).toEqual([]);
  });

  it("上昇し続ける曲線は右上がりに描かれる", () => {
    const points = buildEquityCurve(Array.from({ length: 20 }, () => trade(10)));
    const rows = renderSparkline(points, 20, 5);
    // 最上段は右端に、最下段は左端に点がある
    expect(rows[0].trimEnd().length).toBeGreaterThan(rows[0].trimStart().length === 0 ? 0 : 10);
    expect(rows[rows.length - 1].indexOf("●")).toBe(0);
  });
});
