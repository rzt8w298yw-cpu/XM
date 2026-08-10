/**
 * ミューテーションテストで生き残った変更を潰すためのテスト。
 *
 * `npm run mutate` で、コードにわざとバグを入れてもテストが通ってしまう箇所が
 * 9件見つかった。ここはその9件をそれぞれ落とすために書いてある。
 * 個々のテストは「このバグが入ったら落ちる」ことを目的にしているので、
 * 消す前に mutate を回して穴が復活しないか確かめること。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  closedDailyCandles,
  simulateTrade,
  summarize,
  type BacktestConfig,
  type Trade,
} from "../lib/backtest";
import { calculateRSI, getTimeSessionFromTimestamp } from "../lib/technicalAnalysis";
import { generateSignal, DEFAULT_THRESHOLDS } from "../lib/autoSignalEngine";
import { aggregate } from "../lib/marketData";
import { createSimulator } from "../lib/priceSimulator";
import { loadSignalState, saveSignalState } from "../lib/signalState";
import type { OHLC } from "../lib/technicalAnalysis";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

// ============================================================
// 先読み: 未確定の日足を判定に渡していないか
// ============================================================
describe("日足の確定判定", () => {
  const day = (dayIndex: number): OHLC => ({
    timestamp: Date.UTC(2026, 0, 1) + dayIndex * DAY,
    open: 100, high: 101, low: 99, close: 100,
  });

  it("確定した日足だけを返す", () => {
    const candles = [day(0), day(1), day(2)];
    // day(1) が閉じる瞬間 = day(2) の開始時刻
    const atTime = day(2).timestamp;
    const closed = closedDailyCandles(candles, atTime);
    expect(closed).toHaveLength(2);
    expect(closed.at(-1)!.timestamp).toBe(day(1).timestamp);
  });

  it("形成中の日足は含めない（1ミリ秒でも早ければ未確定）", () => {
    const candles = [day(0), day(1)];
    // day(1) が閉じる1ミリ秒前
    const closed = closedDailyCandles(candles, day(1).timestamp + DAY - 1);
    expect(closed).toHaveLength(1);
    expect(closed[0].timestamp).toBe(day(0).timestamp);
  });

  it("ちょうど閉じた瞬間は含める", () => {
    const candles = [day(0)];
    expect(closedDailyCandles(candles, day(0).timestamp + DAY)).toHaveLength(1);
  });

  it("まだ何も確定していなければ空", () => {
    expect(closedDailyCandles([day(0)], day(0).timestamp)).toHaveLength(0);
  });
});

// ============================================================
// 決済: 損切り判定の境界
// ============================================================
describe("損切り判定の境界", () => {
  const cfg: BacktestConfig = {
    pipSize: 0.01,
    atrStopMultiplier: 1.5,
    riskRewardRatio: 2,
    spreadPips: 0,
    windowSize: 1000,
    maxHoldingBars: 10,
  };
  const ATR = 0.1; // 損切り幅 0.15

  function bar(i: number, high: number, low: number): OHLC {
    return { timestamp: i * HOUR, open: 150, high, low, close: 150 };
  }

  it("安値がちょうど損切り値に触れたら約定する（BUY）", () => {
    // エントリー150.00、損切り149.85。安値がちょうど149.85
    const candles = [bar(0, 150.1, 149.9), bar(1, 150.1, 149.85), bar(2, 150.1, 150.0)];
    const trade = simulateTrade(candles, 0, "BUY", ATR, 70, cfg)!;
    expect(trade.exitReason).toBe("stop_loss");
  });

  it("損切り値をわずかに上回っていれば約定しない（BUY）", () => {
    const candles = [
      bar(0, 150.1, 149.9),
      bar(1, 150.1, 149.8500001),
      ...Array.from({ length: 9 }, (_, i) => bar(i + 2, 150.05, 149.95)),
    ];
    const trade = simulateTrade(candles, 0, "BUY", ATR, 70, cfg)!;
    expect(trade.exitReason).not.toBe("stop_loss");
  });

  it("高値がちょうど損切り値に触れたら約定する（SELL）", () => {
    // エントリー150.00、損切り150.15
    const candles = [bar(0, 150.1, 149.9), bar(1, 150.15, 149.9), bar(2, 150.0, 149.9)];
    const trade = simulateTrade(candles, 0, "SELL", ATR, 70, cfg)!;
    expect(trade.exitReason).toBe("stop_loss");
  });
});

// ============================================================
// 集計: 勝ちの定義
// ============================================================
describe("勝ちの定義", () => {
  function trade(pips: number): Trade {
    return {
      direction: "BUY", entryTime: 0, entryPrice: 150, exitTime: 0, exitPrice: 150,
      stopLoss: 149, takeProfit: 152, pips, exitReason: "timeout",
      holdingBars: 1, confidence: 50, session: "LONDON",
    };
  }

  it("損益ちょうど0は勝ちに数えない", () => {
    const stats = summarize([trade(10), trade(0)]);
    expect(stats.wins).toBe(1);
    expect(stats.losses).toBe(1);
    expect(stats.winRate).toBe(50);
  });

  it("0のトレードだけなら勝率0", () => {
    expect(summarize([trade(0), trade(0)]).winRate).toBe(0);
  });
});

// ============================================================
// RSI: Wilder平滑であること
// ============================================================
describe("RSIの平滑方式", () => {
  it("Wilder平滑の値と一致する（単純平均とは異なる）", () => {
    // period=3, 終値 [10, 11, 10.5, 11.5, 11]
    //   初期: gain合計2, loss合計0.5 → avgGain=2/3, avgLoss=1/6
    //   次の足(diff=-0.5): Wilder は avg*(n-1)+x を n で割る
    //     avgGain=(2/3*2+0)/3=4/9,  avgLoss=(1/6*2+0.5)/3=5/18
    //     rs = (4/9)/(5/18) = 1.6 → RSI = 100 - 100/2.6 = 61.538...
    //   単純平均だと avgGain=1/3, avgLoss=1/3 → RSI = 50 になる
    const rsi = calculateRSI([10, 11, 10.5, 11.5, 11], 3);
    expect(rsi[4]).toBeCloseTo(61.5384615, 5);
    expect(rsi[4]).not.toBeCloseTo(50, 1);
  });

  it("期間の直後の値は単純平均から始まる", () => {
    // 初期値だけは単純平均: rs = (2/3)/(1/6) = 4 → RSI = 80
    const rsi = calculateRSI([10, 11, 10.5, 11.5, 11], 3);
    expect(rsi[3]).toBeCloseTo(80, 6);
  });
});

// ============================================================
// セッション判定の境界
// ============================================================
describe("セッション判定の境界", () => {
  const atJst = (jstHour: number, minute = 0) =>
    Date.UTC(2026, 0, 5, (jstHour - 9 + 24) % 24, minute);

  it("JST16時ちょうどからロンドン", () => {
    expect(getTimeSessionFromTimestamp(atJst(15, 59))).not.toBe("LONDON");
    expect(getTimeSessionFromTimestamp(atJst(16, 0))).toBe("LONDON");
  });

  it("JST21時ちょうどからNY", () => {
    expect(getTimeSessionFromTimestamp(atJst(20, 59))).toBe("LONDON");
    expect(getTimeSessionFromTimestamp(atJst(21, 0))).toBe("NY");
  });

  it("JST2時でNYが終わる", () => {
    expect(getTimeSessionFromTimestamp(atJst(1, 59))).toBe("NY");
    expect(getTimeSessionFromTimestamp(atJst(2, 0))).not.toBe("NY");
  });

  it("JST9時ちょうどから東京", () => {
    expect(getTimeSessionFromTimestamp(atJst(8, 59))).toBe("SYDNEY");
    expect(getTimeSessionFromTimestamp(atJst(9, 0))).toBe("TOKYO");
  });
});

// ============================================================
// エンジンのゲートが実際に効いているか
// ============================================================
describe("シグナル発火時に満たされているべき条件", () => {
  const LONDON_TS = Date.UTC(2026, 0, 5, 9, 0, 0);

  /**
   * 多数の相場を回し、BUY/SELLが出たときに各ゲートが必ず通過していることを
   * 確かめる。ゲートを無効化するとこの不変条件が破れる。
   * 併せて、実際にシグナルが観測できていることも確認して空振りを防ぐ。
   */
  function samples() {
    const results = [];
    for (let seed = 700; seed < 760; seed++) {
      const candles1H = createSimulator(seed, { bars: 9000 });
      const candlesDaily = aggregate(candles1H, 24);
      // 判定は最後の足で行う
      results.push(
        generateSignal(
          candles1H.slice(-1000),
          aggregate(candles1H.slice(-1000), 4),
          candlesDaily,
          aggregate(candles1H.slice(-1000), 8),
          { overrideTimestamp: LONDON_TS },
        ),
      );
    }
    return results;
  }

  const results = samples();
  const fired = results.filter((r) => r.signal !== "WAIT");

  it("検証に足るだけのシグナルが観測できている", () => {
    expect(fired.length).toBeGreaterThan(0);
  });

  it("BUYはMTFフィルターを通過している", () => {
    for (const r of results.filter((r) => r.signal === "BUY")) {
      expect(r.analysis.mtfFilter.buyPass).toBe(true);
    }
  });

  it("SELLはMTFフィルターを通過している", () => {
    for (const r of results.filter((r) => r.signal === "SELL")) {
      expect(r.analysis.mtfFilter.sellPass).toBe(true);
    }
  });

  it("シグナルはロンドンかNYの時間帯でしか出ない", () => {
    for (const r of fired) {
      expect(["LONDON", "NY"]).toContain(r.analysis.timeSession);
    }
  });

  it("BUYは重み付きスコアが閾値以上", () => {
    for (const r of results.filter((r) => r.signal === "BUY")) {
      const total = r.conditions.reduce((sum, c) => sum + c.weight, 0);
      const met = r.conditions.filter((c) => c.met).reduce((sum, c) => sum + c.weight, 0);
      expect(met / total).toBeGreaterThanOrEqual(DEFAULT_THRESHOLDS.buyScoreMin);
    }
  });

  it("BUYのRSIは上限未満、SELLのRSIは下限超", () => {
    for (const r of results.filter((r) => r.signal === "BUY")) {
      expect(r.analysis.currentRSI).toBeLessThan(DEFAULT_THRESHOLDS.buyRsiMax);
    }
    for (const r of results.filter((r) => r.signal === "SELL")) {
      expect(r.analysis.currentRSI).toBeGreaterThan(DEFAULT_THRESHOLDS.sellRsiMin);
    }
  });
});

describe("閾値がシグナルの可否を変える", () => {
  const LONDON_TS = Date.UTC(2026, 0, 5, 9, 0, 0);

  /** BUYが出るところまで探して、その相場で閾値だけを動かす */
  function findBuyScenario() {
    for (let seed = 700; seed < 900; seed++) {
      const candles1H = createSimulator(seed, { bars: 9000 });
      const window = candles1H.slice(-1000);
      const candlesDaily = aggregate(candles1H, 24);
      const args = [
        window, aggregate(window, 4), candlesDaily, aggregate(window, 8),
      ] as const;
      const result = generateSignal(...args, { overrideTimestamp: LONDON_TS });
      if (result.signal === "BUY") return { args, candlesDaily };
    }
    return null;
  }

  const scenario = findBuyScenario();

  it("BUYが出る相場を見つけられる（前提の確認）", () => {
    expect(scenario).not.toBeNull();
  });

  it("スコア閾値を上げるとBUYが消える", () => {
    if (!scenario) return;
    const result = generateSignal(...scenario.args, {
      overrideTimestamp: LONDON_TS,
      thresholds: { buyScoreMin: 0.999 },
    });
    expect(result.signal).not.toBe("BUY");
  });

  it("RSI上限を下げるとBUYが消える", () => {
    if (!scenario) return;
    const result = generateSignal(...scenario.args, {
      overrideTimestamp: LONDON_TS,
      thresholds: { buyRsiMax: 1 },
    });
    expect(result.signal).not.toBe("BUY");
  });

  it("東京時間ではBUYが消える", () => {
    if (!scenario) return;
    const tokyoTs = Date.UTC(2026, 0, 5, 1, 0, 0); // JST 10時
    const result = generateSignal(...scenario.args, { overrideTimestamp: tokyoTs });
    expect(result.signal).toBe("WAIT");
  });
});

// ============================================================
// 状態保存が原子的か
// ============================================================
describe("状態保存の原子性", () => {
  it("一時ファイルへの書き込みが失敗したら既存の内容を壊さない", () => {
    const dir = mkdtempSync(join(tmpdir(), "atomic-"));
    const path = join(dir, "state.json");

    saveSignalState(path, { USDJPY: { signal: "BUY", barTime: 111 } });

    // 一時ファイルの場所をディレクトリで塞ぐ → 書き込みが必ず失敗する。
    // 直接 path に書く実装だと、ここで既存の内容が上書きされてしまう。
    mkdirSync(`${path}.tmp`);

    expect(() =>
      saveSignalState(path, { USDJPY: { signal: "SELL", barTime: 222 } }),
    ).toThrow();

    // 既存の内容が保たれていること
    expect(loadSignalState(path).state).toEqual({ USDJPY: { signal: "BUY", barTime: 111 } });
    expect(JSON.parse(readFileSync(path, "utf8")).USDJPY.signal).toBe("BUY");
    expect(existsSync(`${path}.tmp`)).toBe(true); // 塞いだディレクトリはそのまま
  });
});
