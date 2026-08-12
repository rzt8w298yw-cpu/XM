/**
 * 停止の受け付け
 *
 * `watch.ts` は `SIGINT` だけを見て、受けたその場で `process.exit(0)` を
 * 呼んでいた。手元で Ctrl+C を押す分にはそれで足りるが、常駐させると
 * 二つ問題が出る。
 *
 * 1. **systemd や pm2 が送るのは `SIGTERM`。** 待ち受けていないので既定の
 *    動作、つまり即死になる。`await notifier.send(...)` の最中に落ちれば、
 *    その周期の状態は保存されない。
 * 2. **止まるまでに最大で1周期ぶん待たされる。** 間隔は既定300秒なので、
 *    `systemctl stop` は停止タイムアウト（既定90秒）を待ってから
 *    `SIGKILL` することになる。デプロイのたびに毎回そうなる。
 *
 * ここでは停止要求を一つの状態として持ち、待機をその要求で起こせるように
 * する。方針は「**いま走っている周期は最後までやらせる。ただし次の待機は
 * 待たない。**」——判定の途中で切ると通知だけ出て状態が保存されず、次の
 * 起動で同じ通知をもう一度出すことになるため。
 *
 * 二度目の要求は「待てない」の合図として扱い、その場で終わらせる。
 */

/** 停止のきっかけと、呼び出し側が取るべき動き */
export type ShutdownResponse =
  /** 一度目。走っている処理を終わらせてから止まる */
  | "graceful"
  /** 二度目以降。待たずに終わらせてよい */
  | "force";

export interface Shutdown {
  /** 停止を要求されているか */
  readonly stopping: boolean;
  /** 停止を要求した信号の名前。まだなら null */
  readonly reason: string | null;
  /**
   * いま待機中の数。
   *
   * 常駐すると `sleep` は何千回も呼ばれるので、時間切れのたびに内部の
   * 控えが残ると際限なく積み上がる。外から見えないと検証もできないため
   * 数だけ公開する。正常なら 0 か 1 にしかならない。
   */
  readonly pendingWaits: number;
  /** 停止を要求する。戻り値で一度目か二度目かを伝える */
  request(signal: string): ShutdownResponse;
  /**
   * `ms` ミリ秒待つ。停止が要求されたら残りを待たずに起きる。
   * すでに要求済みなら待たずに返る。
   */
  sleep(ms: number): Promise<void>;
}

export function createShutdown(): Shutdown {
  let reason: string | null = null;
  /** 待機中の起こし手。停止要求のときに呼ぶ */
  const waiters = new Set<() => void>();

  return {
    get stopping() {
      return reason !== null;
    },
    get reason() {
      return reason;
    },
    get pendingWaits() {
      return waiters.size;
    },

    request(signal: string): ShutdownResponse {
      if (reason !== null) return "force";
      reason = signal;
      // 走査中に Set が変わらないよう控えを取ってから呼ぶ
      for (const wake of [...waiters]) wake();
      return "graceful";
    },

    sleep(ms: number): Promise<void> {
      if (reason !== null) return Promise.resolve();
      if (!(ms > 0)) return Promise.resolve();

      return new Promise<void>((resolve) => {
        const wake = () => {
          clearTimeout(timer);
          waiters.delete(wake);
          resolve();
        };
        // 時間切れでも起こし手を外す。外し忘れると常駐中に積み上がる
        const timer = setTimeout(wake, ms);
        waiters.add(wake);
      });
    },
  };
}

/**
 * 信号を停止要求に繋ぐ。
 *
 * 二度目を受けたら即座に終わらせる。終了コードは慣例どおり `128 + 信号番号`
 * にする（`SIGINT` は130、`SIGTERM` は143）。プロセスマネージャがこれを見て
 * 「異常終了」と判断し再起動を繰り返すのを避けるため、一度目の穏当な停止は
 * 呼び出し側が正常終了させる。
 */
export const SIGNAL_EXIT_CODES: Record<string, number> = {
  SIGINT: 130,
  SIGTERM: 143,
};

export function forcedExitCode(signal: string): number {
  return SIGNAL_EXIT_CODES[signal] ?? 1;
}
