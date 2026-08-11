/**
 * 監視そのものの健康状態
 *
 * このアプリは正常時の98.6%が無音になる（シグナルは1銘柄あたり平均4.3日に
 * 1回しか出ない）。つまり**「静か」と「壊れている」が、受け取る側から
 * 区別できない。**
 *
 * 実際、`watch.ts` の失敗経路はすべて `console.warn` / `console.error` で
 * 終わっていた。データ取得が403で止まっても、判定が例外で落ちても、
 * 送信が失敗しても、端末を見ていなければ何も起きないのと同じに見える。
 * 半年気づかずに「今月もシグナルが出ないな」と思い続けることになる。
 *
 * ここでは監視の状態そのものを1つの状態機械として扱い、シグナルと同じ
 * 経路で伝える。方針もシグナルと揃える：**変わったときだけ言う。**
 * 毎回言うと、通知そのものが読まれなくなる。
 *
 * 加えて、何も起きない時間が続いたら「動いています」を送る。これが無いと
 * 無音の意味が確定しない。
 */

export type HealthStatus =
  /** 全銘柄ではないかもしれないが、判定はできている */
  | "ok"
  /** 実データが取れず、1銘柄も判定できていない */
  | "no_data"
  /** 例外で落ちていて、1銘柄も判定できていない */
  | "failing";

export interface HealthState {
  status: HealthStatus;
  /** その状態になった時刻 */
  since: number;
  /** 最後に何かを送った時刻。生存確認の間隔を測るのに使う */
  lastNotifiedAt: number;
}

export const INITIAL_HEALTH: HealthState = {
  status: "ok",
  since: 0,
  lastNotifiedAt: 0,
};

/** 1周期の結果 */
export interface CycleOutcome {
  /** 監視対象の銘柄数 */
  total: number;
  /** 判定できた銘柄数 */
  evaluated: number;
  /** 実データが取れなかった銘柄数 */
  noRealData: number;
  /** 例外で落ちた銘柄数 */
  failed: number;
}

/**
 * 1周期の結果から状態を決める。
 *
 * 1銘柄でも判定できていれば `ok` にする。一部の銘柄だけ落ちるのは
 * 珍しくなく、そのたびに鳴らすと通知が読まれなくなる。**全部が判定
 * できていない状態**だけを異常として扱う。
 */
export function assessCycle(outcome: CycleOutcome): HealthStatus {
  if (outcome.total === 0) return "ok";
  if (outcome.evaluated > 0) return "ok";
  // 全滅している。原因の多いほうを名前にする
  return outcome.noRealData >= outcome.failed ? "no_data" : "failing";
}

export interface HealthNotice {
  kind: "problem" | "recovered" | "heartbeat";
  title: string;
  body: string;
}

export interface DiffHealthOptions {
  /** 何も送らないまま この時間（ミリ秒）が過ぎたら生存確認を送る。0で無効 */
  heartbeatMs: number;
  /** いまの時刻 */
  now: number;
}

function describeStatus(status: HealthStatus, outcome: CycleOutcome): string {
  if (status === "no_data") {
    return (
      `${outcome.total}銘柄すべてで実データを取得できていません。` +
      "取得先が遮断されたか、ネットワークが落ちている可能性があります。" +
      "この間シグナルは出ません（合成データでは通知しない設計のため）。"
    );
  }
  return (
    `${outcome.total}銘柄すべてで判定に失敗しています。` +
    "ログに例外の内容が出ています。"
  );
}

function formatDuration(ms: number): string {
  const hours = Math.floor(ms / 3_600_000);
  if (hours < 1) return `${Math.max(Math.floor(ms / 60_000), 1)}分`;
  if (hours < 48) return `${hours}時間`;
  return `${Math.floor(hours / 24)}日`;
}

/**
 * 前回の健康状態と今回の結果を比べて、送るべき知らせを決める。
 *
 * シグナルと同じく、状態は書き換えずに次の状態を返す。送信に失敗したら
 * 呼び出し側が保存を見送り、次回もう一度試せるようにするため。
 */
export function diffHealth(
  previous: HealthState,
  outcome: CycleOutcome,
  options: DiffHealthOptions,
): { notice: HealthNotice | null; nextState: HealthState } {
  const { now, heartbeatMs } = options;
  const status = assessCycle(outcome);

  // 状態が変わった
  if (status !== previous.status) {
    const notice: HealthNotice =
      status === "ok"
        ? {
            kind: "recovered",
            title: "監視が復旧しました",
            body:
              `${formatDuration(now - previous.since)}ぶりに判定できました` +
              `（${outcome.evaluated}/${outcome.total}銘柄）。`,
          }
        : {
            kind: "problem",
            title: "監視が止まっています",
            body: describeStatus(status, outcome),
          };

    return {
      notice,
      nextState: { status, since: now, lastNotifiedAt: now },
    };
  }

  // 状態は同じ。何も送らないまま時間が経ちすぎていないか
  const quietFor = now - previous.lastNotifiedAt;
  if (heartbeatMs > 0 && quietFor >= heartbeatMs) {
    const notice: HealthNotice =
      status === "ok"
        ? {
            kind: "heartbeat",
            title: "監視は動いています",
            body:
              `${formatDuration(quietFor)}のあいだシグナルはありません。` +
              `${outcome.evaluated}/${outcome.total}銘柄を判定しています。` +
              "これは正常です（シグナルは1銘柄あたり平均4.3日に1回しか出ません）。",
          }
        : {
            kind: "problem",
            title: "監視が止まったままです",
            body:
              `${formatDuration(now - previous.since)}のあいだ復旧していません。` +
              describeStatus(status, outcome),
          };

    return {
      notice,
      nextState: { ...previous, lastNotifiedAt: now },
    };
  }

  return { notice: null, nextState: previous };
}

/**
 * シグナルを送ったことを記録する。
 *
 * 生存確認は「何も送っていない時間」で測るので、シグナルを送ったなら
 * その時計も進める。シグナルが出た直後に「動いています」が来るのは
 * 無意味なため。
 */
export function markNotified(state: HealthState, now: number): HealthState {
  return { ...state, lastNotifiedAt: now };
}
