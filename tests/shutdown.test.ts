import { describe, expect, it } from "vitest";
import { createShutdown, forcedExitCode } from "../lib/shutdown";

describe("createShutdown", () => {
  it("最初は停止を要求されていない", () => {
    const shutdown = createShutdown();
    expect(shutdown.stopping).toBe(false);
    expect(shutdown.reason).toBe(null);
  });

  it("一度目の要求は graceful、二度目以降は force", () => {
    const shutdown = createShutdown();
    expect(shutdown.request("SIGTERM")).toBe("graceful");
    expect(shutdown.request("SIGTERM")).toBe("force");
    expect(shutdown.request("SIGINT")).toBe("force");
  });

  it("最初に受けた信号の名前を覚える", () => {
    const shutdown = createShutdown();
    shutdown.request("SIGTERM");
    shutdown.request("SIGINT");
    // 二度目で上書きされると、停止の理由が実際と食い違う
    expect(shutdown.reason).toBe("SIGTERM");
  });

  it("停止要求が無ければ指定した時間だけ待つ", async () => {
    const shutdown = createShutdown();
    const started = Date.now();
    await shutdown.sleep(40);
    expect(Date.now() - started).toBeGreaterThanOrEqual(30);
  });

  it("待機中に停止を要求されたら残りを待たずに起きる", async () => {
    const shutdown = createShutdown();
    const started = Date.now();
    const waiting = shutdown.sleep(5_000);
    setTimeout(() => shutdown.request("SIGTERM"), 20);
    await waiting;
    // 5秒ではなく、要求が来た時点で返ること
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("すでに停止を要求されていれば待たない", async () => {
    const shutdown = createShutdown();
    shutdown.request("SIGTERM");
    const started = Date.now();
    await shutdown.sleep(5_000);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("0以下の待機は待たない", async () => {
    const shutdown = createShutdown();
    const started = Date.now();
    await shutdown.sleep(0);
    await shutdown.sleep(-1);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("複数の待機を同時に起こせる", async () => {
    const shutdown = createShutdown();
    const waits = [shutdown.sleep(5_000), shutdown.sleep(5_000), shutdown.sleep(5_000)];
    setTimeout(() => shutdown.request("SIGTERM"), 20);
    const started = Date.now();
    await Promise.all(waits);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("時間切れで終わった待機は起こし手を残さない", async () => {
    /*
     * 常駐すると sleep は何千回も呼ばれる。時間切れのたびに起こし手が
     * 残ると、止めるまでの何日ぶんかがそのまま積み上がる。
     */
    const shutdown = createShutdown();
    for (let i = 0; i < 50; i++) await shutdown.sleep(1);
    expect(shutdown.pendingWaits).toBe(0);
  });

  it("停止で起きた待機も起こし手を残さない", async () => {
    const shutdown = createShutdown();
    const waiting = shutdown.sleep(5_000);
    expect(shutdown.pendingWaits).toBe(1);
    shutdown.request("SIGTERM");
    await waiting;
    expect(shutdown.pendingWaits).toBe(0);
  });
});

describe("forcedExitCode", () => {
  it("慣例どおり 128 + 信号番号 を返す", () => {
    expect(forcedExitCode("SIGINT")).toBe(130);
    expect(forcedExitCode("SIGTERM")).toBe(143);
  });

  it("知らない信号は 1 にする", () => {
    expect(forcedExitCode("SIGHUP")).toBe(1);
  });
});
