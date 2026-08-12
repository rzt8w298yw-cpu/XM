/**
 * シグナルの記録と照合
 *
 * 通知を送るだけでは「何がいつ出て、その後どうなったか」が残らないので、
 * 実運用の成績を後から検証できない。バックテストが良くても実際に同じに
 * なるとは限らないため、実際に出たシグナルを記録し、あとで値動きと
 * 突き合わせられるようにする。
 *
 * 形式は1行1レコードのJSONL。追記だけで済み、途中でプロセスが落ちても
 * それまでの行は壊れない。
 */
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import type { SignalType } from "./autoSignalEngine";
import type { OHLC } from "./technicalAnalysis";
import type { TimeSession } from "./technicalAnalysis";

export interface SignalRecord {
  /** 判定に使った最新1H足の時刻 */
  barTime: number;
  /** 記録した時刻 */
  recordedAt: number;
  symbolId: string;
  signal: Exclude<SignalType, "WAIT">;
  price: number;
  stopLoss: number;
  takeProfit: number;
  confidence: number;
  session: TimeSession;
}

/** 1行1件で追記する。途中で落ちても既存の行は壊れない */
export function appendSignalRecord(path: string, record: SignalRecord): void {
  appendFileSync(path, JSON.stringify(record) + "\n", "utf8");
}

export interface ReadResult {
  records: SignalRecord[];
  /** JSONとして読めなかった行数 */
  malformed: number;
}

/**
 * 記録を読む。壊れた行は数えて飛ばす。
 * 追記中にプロセスが落ちると最終行が途中で切れることがあるため、
 * 1行壊れているだけで全体を読めなくしない。
 */
/**
 * 記録として使える形か確かめる。
 *
 * `JSON.parse` は `any` を返すので、そのまま項目を読むと型は何も
 * 見てくれない。検査を型ガードにしておくと、**この関数を通らない限り
 * `SignalRecord` として扱えない**ことをコンパイラが保証する。
 * 手で書いた検査と、後から足した項目がずれるのを防ぐ。
 */
function isSignalRecord(value: unknown): value is SignalRecord {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.barTime === "number" &&
    typeof record.symbolId === "string" &&
    (record.signal === "BUY" || record.signal === "SELL") &&
    typeof record.price === "number" &&
    typeof record.stopLoss === "number" &&
    typeof record.takeProfit === "number"
  );
}

export function readSignalLog(path: string): ReadResult {
  if (!existsSync(path)) return { records: [], malformed: 0 };

  const lines = readFileSync(path, "utf8").split("\n").filter((l) => l.trim() !== "");
  const records: SignalRecord[] = [];
  let malformed = 0;

  for (const line of lines) {
    try {
      const parsed: unknown = JSON.parse(line);
      if (isSignalRecord(parsed)) records.push(parsed);
      else malformed++;
    } catch {
      malformed++;
    }
  }

  return { records, malformed };
}

export type SignalOutcome = "take_profit" | "stop_loss" | "open" | "no_data";

export interface ReconciledSignal {
  record: SignalRecord;
  outcome: SignalOutcome;
  /** 決着した足の時刻。未決着ならnull */
  resolvedAt: number | null;
  /** スプレッド控除前の損益（pips）。未決着ならnull */
  pips: number | null;
  /** 決着までにかかった1H足の本数 */
  barsToResolve: number | null;
}

/**
 * 記録したシグナルを、その後の実際の値動きと突き合わせる。
 *
 * バックテストの `simulateTrade` と同じ約束事に揃えてある:
 * 同じ足で損切りと利確の両方に触れた場合は損切りを採用する。
 * 1H足からは足の中の到達順が分からないため、成績を良く見せない側を採る。
 */
export function reconcileSignal(
  record: SignalRecord,
  candles1H: OHLC[],
  pipSize: number,
  maxHoldingBars = 120,
): ReconciledSignal {
  // 記録した足より後の足だけを見る（記録時点の足自体は判定に使った足）
  const forward = candles1H.filter((c) => c.timestamp > record.barTime);

  if (forward.length === 0) {
    return { record, outcome: "no_data", resolvedAt: null, pips: null, barsToResolve: null };
  }

  const isBuy = record.signal === "BUY";
  const limit = Math.min(forward.length, maxHoldingBars);

  for (let i = 0; i < limit; i++) {
    const candle = forward[i];
    const hitStop = isBuy ? candle.low <= record.stopLoss : candle.high >= record.stopLoss;
    const hitTarget = isBuy
      ? candle.high >= record.takeProfit
      : candle.low <= record.takeProfit;

    // 悲観側: 両方に触れたら損切り扱い
    if (hitStop) {
      return {
        record,
        outcome: "stop_loss",
        resolvedAt: candle.timestamp,
        pips: signedPips(record.stopLoss, record, pipSize),
        barsToResolve: i + 1,
      };
    }
    if (hitTarget) {
      return {
        record,
        outcome: "take_profit",
        resolvedAt: candle.timestamp,
        pips: signedPips(record.takeProfit, record, pipSize),
        barsToResolve: i + 1,
      };
    }
  }

  return { record, outcome: "open", resolvedAt: null, pips: null, barsToResolve: null };
}

function signedPips(exitPrice: number, record: SignalRecord, pipSize: number): number {
  const direction = record.signal === "BUY" ? 1 : -1;
  return ((exitPrice - record.price) * direction) / pipSize;
}

export interface ForwardTestSummary {
  total: number;
  resolved: number;
  open: number;
  noData: number;
  wins: number;
  losses: number;
  winRate: number;
  netPips: number;
}

/** 照合結果をまとめる。未決着のものは勝敗に数えない */
export function summarizeForwardTest(results: ReconciledSignal[]): ForwardTestSummary {
  const resolved = results.filter((r) => r.outcome === "take_profit" || r.outcome === "stop_loss");
  const wins = resolved.filter((r) => r.outcome === "take_profit");
  const netPips = resolved.reduce((sum, r) => sum + (r.pips ?? 0), 0);

  return {
    total: results.length,
    resolved: resolved.length,
    open: results.filter((r) => r.outcome === "open").length,
    noData: results.filter((r) => r.outcome === "no_data").length,
    wins: wins.length,
    losses: resolved.length - wins.length,
    winRate: resolved.length === 0 ? 0 : (wins.length / resolved.length) * 100,
    netPips,
  };
}
