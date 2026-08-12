import { describe, expect, it } from "vitest";
import { compareWithControl, type BacktestStats } from "../lib/backtest";

/** 判定に使うのは winRate と netPips だけなので、他は形を満たすだけ */
function stats(winRate: number, netPips: number): BacktestStats {
  const empty = { trades: 0, wins: 0, winRate: 0, netPips: 0, profitFactor: 0 };
  return {
    trades: 440,
    wins: 0,
    losses: 0,
    winRate,
    netPips,
    grossProfitPips: 0,
    grossLossPips: 0,
    profitFactor: 0,
    expectancyPips: 0,
    maxDrawdownPips: 0,
    averageHoldingBars: 0,
    byDirection: { BUY: empty, SELL: empty },
  };
}

describe("compareWithControl", () => {
  it("散らばりの中にあれば「区別がつかない」", () => {
    // 実データのドル円がこの形。戦略35.0%、ランダム28.9〜41.4%
    const result = compareWithControl(stats(35.0, 303.2), [
      stats(28.9, -1946.9),
      stats(41.4, 2327.6),
      stats(33.0, -678.3),
    ]);
    expect(result.verdict).toBe("indistinguishable");
    expect(result.lowestWinRate).toBeCloseTo(28.9);
    expect(result.highestWinRate).toBeCloseTo(41.4);
  });

  it("全本を上回れば above", () => {
    const result = compareWithControl(stats(50, 900), [
      stats(30, 10),
      stats(35, 20),
      stats(40, 30),
    ]);
    expect(result.verdict).toBe("above");
  });

  it("全本を下回れば below", () => {
    const result = compareWithControl(stats(20, -900), [
      stats(30, 10),
      stats(35, 20),
      stats(40, 30),
    ]);
    expect(result.verdict).toBe("below");
  });

  it("最大と並んだだけでは above にしない", () => {
    /*
     * 境界は「中に入っている」側に倒す。並んだだけで優位と言うと、
     * 乱数の引き1つで結論がひっくり返る。
     */
    const result = compareWithControl(stats(40, 500), [stats(30, 10), stats(40, 20)]);
    expect(result.verdict).toBe("indistinguishable");
  });

  it("最小と並んだだけでは below にしない", () => {
    const result = compareWithControl(stats(30, -500), [stats(30, 10), stats(40, 20)]);
    expect(result.verdict).toBe("indistinguishable");
  });

  it("損益で戦略以上だったランダムを数える", () => {
    const result = compareWithControl(stats(35, 303.2), [
      stats(34, 2327.6), // 上回った
      stats(33, 303.2), // 同じ。運で並ばれたのだから「以上」に数える
      stats(32, -678.3),
      stats(31, -889.6),
    ]);
    expect(result.beatenBy).toBe(2);
    expect(result.runs).toBe(4);
  });

  it("対照が1本も無ければ例外にする", () => {
    // 0本を「上回った」と読むと、対照を回し忘れたときに優位だと出る
    expect(() => compareWithControl(stats(35, 303.2), [])).toThrow();
  });
});
