/**
 * 勝つために必要な数字の計算。
 *
 * ここは予測を含まないので、正解が閉じた形で分かる。
 * だから「だいたい合っている」ではなく、手計算と一致することを確かめる。
 */
import { describe, expect, it } from "vitest";
import {
  judgeTrackRecord,
  maxSafeRiskPercent,
  requiredAccuracy,
  simulateRuin,
  trackRegime,
  tradesNeededToConfirm,
  zScoreFor,
} from "../lib/edgeMath";

describe("requiredAccuracy", () => {
  it("コストが0なら 1/(1+RR) になる", () => {
    // RR 1:2 → 1/3 = 33.33%
    const result = requiredAccuracy({ stopDistancePips: 30, riskRewardRatio: 2, costPips: 0 });
    expect(result.idealWinRate).toBeCloseTo(33.3333, 3);
    expect(result.requiredWinRate).toBeCloseTo(33.3333, 3);
    expect(result.costPenalty).toBeCloseTo(0, 10);
  });

  it("コストのぶんだけ必要的中率が上がる", () => {
    // 損切り30・利確60・コスト2 → (30+2)/(60+30) = 35.56%
    const result = requiredAccuracy({ stopDistancePips: 30, riskRewardRatio: 2, costPips: 2 });
    expect(result.requiredWinRate).toBeCloseTo(35.5556, 3);
    expect(result.costPenalty).toBeCloseTo(2.2222, 3);
  });

  it("損切りが狭いほどコストの影響が大きい", () => {
    const wide = requiredAccuracy({ stopDistancePips: 100, riskRewardRatio: 2, costPips: 2 });
    const narrow = requiredAccuracy({ stopDistancePips: 10, riskRewardRatio: 2, costPips: 2 });
    expect(narrow.costPenalty).toBeGreaterThan(wide.costPenalty);
    // 1時間足のATR 10 pips に往復2 pips は、必要的中率を6.7ポイント押し上げる
    expect(narrow.costPenalty).toBeCloseTo(6.6667, 3);
    expect(wide.costPenalty).toBeCloseTo(0.6667, 3);
  });

  it("コストが利確幅を超えると成立しないと言う", () => {
    const result = requiredAccuracy({ stopDistancePips: 5, riskRewardRatio: 1, costPips: 20 });
    expect(result.requiredWinRate).toBeGreaterThanOrEqual(100);
    expect(result.warnings.join()).toMatch(/全勝しても/);
  });

  it("コストが損切り幅の1割を超えたら注意を出す", () => {
    const result = requiredAccuracy({ stopDistancePips: 10, riskRewardRatio: 2, costPips: 2 });
    expect(result.costAsShareOfStop).toBeCloseTo(20, 6);
    expect(result.warnings.join()).toMatch(/損切り幅の/);
  });

  it("入力が不正なら計算せず理由を返す", () => {
    const result = requiredAccuracy({ stopDistancePips: 0, riskRewardRatio: 2, costPips: 1 });
    expect(Number.isNaN(result.requiredWinRate)).toBe(true);
    expect(result.warnings).toHaveLength(1);
  });
});

describe("tradesNeededToConfirm", () => {
  it("(z × ばらつき / 期待値)² になる", () => {
    // 95% → z=1.6449。 (1.6449 × 30 / 1)² = 2435.4 → 2436
    const result = tradesNeededToConfirm({ expectancyPips: 1, stdDevPips: 30 });
    expect(result.trades).toBe(2436);
  });

  it("期待値が2倍になると必要件数は4分の1になる", () => {
    const one = tradesNeededToConfirm({ expectancyPips: 1, stdDevPips: 30 });
    const two = tradesNeededToConfirm({ expectancyPips: 2, stdDevPips: 30 });
    expect(two.trades).toBeCloseTo(one.trades / 4, -1);
  });

  it("確からしさを上げると必要件数が増える", () => {
    const at95 = tradesNeededToConfirm({ expectancyPips: 1, stdDevPips: 30, confidence: 0.95 });
    const at99 = tradesNeededToConfirm({ expectancyPips: 1, stdDevPips: 30, confidence: 0.99 });
    expect(at99.trades).toBeGreaterThan(at95.trades);
  });

  it("期待値がプラスでなければ何件あっても言えない", () => {
    const result = tradesNeededToConfirm({ expectancyPips: -1, stdDevPips: 30 });
    expect(result.trades).toBe(Infinity);
    expect(result.message).toMatch(/プラスではない/);
  });

  it("知らない確からしさは拒否する", () => {
    expect(() => zScoreFor(0.975)).toThrow(/対応していない/);
  });
});

describe("simulateRuin", () => {
  const base = {
    riskRewardRatio: 2,
    ruinThresholdPercent: 50,
    trades: 200,
    paths: 2000,
    seed: 4242,
  };

  it("同じ種なら同じ結果になる", () => {
    const a = simulateRuin({ ...base, winRate: 40, riskPercent: 2 });
    const b = simulateRuin({ ...base, winRate: 40, riskPercent: 2 });
    expect(a.ruinProbability).toBe(b.ruinProbability);
    expect(a.medianFinalBalance).toBe(b.medianFinalBalance);
  });

  it("リスク割合を上げると破産確率が上がる", () => {
    const small = simulateRuin({ ...base, winRate: 40, riskPercent: 1 });
    const large = simulateRuin({ ...base, winRate: 40, riskPercent: 5 });
    expect(large.ruinProbability).toBeGreaterThan(small.ruinProbability);
  });

  it("期待値がプラスでも枚数次第で破産する", () => {
    // 勝率40%・RR1:2 → 1回あたりの期待値はプラス
    const result = simulateRuin({ ...base, winRate: 40, riskPercent: 20 });
    expect(result.edgePerTrade).toBeGreaterThan(0);
    expect(result.ruinProbability).toBeGreaterThan(0);
  });

  it("期待値がマイナスなら、枚数を落としても結末は変わらないと言う", () => {
    const result = simulateRuin({ ...base, winRate: 25, riskPercent: 1 });
    expect(result.edgePerTrade).toBeLessThan(0);
    expect(result.warnings.join()).toMatch(/遅くなるだけ/);
  });

  it("期待値の式が勝率とRRに従う", () => {
    // 0.4 × 0.02 × 2 - 0.6 × 0.02 = 0.004
    const result = simulateRuin({ ...base, winRate: 40, riskPercent: 2 });
    expect(result.edgePerTrade).toBeCloseTo(0.004, 10);
  });

  it("賭け金は残高に比例する（負けるほど賭け金も減る）", () => {
    // 全敗する系列。残高比なら 0.99^n で減り続けて0にはならないが、
    // 固定額なら100回で使い切る
    const allLose = simulateRuin({
      ...base, winRate: 0, riskPercent: 1, trades: 300,
      ruinThresholdPercent: 99.9, paths: 50,
    });
    // 残高比で1%ずつなら 0.99^300 = 4.9% までしか減らない → 99.9%減には届かない
    expect(allLose.ruinProbability).toBe(0);
    expect(allLose.medianFinalBalance).toBeGreaterThan(0);
    expect(allLose.medianFinalBalance).toBeCloseTo(100 * 0.99 ** 300, 4);
  });

  it("入力が不正なら計算せず理由を返す", () => {
    const result = simulateRuin({ ...base, winRate: 40, riskPercent: 0 });
    expect(Number.isNaN(result.ruinProbability)).toBe(true);
    expect(result.warnings).toHaveLength(1);
  });
});

describe("maxSafeRiskPercent", () => {
  const base = {
    winRate: 45,
    riskRewardRatio: 2,
    ruinThresholdPercent: 50,
    trades: 200,
    paths: 1000,
    seed: 99,
  };

  it("破産確率を目標以下に収める最大の割合を返す", () => {
    const { riskPercent, ruinProbability } = maxSafeRiskPercent(base, 1);
    expect(riskPercent).not.toBeNull();
    expect(ruinProbability).toBeLessThanOrEqual(1);

    // その1段上は目標を超えるはず
    const candidates = [0.25, 0.5, 0.75, 1, 1.5, 2, 3, 5];
    const next = candidates[candidates.indexOf(riskPercent!) + 1];
    if (next !== undefined) {
      expect(simulateRuin({ ...base, riskPercent: next }).ruinProbability).toBeGreaterThan(1);
    }
  });

  it("目標を超えた時点で打ち切る（大きい割合を拾わない）", () => {
    // 破産確率はリスク割合に対して単調に上がる。途中で超えたあとの候補を
    // 拾ってしまうと、危険な割合を「安全」と返してしまう
    const candidates = [0.5, 1, 2, 3, 5, 10, 20];
    const { riskPercent } = maxSafeRiskPercent(base, 1, candidates);
    expect(riskPercent).not.toBeNull();

    // 返ってきた割合より大きい候補は、すべて目標を超えていること
    for (const candidate of candidates.filter((c) => c > riskPercent!)) {
      expect(
        simulateRuin({ ...base, riskPercent: candidate }).ruinProbability,
      ).toBeGreaterThan(1);
    }
  });

  it("どの割合でも目標に届かなければ null", () => {
    const hopeless = { ...base, winRate: 10, ruinThresholdPercent: 20 };
    expect(maxSafeRiskPercent(hopeless, 0).riskPercent).toBeNull();
  });
});

describe("trackRegime", () => {
  /** 前半マイナス・後半プラスの、符号が入れ替わる系列 */
  const flipping = [
    ...Array.from({ length: 100 }, (_, i) => ({ year: 2000 + (i % 5), signedReturn: -0.1 })),
    ...Array.from({ length: 100 }, (_, i) => ({ year: 2010 + (i % 5), signedReturn: 0.2 })),
  ];

  it("窓ごとの平均を出す", () => {
    const status = trackRegime(flipping, 5);
    expect(status.windows.length).toBeGreaterThanOrEqual(2);
    expect(status.windows[0].mean).toBeCloseTo(-0.1, 10);
    expect(status.windows[status.windows.length - 1].mean).toBeCloseTo(0.2, 10);
  });

  it("符号が変わっていれば知らせる", () => {
    const status = trackRegime(flipping, 5);
    expect(status.flipped).toBe(true);
    expect(status.currentSign).toBe(1);
    expect(status.message).toMatch(/反転/);
  });

  it("符号が変わっていなければ知らせない", () => {
    const steady = Array.from({ length: 200 }, (_, i) => ({
      year: 2000 + Math.floor(i / 20),
      signedReturn: 0.15,
    }));
    const status = trackRegime(steady, 5);
    expect(status.flipped).toBe(false);
    expect(status.currentSign).toBe(1);
    expect(status.message).toMatch(/効いている向きのまま/);
  });

  it("件数の足りない窓は作らない", () => {
    const sparse = [
      ...Array.from({ length: 30 }, () => ({ year: 2000, signedReturn: 0.1 })),
      ...Array.from({ length: 5 }, () => ({ year: 2010, signedReturn: 0.1 })),
    ];
    const status = trackRegime(sparse, 5);
    expect(status.windows).toHaveLength(1);
    expect(status.windows[0].label).toMatch(/^2000/);
  });

  it("空なら何も言わない", () => {
    const status = trackRegime([], 5);
    expect(status.windows).toHaveLength(0);
    expect(status.currentSign).toBe(0);
    expect(status.flipped).toBe(false);
  });
});

describe("judgeTrackRecord", () => {
  /** 勝ちと負けを指定の比率で並べる */
  function record(wins: number, losses: number, winPips: number, lossPips: number): number[] {
    return [
      ...Array.from({ length: wins }, () => winPips),
      ...Array.from({ length: losses }, () => -lossPips),
    ];
  }

  it("決着が無ければ件数不足", () => {
    const result = judgeTrackRecord([], 2);
    expect(result.verdict).toBe("件数不足");
    expect(result.trades).toBe(0);
  });

  it("損益分岐を下回っていれば、件数の話をしない", () => {
    // 勝率30%・勝ち負け同幅 → 期待値マイナス
    const result = judgeTrackRecord(record(30, 70, 100, 100), 2);
    expect(result.verdict).toBe("損益分岐を下回る");
    expect(result.message).toMatch(/件数を積んでも/);
  });

  it("勝っていても件数が足りなければ、そう言う", () => {
    // 勝率55%・勝ち負け同幅 → 期待値プラスだが件数20では足りない
    const result = judgeTrackRecord(record(11, 9, 100, 100), 2);
    expect(result.expectancyPips).toBeGreaterThan(0);
    expect(result.verdict).toBe("件数不足");
    expect(result.tradesNeeded).toBeGreaterThan(result.trades);
    expect(result.message).toMatch(/運を読んでいる/);
  });

  it("件数が足りていれば基準を超えていると言う", () => {
    // 大きく勝ち越していれば必要件数は小さくなる
    const result = judgeTrackRecord(record(800, 200, 100, 50), 2);
    expect(result.verdict).toBe("基準を超えている");
    expect(result.trades).toBeGreaterThanOrEqual(result.tradesNeeded);
  });

  it("実測の勝ち負けの幅から損益分岐を出す", () => {
    // 平均利益100 / 平均損失80 → RR 1:1.25。コスト2なら (80+2)/(100+80) = 45.56%
    // 既定のRR（1:2）を当てはめると 34.7% になるので、実測を使っていれば区別できる
    const result = judgeTrackRecord(record(400, 600, 100, 80), 2);
    expect(result.avgWinPips).toBeCloseTo(100, 6);
    expect(result.avgLossPips).toBeCloseTo(80, 6);
    expect(result.requiredWinRate).toBeCloseTo(45.5556, 3);
  });

  it("引き分けは負け側に数える", () => {
    const result = judgeTrackRecord([0, 0, 100, -100], 2);
    expect(result.winRate).toBeCloseTo(25, 6);
  });

  it("ばらつきは実現損益の散らばりから出す", () => {
    // 全部同じ値なら散らばりは0
    expect(judgeTrackRecord([50, 50, 50], 2).stdDevPips).toBeCloseTo(0, 10);
    // 勝ち負けが混ざれば0にならない
    expect(judgeTrackRecord(record(5, 5, 100, 100), 2).stdDevPips).toBeGreaterThan(0);
  });
});
