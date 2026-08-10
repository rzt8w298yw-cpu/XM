/**
 * 状態ファイルの永続化の検証。
 *
 * ここが壊れると、全銘柄を初回扱いにして再通知するか、監視が止まる。
 * どちらも無人運用では致命的なので、壊れ方を固定しておく。
 */
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ensureStateWritable,
  loadSignalState,
  saveSignalState,
} from "../lib/signalState";
import type { SignalState } from "../lib/notifier";

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "signal-state-"));
}

const sample: SignalState = {
  USDJPY: { signal: "BUY", barTime: 1_700_000_000_000 },
};

describe("loadSignalState", () => {
  it("ファイルが無ければ空の状態を返す（初回）", () => {
    const result = loadSignalState(join(scratch(), "none.json"));
    expect(result.state).toEqual({});
    expect(result.problem).toBeNull();
  });

  it("書いたものを読み戻せる", () => {
    const path = join(scratch(), "state.json");
    saveSignalState(path, sample);
    expect(loadSignalState(path).state).toEqual(sample);
  });

  it("壊れたJSONでも例外にせず理由を返す", () => {
    const path = join(scratch(), "state.json");
    writeFileSync(path, '{"USDJPY": {"signal": "BUY"');
    const result = loadSignalState(path);
    expect(result.state).toEqual({});
    expect(result.problem).not.toBeNull();
  });

  it("オブジェクトでない中身は拒否する", () => {
    const path = join(scratch(), "state.json");
    writeFileSync(path, "[1,2,3]");
    const result = loadSignalState(path);
    expect(result.state).toEqual({});
    expect(result.problem).toMatch(/想定と異なります/);
  });
});

describe("saveSignalState", () => {
  it("一時ファイルを残さない", () => {
    const path = join(scratch(), "state.json");
    saveSignalState(path, sample);
    expect(existsSync(`${path}.tmp`)).toBe(false);
  });

  it("既存の内容を置き換える", () => {
    const path = join(scratch(), "state.json");
    saveSignalState(path, sample);
    saveSignalState(path, { EURUSD: { signal: "SELL", barTime: 1 } });

    const loaded = loadSignalState(path).state;
    expect(loaded.USDJPY).toBeUndefined();
    expect(loaded.EURUSD).toEqual({ signal: "SELL", barTime: 1 });
  });

  it("読み戻せる形式で書く", () => {
    const path = join(scratch(), "state.json");
    saveSignalState(path, sample);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(sample);
  });

  it("保存先が無ければ例外を投げ、一時ファイルも残さない", () => {
    const path = "/nonexistent-dir-for-test/state.json";
    expect(() => saveSignalState(path, sample)).toThrow();
    expect(existsSync(`${path}.tmp`)).toBe(false);
  });
});

describe("ensureStateWritable", () => {
  it("既に書ける場所なら通る", () => {
    expect(() => ensureStateWritable(join(scratch(), "state.json"))).not.toThrow();
  });

  it("親ディレクトリが無ければ作る", () => {
    const path = join(scratch(), "nested", "deep", "state.json");
    ensureStateWritable(path);
    saveSignalState(path, sample);
    expect(loadSignalState(path).state).toEqual(sample);
  });

  it("作れない場所なら分かる文言で失敗する", () => {
    // 既存のファイルの下にディレクトリは作れない（ENOTDIR）
    const dir = scratch();
    const blocker = join(dir, "blocker");
    writeFileSync(blocker, "");
    expect(() => ensureStateWritable(join(blocker, "state.json"))).toThrow(
      /保存先を作成できません|保存先に書き込めません|ディレクトリではありません/,
    );
  });
});
