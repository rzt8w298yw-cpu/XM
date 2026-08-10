/**
 * 経済指標フィルターの検証。
 *
 * 実際の発表予定が渡された場合はそれに従い、無い場合は定例時刻から推定する。
 * 推定と実データを取り違えると、避けたつもりの時間帯で入ってしまう。
 */
import { describe, expect, it } from "vitest";
import { checkEconomicCalendar, type EconomicEvent } from "../lib/economicCalendar";

const MINUTE = 60_000;
/** JSTの時刻からUTCのエポックミリ秒を作る */
const atJst = (hour: number, minute = 0) =>
  Date.UTC(2026, 0, 5, (hour - 9 + 24) % 24, minute);

describe("実際の発表予定が渡された場合", () => {
  const events: EconomicEvent[] = [
    { timestamp: atJst(18, 0), name: "テスト指標" },
  ];

  it("発表の前後は避ける", () => {
    const result = checkEconomicCalendar(atJst(18, 10), events);
    expect(result.ok).toBe(false);
    expect(result.fromSchedule).toBe(true);
    expect(result.description).toMatch(/テスト指標/);
  });

  it("発表前も避ける", () => {
    expect(checkEconomicCalendar(atJst(17, 40), events).ok).toBe(false);
  });

  it("窓の外なら通す", () => {
    const result = checkEconomicCalendar(atJst(19, 0), events);
    expect(result.ok).toBe(true);
    expect(result.fromSchedule).toBe(true);
  });

  it("窓の境界のすぐ内外で切り替わる", () => {
    expect(checkEconomicCalendar(atJst(18, 0) + 30 * MINUTE, events).ok).toBe(false);
    expect(checkEconomicCalendar(atJst(18, 0) + 31 * MINUTE, events).ok).toBe(true);
  });

  it("避ける分数を変えられる", () => {
    expect(checkEconomicCalendar(atJst(18, 45), events, 60).ok).toBe(false);
    expect(checkEconomicCalendar(atJst(18, 45), events, 15).ok).toBe(true);
  });

  it("予定が空配列なら推定に切り替わる", () => {
    expect(checkEconomicCalendar(atJst(19, 0), []).fromSchedule).toBe(false);
  });
});

describe("予定が無く推定に頼る場合", () => {
  it("推定であることが分かる", () => {
    const result = checkEconomicCalendar(atJst(19, 0), null);
    expect(result.fromSchedule).toBe(false);
    expect(result.description).toMatch(/推定/);
  });

  it("定例時刻の前後は避ける", () => {
    // JST 21:30 は米雇用統計などの定例時刻
    const result = checkEconomicCalendar(atJst(21, 30), null);
    expect(result.ok).toBe(false);
    expect(result.description).toMatch(/推定/);
  });

  it("定例時刻から離れていれば通す", () => {
    expect(checkEconomicCalendar(atJst(17, 0), null).ok).toBe(true);
  });

  it("定例時刻の直前も避ける", () => {
    // JST 3:00 のFOMCに対して 2:35 は25分前
    expect(checkEconomicCalendar(atJst(2, 35), null).ok).toBe(false);
  });

  it("日付をまたぐ距離で測る", () => {
    // JST 0:00 は 22:00(ISM) から単純な引き算だと1320分だが、
    // 日付をまたげば120分。最も近い窓は 3:00(FOMC) の180分なので、
    // 回避120分にすると「またぎ側の120分」だけが判定を分ける
    expect(checkEconomicCalendar(atJst(0, 0), null, 110).ok).toBe(true);

    const at120 = checkEconomicCalendar(atJst(0, 0), null, 120);
    expect(at120.ok).toBe(false);
    expect(at120.description).toMatch(/推定/);
  });

  it("既定の30分では日付またぎの判定は効かない", () => {
    // 定例時刻が 3:00 / 12:00 / 21:30 / 22:00 のいずれも、
    // 30分の窓では日付をまたぐ側が近くなる時刻が存在しない。
    // またぎ処理は回避分数を広げたときのための備え
    expect(checkEconomicCalendar(atJst(23, 50), null).ok).toBe(true);
    expect(checkEconomicCalendar(atJst(0, 30), null).ok).toBe(true);
  });

  it("0時台でも12時の日銀と誤判定しない", () => {
    expect(checkEconomicCalendar(atJst(0, 30), null).ok).toBe(true);
  });
});
