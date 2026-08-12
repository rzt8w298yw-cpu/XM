/**
 * ミューテーション中断からの復旧。
 *
 * ここが働かないと、書き換えたままのソースが残る。git status には出るので
 * 気づけるが、気づかずコミットすれば壊れた判定がそのまま入る。
 * 実際に2回起きている（timeout による強制終了と、コンテナの再起動）。
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clearJournal,
  describeRecovery,
  recoverFromJournal,
  writeJournal,
} from "../lib/mutationJournal";

const ORIGINAL = "const wins = trades.filter((t) => t.pips > 0);\n";
const MUTATED = "const wins = trades.filter((t) => t.pips >= 0);\n";

describe("recoverFromJournal", () => {
  let dir: string;
  let source: string;
  let journal: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "mutation-journal-"));
    source = join(dir, "source.ts");
    journal = join(dir, "pending.json");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("控えが無ければ何もしない", () => {
    expect(recoverFromJournal(journal)).toEqual({ kind: "nothing" });
  });

  it("書き換わったままなら元に戻す", () => {
    writeFileSync(source, MUTATED, "utf8");
    writeJournal(journal, {
      file: source, original: ORIGINAL, mutated: MUTATED, description: "勝ちの判定",
    });

    const outcome = recoverFromJournal(journal);

    expect(outcome).toEqual({ kind: "restored", file: source, description: "勝ちの判定" });
    expect(readFileSync(source, "utf8")).toBe(ORIGINAL);
    // 控えは片付ける。残すと次回また同じ判断を繰り返す
    expect(existsSync(journal)).toBe(false);
  });

  it("既に戻っていれば触らない", () => {
    writeFileSync(source, ORIGINAL, "utf8");
    writeJournal(journal, {
      file: source, original: ORIGINAL, mutated: MUTATED, description: "x",
    });

    expect(recoverFromJournal(journal)).toEqual({ kind: "nothing" });
    expect(readFileSync(source, "utf8")).toBe(ORIGINAL);
  });

  it("中断のあとで人が触っていれば、その変更を消さない", () => {
    const edited = ORIGINAL + "// 人が足した行\n";
    writeFileSync(source, edited, "utf8");
    writeJournal(journal, {
      file: source, original: ORIGINAL, mutated: MUTATED, description: "x",
    });

    const outcome = recoverFromJournal(journal);

    expect(outcome).toEqual({ kind: "changed", file: source });
    // 復旧のつもりで人の作業を消すほうが、書き換わったまま残るより悪い
    expect(readFileSync(source, "utf8")).toBe(edited);
    expect(existsSync(journal)).toBe(false);
  });

  it("控えが壊れていても例外にしない", () => {
    writeFileSync(journal, "{ これはJSONではない", "utf8");
    const outcome = recoverFromJournal(journal);
    expect(outcome.kind).toBe("unreadable");
    expect(existsSync(journal)).toBe(false);
  });

  it("控えの形が違えば読めないものとして扱う", () => {
    writeFileSync(journal, JSON.stringify({ file: 1, original: null }), "utf8");
    expect(recoverFromJournal(journal).kind).toBe("unreadable");
  });

  it("控えの指すファイルが消えていても例外にしない", () => {
    writeJournal(journal, {
      file: join(dir, "存在しない.ts"), original: ORIGINAL, mutated: MUTATED, description: "x",
    });
    expect(recoverFromJournal(journal).kind).toBe("unreadable");
    expect(existsSync(journal)).toBe(false);
  });

  it("clearJournal は無ければ黙って終わる", () => {
    expect(() => clearJournal(journal)).not.toThrow();
  });
});

describe("describeRecovery", () => {
  it("何もしていなければ黙る", () => {
    expect(describeRecovery({ kind: "nothing" })).toBeNull();
  });

  it("戻したことと理由を伝える", () => {
    const text = describeRecovery({
      kind: "restored", file: "lib/backtest.ts", description: "勝ちの判定",
    });
    expect(text).toMatch(/中断されていました/);
    expect(text).toMatch(/lib\/backtest\.ts/);
    expect(text).toMatch(/勝ちの判定/);
  });

  it("触らなかった場合は確認を促す", () => {
    const text = describeRecovery({ kind: "changed", file: "lib/a.ts" });
    expect(text).toMatch(/自動では戻しません/);
  });
});
