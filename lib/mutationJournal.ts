/**
 * ミューテーション中断からの復旧
 *
 * `scripts/mutate.ts` はソースを一時的に書き換える。復元を `finally` に
 * 置いていたが、**プロセスが殺されると finally は動かない。** 実際に2回起きた。
 *
 *   - `timeout 20 npx tsx scripts/mutate.ts` で強制終了したとき
 *   - コンテナが再起動したとき
 *
 * どちらも書き換えたままのソースが残った。git status には出るので気づけたが、
 * 気づかずにコミットすれば壊れた判定がそのまま入る。
 *
 * シグナルハンドラでは足りない。テストの実行に `execSync` を使っていて、
 * **メインスレッドが塞がっている間はJSのハンドラが動けない。**
 *
 * そこで死ぬ側で頑張るのをやめた。書き換える前に「何を戻せばよいか」を
 * ファイルに残し、次回の起動時に復旧する。これならSIGKILLでも電源断でも戻せる。
 */
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";

export interface Journal {
  file: string;
  /** 書き換える前の中身 */
  original: string;
  /** 書き換えたあとの中身。これと一致する場合だけ自動で戻す */
  mutated: string;
  description: string;
}

export type RecoveryOutcome =
  /** 控えが無い。通常の起動 */
  | { kind: "nothing" }
  /** 書き換わったままだったので戻した */
  | { kind: "restored"; file: string; description: string }
  /** 中断のあとで人が触っている。触らない */
  | { kind: "changed"; file: string }
  /** 控えが壊れている */
  | { kind: "unreadable"; reason: string };

export function writeJournal(path: string, journal: Journal): void {
  writeFileSync(path, JSON.stringify(journal), "utf8");
}

export function clearJournal(path: string): void {
  rmSync(path, { force: true });
}

/**
 * 前回の中断で書き換わったままのソースを戻す。
 *
 * 現在の中身が「書き換えた姿」と一致する場合だけ戻す。中断のあとで人が
 * 手を入れていたら、その変更を消してしまうので触らない。**復旧のつもりで
 * 人の作業を消すほうが、書き換わったまま残るより悪い。**
 *
 * 控えは、どの結末でも最後に片付ける。残しておくと次回また同じ判断を
 * 繰り返すことになる。
 */
export function recoverFromJournal(path: string): RecoveryOutcome {
  if (!existsSync(path)) return { kind: "nothing" };

  let outcome: RecoveryOutcome;
  try {
    const journal = JSON.parse(readFileSync(path, "utf8")) as Journal;
    if (
      typeof journal?.file !== "string" ||
      typeof journal?.original !== "string" ||
      typeof journal?.mutated !== "string"
    ) {
      throw new Error("控えの形が違います");
    }

    const current = readFileSync(journal.file, "utf8");
    if (current === journal.mutated) {
      writeFileSync(journal.file, journal.original, "utf8");
      outcome = {
        kind: "restored",
        file: journal.file,
        description: journal.description ?? "",
      };
    } else if (current === journal.original) {
      // 既に戻っている（finally が間に合った）
      outcome = { kind: "nothing" };
    } else {
      outcome = { kind: "changed", file: journal.file };
    }
  } catch (error) {
    outcome = {
      kind: "unreadable",
      reason: error instanceof Error ? error.message : String(error),
    };
  }

  clearJournal(path);
  return outcome;
}

/** 復旧の結果を、人が読む1行にする */
export function describeRecovery(outcome: RecoveryOutcome): string | null {
  switch (outcome.kind) {
    case "restored":
      return (
        `前回の実行は中断されていました。${outcome.file} を元に戻しました` +
        (outcome.description ? `（${outcome.description}）` : "") + "。"
      );
    case "changed":
      return (
        `⚠ ${outcome.file} は前回の中断時から変わっています。自動では戻しません。` +
        "内容を確認してください。"
      );
    case "unreadable":
      return `復旧の控えを読めませんでした: ${outcome.reason}`;
    default:
      return null;
  }
}
