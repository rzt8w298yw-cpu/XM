/**
 * 広域ルールの検証。
 *
 * ここで最も重要なのは**先読みが無いこと**。ルールが未来の足を1本でも
 * 見ていれば、この一式の結果はすべて無効になる。そして先読みは目視では
 * 見つからない——成績が良くなるだけで、どこも壊れないため。
 *
 * だから機械的に確かめる: **系列をその足で打ち切っても、同じ判断になるか。**
 * 打ち切ったときに答えが変わるなら、先の足を見ている。
 */
import { describe, expect, it } from "vitest";
import {
  buildWideContext,
  FILTERS,
  scanWideRule,
  WIDE_RULES,
  type Direction,
} from "../lib/wideRules";
import type { OHLC } from "../lib/technicalAnalysis";

const HOUR = 3_600_000;

/** 種を固定した擬似乱数。落ちたときに必ず再現できるようにする */
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 検証用の値動き。
 *
 * 三角関数を重ねただけの滑らかな系列では、値幅の急拡大・片側の長いヒゲ・
 * 窓・深い押し——といった形が一度も現れず、それを条件にするルールが
 * 発動しなかった。**発動しない足だけを流して「先読みが無い」と言っても、
 * 何も確かめたことにならない。**
 *
 * かといってルールごとに形を継ぎ足すと、フィクスチャをルールに合わせて
 * 作ることになり、本末転倒になる。ここではボラティリティが変動する
 * ランダムウォークにして、必要な形が自然に出るようにした。種は固定して
 * あるので、落ちたときは必ず同じ系列で再現できる。
 */
function syntheticCandles(count: number, seed = 20240813): OHLC[] {
  const rand = mulberry32(seed);
  const out: OHLC[] = [];
  let price = 150;
  let volatility = 0.08;

  for (let i = 0; i < count; i++) {
    // ボラティリティ自体をゆっくり変動させる（静かな時期と荒い時期を作る）
    volatility = Math.max(0.02, Math.min(0.5, volatility + (rand() - 0.5) * 0.02));

    // 週末に相当する窓
    if (i > 0 && i % 120 === 0) price += (rand() - 0.5) * volatility * 12;

    const open = price;
    const move = (rand() - 0.5) * volatility * 4;
    const close = open + move;
    price = close;

    // ヒゲは上下で別々に引く。対称にすると pin_bar が出ない
    const upperWick = rand() ** 2 * volatility * 5;
    const lowerWick = rand() ** 2 * volatility * 5;

    out.push({
      timestamp: Date.UTC(2020, 0, 6, 0) + i * HOUR,
      open,
      high: Math.max(open, close) + upperWick,
      low: Math.min(open, close) - lowerWick,
      close,
    });
  }
  return out;
}

const CANDLES = syntheticCandles(3000);
const PIP = 0.01;

const NONE = FILTERS.find((f) => f.id === "none");
if (!NONE) throw new Error("none フィルターがありません");

describe("先読みが無いこと", () => {
  /*
   * **ルールが実際に発動した足で確かめる。**
   *
   * 適当な位置で比べても、そこで両方 null を返せば一致してしまい、
   * 何も検証したことにならない。発動している足を選べば、判断が
   * 未来の足に依存していないことを実際に確かめられる。
   *
   * 系列をその足で打ち切って、同じ判断になるかを見る。指標は
   * 「その足まで」で計算されるはずなので、打ち切っても変わらない。
   * 変わるなら、どこかで先を見ている。
   */
  const fullContext = buildWideContext(CANDLES, PIP);

  for (const rule of WIDE_RULES) {
    it(`${rule.id}: 発動した足で打ち切っても同じ判断になる`, () => {
      const fired = scanWideRule(rule, NONE, fullContext, 0, CANDLES.length).hits;
      // 発動していないルールは検証できていない。それを黙って通さない
      expect(fired.length, `${rule.id} がこの値動きで一度も発動しません`).toBeGreaterThan(0);

      // 全部やると重いので、期間全体に散らして最大8か所
      const step = Math.max(1, Math.floor(fired.length / 8));
      for (let n = 0; n < fired.length; n += step) {
        const i = fired[n].index;
        const truncated = buildWideContext(CANDLES.slice(0, i + 1), PIP);
        truncated.i = i;
        fullContext.i = i;

        const expected: Direction | null = rule.decide(fullContext);
        const actual: Direction | null = rule.decide(truncated);
        expect(actual, `${rule.id} は index ${i} で未来の足を見ています`).toBe(expected);
      }
    });
  }
});

describe("フィルター", () => {
  it("none 以外はすべて件数を実際に減らす", () => {
    /*
     * 「減るか同じ」で通してはいけない。**フィルターが完全に無視されても
     * 同じ件数になるので、その条件では素通りする。** 実際、走査が
     * フィルターを掛けなくなるミューテーションがこれをすり抜けた。
     * none 以外は厳密に減ることを求める。
     */
    const ctx = buildWideContext(CANDLES, PIP);
    const rule = WIDE_RULES.find((r) => r.id === "bb_middle_cross");
    if (!rule) throw new Error("bb_middle_cross がありません");

    const baseline = scanWideRule(rule, NONE, ctx, 0, CANDLES.length).hits.length;
    expect(baseline).toBeGreaterThan(0);

    for (const filter of FILTERS) {
      const count = scanWideRule(rule, filter, ctx, 0, CANDLES.length).hits.length;
      if (filter.id === "none") {
        expect(count).toBe(baseline);
        continue;
      }
      expect(count, `${filter.id} が件数を減らしていません`).toBeLessThan(baseline);
    }
  });

  it("時間帯フィルターは互いに重ならず、合計しても全体に届かない", () => {
    // ロンドン・NY（7〜21時）と東京（0〜7時）で、21〜24時はどちらにも入らない
    const ctx = buildWideContext(CANDLES, PIP);
    const rule = WIDE_RULES.find((r) => r.id === "bb_middle_cross");
    const londonNy = FILTERS.find((f) => f.id === "london_ny");
    const tokyo = FILTERS.find((f) => f.id === "tokyo");
    if (!rule || !londonNy || !tokyo) throw new Error("見つかりません");

    const total = scanWideRule(rule, NONE, ctx, 0, CANDLES.length).hits.length;
    const a = scanWideRule(rule, londonNy, ctx, 0, CANDLES.length).hits.length;
    const b = scanWideRule(rule, tokyo, ctx, 0, CANDLES.length).hits.length;

    expect(a).toBeGreaterThan(0);
    expect(b).toBeGreaterThan(0);
    expect(a + b).toBeLessThan(total);
  });

  it("with_trend と against_trend は同じ足で同時に成立しない", () => {
    const ctx = buildWideContext(CANDLES, PIP);
    const withTrend = FILTERS.find((f) => f.id === "with_trend");
    const against = FILTERS.find((f) => f.id === "against_trend");
    expect(withTrend && against).toBeTruthy();
    if (!withTrend || !against) return;

    for (let i = 300; i < 1100; i += 50) {
      ctx.i = i;
      for (const direction of ["BUY", "SELL"] as const) {
        const a = withTrend.allows(ctx, direction);
        const b = against.allows(ctx, direction);
        expect(a && b).toBe(false);
      }
    }
  });

  it("adx_trending と adx_ranging は同じ足で同時に成立しない", () => {
    const ctx = buildWideContext(CANDLES, PIP);
    const trending = FILTERS.find((f) => f.id === "adx_trending");
    const ranging = FILTERS.find((f) => f.id === "adx_ranging");
    if (!trending || !ranging) throw new Error("フィルターがありません");

    for (let i = 300; i < 1100; i += 25) {
      ctx.i = i;
      expect(trending.allows(ctx, "BUY") && ranging.allows(ctx, "BUY")).toBe(false);
    }
  });
});

describe("scanWideRule", () => {
  it("指定した範囲の外では判定しない", () => {
    const ctx = buildWideContext(CANDLES, PIP);
    const rule = WIDE_RULES.find((r) => r.id === "bb_middle_cross");
    const none = FILTERS.find((f) => f.id === "none");
    if (!rule || !none) throw new Error("見つかりません");

    const scan = scanWideRule(rule, none, ctx, 600, 800);
    for (const hit of scan.hits) {
      expect(hit.index).toBeGreaterThanOrEqual(600);
      expect(hit.index).toBeLessThan(800);
    }
  });

  it("ウォームアップ中（250本未満）は判定しない", () => {
    const ctx = buildWideContext(CANDLES, PIP);
    const rule = WIDE_RULES.find((r) => r.id === "bb_middle_cross");
    const none = FILTERS.find((f) => f.id === "none");
    if (!rule || !none) throw new Error("見つかりません");

    const scan = scanWideRule(rule, none, ctx, 0, CANDLES.length);
    for (const hit of scan.hits) {
      expect(hit.index).toBeGreaterThanOrEqual(250);
    }
  });

  it("判定した足の本数が、ウォームアップと最終足の扱いと厳密に一致する", () => {
    /*
     * シグナルの位置だけを見ると、たまたまその足でルールが発動しなければ
     * すり抜ける。**判定した本数**なら、ルールの気まぐれに左右されない。
     *
     * 250本目から始め、最後の足は判定しない（次の足で約定できないため）。
     * よって 250 〜 length-2 の length-251 本。
     */
    const ctx = buildWideContext(CANDLES, PIP);
    const rule = WIDE_RULES.find((r) => r.id === "bb_middle_cross");
    if (!rule) throw new Error("bb_middle_cross がありません");

    const scan = scanWideRule(rule, NONE, ctx, 0, CANDLES.length);
    expect(scan.barsEvaluated).toBe(CANDLES.length - 251);

    for (const hit of scan.hits) {
      expect(hit.index).toBeLessThan(CANDLES.length - 1);
      expect(hit.index).toBeGreaterThanOrEqual(250);
    }
  });

  it("ATRが有効な足だけを数える", () => {
    const ctx = buildWideContext(CANDLES, PIP);
    const rule = WIDE_RULES.find((r) => r.id === "bb_middle_cross");
    const none = FILTERS.find((f) => f.id === "none");
    if (!rule || !none) throw new Error("見つかりません");

    const scan = scanWideRule(rule, none, ctx, 0, CANDLES.length);
    for (const hit of scan.hits) {
      expect(hit.atr).toBeGreaterThan(0);
      expect(Number.isFinite(hit.atr)).toBe(true);
    }
  });
});

describe("ルール一覧", () => {
  it("IDが重複していない", () => {
    const ids = WIDE_RULES.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("フィルターのIDが重複していない", () => {
    const ids = FILTERS.map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
