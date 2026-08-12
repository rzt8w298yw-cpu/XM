import { describe, expect, it } from "vitest";
import { aggregate, findSymbolSpec, getSymbolSpec, SYMBOLS } from "../lib/marketData";
import type { OHLC } from "../lib/technicalAnalysis";

const HOUR = 3_600_000;

function series(count: number, startTime: number): OHLC[] {
  return Array.from({ length: count }, (_, i) => ({
    timestamp: startTime + i * HOUR,
    open: 100 + i,
    high: 100.6 + i,
    low: 99.4 + i,
    close: 100.2 + i,
  }));
}

describe("aggregate", () => {
  const base = Date.UTC(2026, 0, 5, 0, 0, 0);

  it("4本の1H足を1本の4H足にまとめる", () => {
    const result = aggregate(series(8, base), 4);
    expect(result).toHaveLength(2);
    expect(result[0].open).toBe(100);
    expect(result[0].close).toBe(103.2);
    expect(result[0].high).toBe(103.6);
    expect(result[0].low).toBe(99.4);
  });

  it("区切りはUTCの絶対時刻に揃う", () => {
    // 03:00 開始でも、最初の4H足は 00:00 のバケットに入る
    const result = aggregate(series(8, Date.UTC(2026, 0, 5, 3, 0, 0)), 4);
    expect(new Date(result[0].timestamp).getUTCHours()).toBe(0);
    expect(new Date(result[1].timestamp).getUTCHours()).toBe(4);
  });

  it("取得ウィンドウが1本ずれても同じ時刻の上位足は同じ内容になる", () => {
    const full = series(64, base);
    const shifted = full.slice(1); // 1本古い足が落ちたウィンドウ

    for (const factor of [4, 8]) {
      const a = aggregate(full, factor);
      const b = aggregate(shifted, factor);

      // 先頭バケットは削られた足の分だけ内容が変わるので、それ以降を比較する
      const common = b.slice(1);
      for (const bar of common) {
        const match = a.find((x) => x.timestamp === bar.timestamp);
        expect(match).toBeDefined();
        expect(match).toEqual(bar);
      }
    }
  });

  it("足が1本もなければ空配列", () => {
    expect(aggregate([], 4)).toEqual([]);
  });
});

describe("getSymbolSpec", () => {
  it("未知のシンボルは例外にする（既定値で代用しない）", () => {
    // 以前はUSD/JPYに落としていた。EURCHFのような一覧に無い銘柄で
    // pipの大きさが100倍ずれ、損益が黙って桁違いになっていた
    expect(() => getSymbolSpec("EURCHF")).toThrow(/未対応の銘柄/);
    expect(() => getSymbolSpec("でたらめ")).toThrow(/指定できるのは/);
  });

  it("知らない銘柄を確かめるだけなら null を返す", () => {
    expect(findSymbolSpec("EURCHF")).toBeNull();
    expect(findSymbolSpec("USDJPY")?.pipSize).toBe(0.01);
  });

  it("JPYペアとドルストレートでpip単位が異なる", () => {
    expect(getSymbolSpec("USDJPY").pipSize).toBe(0.01);
    expect(getSymbolSpec("EURUSD").pipSize).toBe(0.0001);
  });
});

describe("桁の想定が銘柄ごとに違うこと", () => {
  it("JPY建てとそれ以外でpipの大きさが100倍違う", () => {
    // ここを取り違えると損益だけが黙って100倍ずれる。
    // 値動きの形は変わらないので、チャートを見ても気づけない
    expect(getSymbolSpec("USDJPY").pipSize).toBe(0.01);
    expect(getSymbolSpec("EURUSD").pipSize).toBe(0.0001);
    expect(getSymbolSpec("USDJPY").pipSize / getSymbolSpec("EURUSD").pipSize).toBe(100);
  });

  it("一覧の全銘柄で、桁数とpipの大きさが噛み合っている", () => {
    for (const spec of SYMBOLS) {
      // 3桁ならpipは0.01、5桁なら0.0001、2桁（金）なら0.1
      const expected = spec.digits === 3 ? 0.01 : spec.digits === 5 ? 0.0001 : 0.1;
      expect(spec.pipSize, `${spec.id} の桁数と1pipが噛み合っていません`).toBe(expected);
    }
  });
});
