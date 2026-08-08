/**
 * 足の鮮度表示の検証。
 *
 * リアルタイム運用では、古い足のまま判定が出ていることに気づけないのが一番危ない。
 * 「何分前か」と「古すぎるか」の境界をここで固定する。
 */
import { describe, expect, it } from "vitest";
import { describeCandleAge } from "../lib/marketData";

const MINUTE = 60_000;
const now = Date.UTC(2026, 0, 15, 12, 0, 0);

describe("describeCandleAge", () => {
  it("60分未満は分で表す", () => {
    expect(describeCandleAge(now - 36 * MINUTE, now).label).toBe("36分前");
    expect(describeCandleAge(now, now).label).toBe("0分前");
  });

  it("60分以上は時間と分で表す", () => {
    expect(describeCandleAge(now - 60 * MINUTE, now).label).toBe("1時間0分前");
    expect(describeCandleAge(now - 95 * MINUTE, now).label).toBe("1時間35分前");
  });

  it("1H足なので2時間未満は正常とみなす", () => {
    expect(describeCandleAge(now - 119 * MINUTE, now).stale).toBe(false);
  });

  it("2時間以上あいていたら古いと判定する", () => {
    expect(describeCandleAge(now - 120 * MINUTE, now).stale).toBe(true);
    expect(describeCandleAge(now - 3 * 60 * MINUTE, now).stale).toBe(true);
  });

  it("境界は指定で変えられる", () => {
    expect(describeCandleAge(now - 70 * MINUTE, now, 60).stale).toBe(true);
  });

  it("未来の時刻でも負の値にはしない", () => {
    const future = describeCandleAge(now + 10 * MINUTE, now);
    expect(future.minutes).toBe(0);
    expect(future.label).toBe("0分前");
  });
});
