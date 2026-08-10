/**
 * シグナル状態の永続化
 *
 * 監視プロセスは「前回どの状態だったか」をこのファイルに持つ。
 * ここが壊れると、全銘柄を初回扱いにして再通知してしまう。
 *
 * 書き込みは一時ファイルに書いてから rename する。rename は同一
 * ファイルシステム上で原子的なので、書き込み途中でプロセスが落ちても
 * 既存のファイルが半端な内容に置き換わることがない。
 */
import {
  accessSync,
  constants,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import type { SignalState } from "./notifier";

export interface LoadStateResult {
  state: SignalState;
  /** 読めなかった場合の理由。初回はnull */
  problem: string | null;
}

/**
 * 状態を読む。壊れていても例外にせず、空の状態と理由を返す。
 * 監視を止めるほどのことではないため。
 */
export function loadSignalState(path: string): LoadStateResult {
  if (!existsSync(path)) return { state: {}, problem: null };

  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return { state: {}, problem: "内容が想定と異なります" };
    }
    return { state: parsed as SignalState, problem: null };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { state: {}, problem: message };
  }
}

/**
 * 状態を原子的に書き込む。
 * 一時ファイルに書いてから rename するので、途中で落ちても
 * 既存のファイルは壊れない。
 */
export function saveSignalState(path: string, state: SignalState): void {
  const tmpPath = `${path}.tmp`;
  try {
    writeFileSync(tmpPath, JSON.stringify(state, null, 2), "utf8");
    renameSync(tmpPath, path);
  } catch (error) {
    // 一時ファイルが残ると次回の書き込みを妨げうるので片付ける
    try {
      if (existsSync(tmpPath)) unlinkSync(tmpPath);
    } catch {
      // 片付けに失敗しても元のエラーを優先する
    }
    throw error;
  }
}

/**
 * 状態ファイルが書ける場所かを起動時に確かめる。
 *
 * 最初の保存まで気づけないと、シグナルが出た瞬間に初めて失敗する。
 * 起動時に分かれば設定を直せる。必要なら親ディレクトリを作る。
 */
export function ensureStateWritable(path: string): void {
  const dir = dirname(path);

  if (!existsSync(dir)) {
    try {
      mkdirSync(dir, { recursive: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`状態ファイルの保存先を作成できません（${dir}）: ${message}`);
    }
  } else if (!statSync(dir).isDirectory()) {
    // 親がファイルだと existsSync は true を返すが保存はできない。
    // ここで弾かないと、最初のシグナルが出た瞬間に初めて失敗する。
    throw new Error(`状態ファイルの保存先がディレクトリではありません（${dir}）`);
  }

  try {
    accessSync(dir, constants.W_OK);
  } catch {
    throw new Error(`状態ファイルの保存先に書き込めません（${dir}）`);
  }

  if (existsSync(path)) {
    try {
      accessSync(path, constants.W_OK);
    } catch {
      throw new Error(`状態ファイルに書き込めません（${path}）`);
    }
  }
}
