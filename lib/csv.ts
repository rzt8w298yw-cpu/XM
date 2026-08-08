/**
 * ローソク足CSVの読み込み
 *
 * MT4 / MT5 のエクスポートや一般的なCSVをそのまま読めるようにしている。
 * - 区切り文字はカンマ / タブ / セミコロンを自動判別
 * - ヘッダは `<DATE>` `<OPEN>` のような山括弧付きでも、大文字small文字混在でもよい
 * - 日付と時刻が別列（MT5の `<DATE>` + `<TIME>`）でも、1列にまとまっていてもよい
 * - 日付の区切りは `2024.01.15` `2024/01/15` `2024-01-15` のいずれでもよい
 * - ヘッダが無い場合は 日時,始値,高値,安値,終値 の並びとみなす
 */
import type { OHLC } from "./technicalAnalysis";

const DELIMITERS = [",", "\t", ";"] as const;

/** 列名の揺れを吸収するための別名表 */
const ALIASES: Record<string, string[]> = {
  date: ["date", "日付"],
  time: ["time", "時刻"],
  timestamp: ["timestamp", "datetime", "date_time", "datetime_utc", "日時"],
  open: ["open", "o", "始値"],
  high: ["high", "h", "高値"],
  low: ["low", "l", "安値"],
  close: ["close", "c", "終値", "price", "adj close"],
};

export interface ParseResult {
  candles: OHLC[];
  /** 数値として解釈できず読み飛ばした行数 */
  skipped: number;
}

export function parseCandleCsv(text: string): ParseResult {
  const lines = text.trim().split(/\r?\n/).filter((line) => line.trim() !== "");
  if (lines.length === 0) throw new Error("データ行がありません");

  const delimiter = detectDelimiter(lines[0]);
  const firstCells = splitRow(lines[0], delimiter);
  const columns = mapColumns(firstCells);

  // ヘッダを解釈できた場合のみ1行目を読み飛ばす
  const hasHeader = columns !== null;
  const layout = columns ?? guessHeaderlessLayout(firstCells);

  if (!hasHeader && firstCells.length < 5) {
    throw new Error(
      `列を判別できません。ヘッダ行に date/time/open/high/low/close を含めるか、` +
        `日時,始値,高値,安値,終値 の5列にしてください（1行目: ${lines[0].slice(0, 80)}）`,
    );
  }

  const candles: OHLC[] = [];
  let skipped = 0;

  for (let i = hasHeader ? 1 : 0; i < lines.length; i++) {
    const cells = splitRow(lines[i], delimiter);
    const timestamp = readTimestamp(cells, layout);
    const open = readNumber(cells, layout.open);
    const high = readNumber(cells, layout.high);
    const low = readNumber(cells, layout.low);
    const close = readNumber(cells, layout.close);

    if (
      timestamp === null || open === null || high === null ||
      low === null || close === null
    ) {
      skipped++;
      continue;
    }
    candles.push({ timestamp, open, high, low, close });
  }

  if (candles.length === 0) {
    throw new Error(`有効な行がありません（${skipped}行を読み飛ばしました）`);
  }

  candles.sort((a, b) => a.timestamp - b.timestamp);
  return { candles, skipped };
}

interface Layout {
  timestamp: number;
  date: number;
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

function detectDelimiter(headerLine: string): string {
  let best = ",";
  let bestCount = -1;
  for (const candidate of DELIMITERS) {
    const count = headerLine.split(candidate).length - 1;
    if (count > bestCount) {
      best = candidate;
      bestCount = count;
    }
  }
  return best;
}

function splitRow(line: string, delimiter: string): string[] {
  return line.split(delimiter).map((cell) => cell.trim().replace(/^"|"$/g, ""));
}

/** ヘッダ行から列位置を割り出す。OHLCが揃わなければ null（ヘッダ無しとみなす） */
function mapColumns(cells: string[]): Layout | null {
  const normalized = cells.map((cell) =>
    cell.toLowerCase().replace(/[<>]/g, "").trim(),
  );
  const find = (key: string) => {
    for (const alias of ALIASES[key]) {
      const index = normalized.indexOf(alias);
      if (index !== -1) return index;
    }
    return -1;
  };

  const layout: Layout = {
    timestamp: find("timestamp"),
    date: find("date"),
    time: find("time"),
    open: find("open"),
    high: find("high"),
    low: find("low"),
    close: find("close"),
  };

  const hasTime = layout.timestamp !== -1 || layout.date !== -1;
  const hasPrices =
    layout.open !== -1 && layout.high !== -1 && layout.low !== -1 && layout.close !== -1;
  return hasTime && hasPrices ? layout : null;
}

/**
 * ヘッダが無い場合の列並びを推測する。
 * MT4のエクスポートは 日付,時刻,始値,高値,安値,終値 で時刻が独立した列になるため、
 * 2列目が HH:MM 形式かどうかで判別する。
 */
function guessHeaderlessLayout(cells: string[]): Layout {
  const secondLooksLikeTime = /^\d{1,2}:\d{2}/.test(cells[1] ?? "");
  return secondLooksLikeTime
    ? { timestamp: -1, date: 0, time: 1, open: 2, high: 3, low: 4, close: 5 }
    : { timestamp: 0, date: -1, time: -1, open: 1, high: 2, low: 3, close: 4 };
}

function readNumber(cells: string[], index: number): number | null {
  if (index < 0 || index >= cells.length) return null;
  const raw = cells[index];
  // Number("") は 0 になるので、空セルは明示的に無効として扱う
  if (raw === undefined || raw === "") return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

function readTimestamp(cells: string[], layout: Layout): number | null {
  if (layout.date !== -1) {
    const datePart = cells[layout.date] ?? "";
    const timePart = layout.time !== -1 ? (cells[layout.time] ?? "") : "";
    return parseDateTime(datePart, timePart);
  }
  if (layout.timestamp !== -1) {
    return parseDateTime(cells[layout.timestamp] ?? "", "");
  }
  return null;
}

/**
 * 日付文字列（＋任意の時刻）をUTCのエポックミリ秒にする。
 * タイムゾーン指定が無い場合はUTCとして扱う。ブローカーのエクスポートは
 * サーバー時刻（多くはEET）なので、必要なら呼び出し側で補正する。
 */
export function parseDateTime(datePart: string, timePart: string): number | null {
  const raw = `${datePart} ${timePart}`.trim();
  if (raw === "") return null;

  // エポック秒 / ミリ秒
  if (/^\d+$/.test(raw)) {
    const n = Number(raw);
    return raw.length <= 10 ? n * 1000 : n;
  }

  // 2024.01.15 / 2024/01/15 → 2024-01-15
  const normalized = raw.replace(/^(\d{4})[./](\d{1,2})[./](\d{1,2})/, "$1-$2-$3");

  const match = normalized.match(
    /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?/,
  );
  if (match) {
    // タイムゾーン表記が付いている場合は Date.parse に任せる
    if (/[zZ]$|[+-]\d{2}:?\d{2}$/.test(normalized)) {
      const parsed = Date.parse(normalized);
      return Number.isNaN(parsed) ? null : parsed;
    }
    return Date.UTC(
      Number(match[1]), Number(match[2]) - 1, Number(match[3]),
      Number(match[4] ?? 0), Number(match[5] ?? 0), Number(match[6] ?? 0),
    );
  }

  const parsed = Date.parse(normalized);
  return Number.isNaN(parsed) ? null : parsed;
}

/**
 * 足の並びを点検し、気になる点を文章で返す。
 * ブローカーのエクスポートは欠損・重複・週末の足が混じることがあるため、
 * バックテスト前に気づけるようにしている。
 */
export function inspectCandles(candles: OHLC[], expectedStepMs: number): string[] {
  const notes: string[] = [];
  if (candles.length < 2) return notes;

  let duplicates = 0;
  let gaps = 0;
  let largestGapMs = 0;
  let invalid = 0;

  for (let i = 1; i < candles.length; i++) {
    const delta = candles[i].timestamp - candles[i - 1].timestamp;
    if (delta === 0) duplicates++;
    else if (delta > expectedStepMs) {
      gaps++;
      largestGapMs = Math.max(largestGapMs, delta);
    }
  }

  for (const candle of candles) {
    const hi = Math.max(candle.open, candle.close);
    const lo = Math.min(candle.open, candle.close);
    if (candle.high < hi || candle.low > lo || candle.high < candle.low) invalid++;
  }

  if (duplicates > 0) notes.push(`同じ時刻の足が ${duplicates} 件あります`);
  if (invalid > 0) notes.push(`高値/安値が始値・終値と矛盾する足が ${invalid} 件あります`);
  if (gaps > 0) {
    const hours = Math.round(largestGapMs / 3_600_000);
    notes.push(`時間の飛びが ${gaps} 箇所（最大 ${hours} 時間）。週末や祝日なら正常です`);
  }
  return notes;
}
