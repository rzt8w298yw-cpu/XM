/**
 * CSV読み込みの検証。
 *
 * ブローカーのエクスポートは形式がまちまちで、ここで取りこぼすと
 * バックテストに辿り着けない。実際に出回っている形をそのまま並べてある。
 */
import { describe, expect, it } from "vitest";
import { inspectCandles, parseCandleCsv, parseDateTime } from "../lib/csv";

describe("parseCandleCsv", () => {
  it("MT5のエクスポート（タブ区切り・山括弧ヘッダ・日付と時刻が別列）を読む", () => {
    const text = [
      "<DATE>\t<TIME>\t<OPEN>\t<HIGH>\t<LOW>\t<CLOSE>\t<TICKVOL>\t<VOL>\t<SPREAD>",
      "2024.01.15\t09:00:00\t145.120\t145.480\t145.010\t145.390\t1234\t0\t12",
      "2024.01.15\t10:00:00\t145.390\t145.600\t145.300\t145.550\t2345\t0\t11",
    ].join("\n");

    const { candles } = parseCandleCsv(text);
    expect(candles).toHaveLength(2);
    expect(candles[0].timestamp).toBe(Date.UTC(2024, 0, 15, 9, 0, 0));
    expect(candles[0].open).toBe(145.12);
    expect(candles[0].high).toBe(145.48);
    expect(candles[0].low).toBe(145.01);
    expect(candles[0].close).toBe(145.39);
  });

  it("MT4のエクスポート（カンマ区切り・ヘッダ無し）を読む", () => {
    const text = [
      "2024.01.15,09:00,145.120,145.480,145.010,145.390,1234",
      "2024.01.15,10:00,145.390,145.600,145.300,145.550,2345",
    ].join("\n");

    const { candles } = parseCandleCsv(text);
    expect(candles).toHaveLength(2);
    expect(candles[0].timestamp).toBe(Date.UTC(2024, 0, 15, 9, 0));
    expect(candles[0].open).toBe(145.12);
    expect(candles[0].close).toBe(145.39);
  });

  it("一般的なカンマ区切り（ISO日時・小文字ヘッダ）を読む", () => {
    const text = [
      "timestamp,open,high,low,close",
      "2024-01-15T09:00:00Z,145.12,145.48,145.01,145.39",
      "2024-01-15T10:00:00Z,145.39,145.60,145.30,145.55",
    ].join("\n");

    const { candles } = parseCandleCsv(text);
    expect(candles).toHaveLength(2);
    expect(candles[0].timestamp).toBe(Date.UTC(2024, 0, 15, 9, 0, 0));
  });

  it("セミコロン区切りとdatetime列を読む", () => {
    const text = [
      "datetime;open;high;low;close",
      "2024-01-15 09:00;145.12;145.48;145.01;145.39",
    ].join("\n");

    const { candles } = parseCandleCsv(text);
    expect(candles).toHaveLength(1);
    expect(candles[0].timestamp).toBe(Date.UTC(2024, 0, 15, 9, 0));
  });

  it("時系列が逆順でも昇順に並べ替える", () => {
    const text = [
      "timestamp,open,high,low,close",
      "2024-01-15T10:00:00Z,2,2,2,2",
      "2024-01-15T09:00:00Z,1,1,1,1",
    ].join("\n");

    const { candles } = parseCandleCsv(text);
    expect(candles[0].close).toBe(1);
    expect(candles[1].close).toBe(2);
  });

  it("壊れた行は読み飛ばして件数を返す", () => {
    const text = [
      "timestamp,open,high,low,close",
      "2024-01-15T09:00:00Z,145.12,145.48,145.01,145.39",
      "2024-01-15T10:00:00Z,,,,",
      "壊れた行",
    ].join("\n");

    const { candles, skipped } = parseCandleCsv(text);
    expect(candles).toHaveLength(1);
    expect(skipped).toBe(2);
  });

  it("有効な行が1つも無ければエラーにする", () => {
    expect(() => parseCandleCsv("timestamp,open,high,low,close\nx,y,z,w,v")).toThrow(
      /有効な行がありません/,
    );
  });

  it("空文字はエラーにする", () => {
    expect(() => parseCandleCsv("   ")).toThrow(/データ行がありません/);
  });
});

describe("parseDateTime", () => {
  it("エポック秒とミリ秒を区別する", () => {
    expect(parseDateTime("1705309200", "")).toBe(1705309200 * 1000);
    expect(parseDateTime("1705309200000", "")).toBe(1705309200000);
  });

  it("タイムゾーン指定が無ければUTCとして扱う", () => {
    expect(parseDateTime("2024-01-15", "09:00")).toBe(Date.UTC(2024, 0, 15, 9, 0));
  });

  it("タイムゾーン指定があれば尊重する", () => {
    expect(parseDateTime("2024-01-15T09:00:00+09:00", "")).toBe(
      Date.UTC(2024, 0, 15, 0, 0),
    );
  });

  it("ドットとスラッシュ区切りの日付を読む", () => {
    const expected = Date.UTC(2024, 0, 15);
    expect(parseDateTime("2024.01.15", "")).toBe(expected);
    expect(parseDateTime("2024/01/15", "")).toBe(expected);
  });

  it("解釈できなければnull", () => {
    expect(parseDateTime("なんらかの文字列", "")).toBeNull();
    expect(parseDateTime("", "")).toBeNull();
  });
});

describe("inspectCandles", () => {
  const HOUR = 3_600_000;
  const base = Date.UTC(2024, 0, 15);
  const bar = (offsetHours: number, high = 2, low = 0) => ({
    timestamp: base + offsetHours * HOUR,
    open: 1, high, low, close: 1,
  });

  it("問題が無ければ何も返さない", () => {
    expect(inspectCandles([bar(0), bar(1), bar(2)], HOUR)).toEqual([]);
  });

  it("同じ時刻の足を報告する", () => {
    const notes = inspectCandles([bar(0), bar(0), bar(1)], HOUR);
    expect(notes.join()).toMatch(/同じ時刻の足が 1 件/);
  });

  it("時間の飛びを報告する", () => {
    const notes = inspectCandles([bar(0), bar(1), bar(50)], HOUR);
    expect(notes.join()).toMatch(/時間の飛びが 1 箇所（最大 49 時間）/);
  });

  it("高値安値が矛盾する足を報告する", () => {
    // 高値が始値・終値(=1)より低い
    const notes = inspectCandles([bar(0), bar(1, 0.5, 0)], HOUR);
    expect(notes.join()).toMatch(/矛盾する足が 1 件/);
  });
});
