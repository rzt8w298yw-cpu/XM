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
  hasStarted,
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
    /*
     * **一度動き出した状態で確かめる。**
     *
     * 以前は `lastNotifiedAt: 0` を渡していた。それは「まだ動いていない」の
     * 印なので、初回の時計合わせで早期に返るようになった時点で、生存確認の
     * 分岐に到達しなくなった。`notice` は無効化されたからではなく、そこまで
     * 行かないから null になる——**何も検証していないのに通る。**
     * 実際、これを突くミューテーションが素通りするようになった。
     */
    // now は 100*HOUR なので、そこから100時間引くと 0 になり
    // 「まだ動いていない」の印と衝突する。10時間の時点を起点にする
    const started: HealthState = {
      status: "ok",
      since: 10 * HOUR,
      lastNotifiedAt: 10 * HOUR,
    };

    // 0 なら、90時間黙っていても送らない
    expect(diffHealth(started, cycle(), { ...options, heartbeatMs: 0 }).notice).toBeNull();

    // 0 でなければ送る（上の null が「無効化されたから」だと確かめる）
    expect(
      diffHealth(started, cycle(), { ...options, heartbeatMs: 24 * HOUR }).notice?.kind,
    ).toBe("heartbeat");
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

describe("初回の起動", () => {
  /*
   * `INITIAL_HEALTH` の時刻は 0 で、これは「まだ無い」の印であって
   * 1970年1月1日ではない。差を取ると 20679日 になり、起動した瞬間に
   * 「20679日のあいだシグナルはありません」を送っていた。
   */
  it("起動直後に生存確認を送らない", () => {
    const options = { heartbeatMs: 24 * 3_600_000, now: Date.now() };
    const { notice } = diffHealth(INITIAL_HEALTH, cycle(), options);
    expect(notice).toBeNull();
  });

  it("起動直後は時計だけ合わせる", () => {
    const now = Date.now();
    const { nextState } = diffHealth(INITIAL_HEALTH, cycle(), {
      heartbeatMs: 24 * 3_600_000,
      now,
    });
    expect(nextState.lastNotifiedAt).toBe(now);
    expect(nextState.since).toBe(now);
  });

  it("時計を合わせた次の周期からは、正しい経過時間で判定する", () => {
    const start = Date.now();
    const options = { heartbeatMs: 24 * 3_600_000, now: start };
    const { nextState } = diffHealth(INITIAL_HEALTH, cycle(), options);

    // 23時間後ではまだ出ない
    expect(
      diffHealth(nextState, cycle(), { ...options, now: start + 23 * 3_600_000 }).notice,
    ).toBeNull();

    // 25時間後には出る
    const later = diffHealth(nextState, cycle(), {
      ...options,
      now: start + 25 * 3_600_000,
    });
    expect(later.notice?.kind).toBe("heartbeat");
    // 20679日ではなく25時間
    expect(later.notice?.body).toContain("25時間");
  });

  it("hasStarted は 0 を「まだ無い」として扱う", () => {
    expect(hasStarted(INITIAL_HEALTH)).toBe(false);
    expect(hasStarted({ ...INITIAL_HEALTH, lastNotifiedAt: 1 })).toBe(true);
  });

  it("異常は起動直後でも知らせる（時計合わせより優先）", () => {
    // 起動していきなり全滅しているなら、それは伝えるべき
    const { notice } = diffHealth(
      INITIAL_HEALTH,
      cycle({ evaluated: 0, noRealData: 1 }),
      { heartbeatMs: 24 * 3_600_000, now: Date.now() },
    );
    expect(notice?.kind).toBe("problem");
  });
});
