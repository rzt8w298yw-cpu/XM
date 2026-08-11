/**
 * 監視の健康状態。
 *
 * ここが間違うと、壊れているのに黙るか、正常なのに鳴り続けるかのどちらかに
 * なる。どちらも通知を読まれなくするので、状態遷移の条件を1つずつ固定する。
 */
import { describe, expect, it } from "vitest";
import {
  assessCycle,
  diffHealth,
  markNotified,
  INITIAL_HEALTH,
  type CycleOutcome,
  type HealthState,
} from "../lib/health";

const HOUR = 3_600_000;

function cycle(over: Partial<CycleOutcome> = {}): CycleOutcome {
  return { total: 7, evaluated: 7, noRealData: 0, failed: 0, ...over };
}

describe("assessCycle", () => {
  it("1銘柄でも判定できていれば正常", () => {
    expect(assessCycle(cycle({ evaluated: 1, noRealData: 6 }))).toBe("ok");
  });

  it("全銘柄で実データが取れなければ no_data", () => {
    expect(assessCycle(cycle({ evaluated: 0, noRealData: 7 }))).toBe("no_data");
  });

  it("全銘柄が例外で落ちていれば failing", () => {
    expect(assessCycle(cycle({ evaluated: 0, failed: 7 }))).toBe("failing");
  });

  it("両方あるときは多いほうを名前にする", () => {
    expect(assessCycle(cycle({ evaluated: 0, noRealData: 2, failed: 5 }))).toBe("failing");
    expect(assessCycle(cycle({ evaluated: 0, noRealData: 5, failed: 2 }))).toBe("no_data");
  });

  it("監視対象が無ければ異常とは言わない", () => {
    expect(assessCycle({ total: 0, evaluated: 0, noRealData: 0, failed: 0 })).toBe("ok");
  });
});

describe("diffHealth", () => {
  const options = { heartbeatMs: 24 * HOUR, now: 100 * HOUR };

  it("正常が続く間は何も送らない", () => {
    const previous: HealthState = { status: "ok", since: 0, lastNotifiedAt: 99 * HOUR };
    const { notice, nextState } = diffHealth(previous, cycle(), options);
    expect(notice).toBeNull();
    expect(nextState).toBe(previous);
  });

  it("止まったら知らせる", () => {
    const previous: HealthState = { status: "ok", since: 0, lastNotifiedAt: 99 * HOUR };
    const { notice, nextState } = diffHealth(
      previous, cycle({ evaluated: 0, noRealData: 7 }), options,
    );
    expect(notice?.kind).toBe("problem");
    expect(notice?.body).toMatch(/実データを取得できていません/);
    expect(nextState.status).toBe("no_data");
    expect(nextState.since).toBe(options.now);
  });

  it("止まっている間は毎回は鳴らさない", () => {
    const previous: HealthState = {
      status: "no_data", since: 99 * HOUR, lastNotifiedAt: 99 * HOUR,
    };
    const { notice } = diffHealth(
      previous, cycle({ evaluated: 0, noRealData: 7 }), { ...options, now: 100 * HOUR },
    );
    expect(notice).toBeNull();
  });

  it("止まったままなら、間隔をあけて念を押す", () => {
    const previous: HealthState = {
      status: "no_data", since: 50 * HOUR, lastNotifiedAt: 60 * HOUR,
    };
    const { notice } = diffHealth(
      previous, cycle({ evaluated: 0, noRealData: 7 }), { ...options, now: 90 * HOUR },
    );
    expect(notice?.kind).toBe("problem");
    expect(notice?.title).toMatch(/止まったまま/);
    expect(notice?.body).toMatch(/復旧していません/);
  });

  it("復旧したら知らせる", () => {
    const previous: HealthState = {
      status: "no_data", since: 90 * HOUR, lastNotifiedAt: 90 * HOUR,
    };
    const { notice, nextState } = diffHealth(previous, cycle(), options);
    expect(notice?.kind).toBe("recovered");
    expect(notice?.body).toMatch(/10時間ぶり/);
    expect(nextState.status).toBe("ok");
  });

  it("静かな時間が続いたら生存を知らせる", () => {
    const previous: HealthState = { status: "ok", since: 0, lastNotifiedAt: 70 * HOUR };
    const { notice, nextState } = diffHealth(previous, cycle(), options);
    expect(notice?.kind).toBe("heartbeat");
    expect(notice?.body).toMatch(/正常です/);
    // 状態は変えず、時計だけ進める
    expect(nextState.status).toBe("ok");
    expect(nextState.lastNotifiedAt).toBe(options.now);
  });

  it("生存確認は0で無効にできる", () => {
    const previous: HealthState = { status: "ok", since: 0, lastNotifiedAt: 0 };
    const { notice } = diffHealth(previous, cycle(), { ...options, heartbeatMs: 0 });
    expect(notice).toBeNull();
  });

  it("時間の表し方が単位ごとに変わる", () => {
    const at = (sinceHours: number) =>
      diffHealth(
        { status: "no_data", since: options.now - sinceHours * HOUR, lastNotifiedAt: 0 },
        cycle(),
        options,
      ).notice?.body ?? "";

    expect(at(0.5)).toMatch(/30分/);
    expect(at(10)).toMatch(/10時間/);
    expect(at(72)).toMatch(/3日/);
  });

  it("初期状態からいきなり止まっていれば知らせる", () => {
    const { notice } = diffHealth(
      INITIAL_HEALTH, cycle({ evaluated: 0, noRealData: 7 }), options,
    );
    expect(notice?.kind).toBe("problem");
  });
});

describe("markNotified", () => {
  it("送った時刻だけを進める", () => {
    const before: HealthState = { status: "ok", since: 10, lastNotifiedAt: 20 };
    const after = markNotified(before, 99);
    expect(after).toEqual({ status: "ok", since: 10, lastNotifiedAt: 99 });
    // 元は変えない
    expect(before.lastNotifiedAt).toBe(20);
  });

  it("シグナルを送った直後は生存確認が出ない", () => {
    const options = { heartbeatMs: 24 * HOUR, now: 100 * HOUR };
    const stale: HealthState = { status: "ok", since: 0, lastNotifiedAt: 70 * HOUR };
    expect(diffHealth(stale, cycle(), options).notice?.kind).toBe("heartbeat");

    // シグナルを送った記録を入れると、同じ時刻でも出ない
    const fresh = markNotified(stale, options.now);
    expect(diffHealth(fresh, cycle(), options).notice).toBeNull();
  });
});
