/**
 * 市場データ取得層
 *
 * 既定では Yahoo Finance のチャートAPIから実データを取得する（APIキー不要）。
 * 外部ネットワークが使えない環境やAPI障害時は、決定論的な合成データに
 * フォールバックしてアプリ全体が動く状態を保つ。
 * `MARKET_DATA_PROVIDER=mock` を設定すると常に合成データを使う。
 */
import type { OHLC } from "./technicalAnalysis";

export interface SymbolSpec {
  /** アプリ内で使うシンボル名 */
  id: string;
  label: string;
  /** Yahoo Finance 上のティッカー */
  yahoo: string;
  /** 1pipあたりの価格差 */
  pipSize: number;
  /** 表示桁数 */
  digits: number;
  /** 合成データの基準価格 */
  basePrice: number;
  /**
   * 決済通貨。ロット計算でpip価値を求める際、口座通貨と違えば換算が要る。
   * 例: USDJPY の決済通貨は JPY
   */
  quoteCurrency: string;
}

export const SYMBOLS: SymbolSpec[] = [
  { id: "USDJPY", label: "USD/JPY", yahoo: "USDJPY=X", pipSize: 0.01, digits: 3, basePrice: 155.0, quoteCurrency: "JPY" },
  { id: "EURUSD", label: "EUR/USD", yahoo: "EURUSD=X", pipSize: 0.0001, digits: 5, basePrice: 1.08, quoteCurrency: "USD" },
  { id: "GBPUSD", label: "GBP/USD", yahoo: "GBPUSD=X", pipSize: 0.0001, digits: 5, basePrice: 1.27, quoteCurrency: "USD" },
  { id: "EURJPY", label: "EUR/JPY", yahoo: "EURJPY=X", pipSize: 0.01, digits: 3, basePrice: 167.0, quoteCurrency: "JPY" },
  { id: "GBPJPY", label: "GBP/JPY", yahoo: "GBPJPY=X", pipSize: 0.01, digits: 3, basePrice: 197.0, quoteCurrency: "JPY" },
  { id: "AUDUSD", label: "AUD/USD", yahoo: "AUDUSD=X", pipSize: 0.0001, digits: 5, basePrice: 0.65, quoteCurrency: "USD" },
  { id: "XAUUSD", label: "GOLD (XAU/USD)", yahoo: "XAUUSD=X", pipSize: 0.1, digits: 2, basePrice: 2600.0, quoteCurrency: "USD" },
];

/**
 * シグナルを出す銘柄。
 *
 * `SYMBOLS` は「仕様（pipの大きさ・桁数）が分かっている銘柄」の一覧で、
 * バックテストや検証はここに載っているものを全部扱える。**実際にシグナルを
 * 出して通知する銘柄はそれとは別**で、こちらで絞る。
 *
 * 2つを分けているのは、検証の範囲を狭めずに監視の範囲だけを決めたいため。
 * 12通貨ペアで確かめた結果は判断の材料として要るが、通知を12本受け取る
 * 必要は無い。
 *
 * `getSymbolSpec` を通すので、綴りを間違えた時点で起動に失敗する。
 * 一覧に無いIDを黙って読み飛ばして「監視対象0件」になるより、その場で
 * 止まったほうがいい。
 */
const SIGNAL_SYMBOL_IDS = ["USDJPY"];

/** 知っている銘柄なら仕様を返す。知らなければ null */
export function findSymbolSpec(id: string): SymbolSpec | null {
  return SYMBOLS.find((s) => s.id === id) ?? null;
}

/**
 * 銘柄の仕様を返す。知らない銘柄なら例外にする。
 *
 * 以前はここで `?? SYMBOLS[0]`（＝USD/JPY）に落としていた。そのため
 * `--symbol EURCHF` のように一覧に無い銘柄を渡すと、**pipの大きさが
 * 0.0001 ではなく 0.01 として扱われ、損益が黙って100倍ずれた。**
 * `scripts/fetchRealData.ts` は一覧に無い銘柄（EURCHF / EURGBP / AUDJPY /
 * USDCAD / USDCHF）も取得できるので、実際に踏める道だった。
 *
 * 桁がずれても値動きの形は変わらないので、グラフを見ても気づけない。
 * 気づけないものは、黙って通してはいけない。
 */
export const SIGNAL_SYMBOLS: SymbolSpec[] = SIGNAL_SYMBOL_IDS.map((id) =>
  getSymbolSpec(id),
);

export function getSymbolSpec(id: string): SymbolSpec {
  const spec = findSymbolSpec(id);
  if (spec === null) {
    throw new Error(
      `未対応の銘柄です: ${id}（指定できるのは ${SYMBOLS.map((s) => s.id).join(", ")}）。` +
        "pipの大きさが銘柄ごとに違うため、既定値で代用すると損益が桁で狂います",
    );
  }
  return spec;
}

export interface MarketData {
  symbol: string;
  candles1H: OHLC[];
  candles4H: OHLC[];
  candles8H: OHLC[];
  candlesDaily: OHLC[];
  /** 実データか合成データか */
  source: "yahoo" | "synthetic";
  /** 合成データにフォールバックした理由 */
  note?: string;
}

const HOUR_MS = 3600_000;

export interface FetchOptions {
  /** 1H足の取得期間。Yahooの1H足は最大730日まで */
  range1H?: string;
  /** 日足の取得期間 */
  rangeDaily?: string;
  /** 合成データを生成する際の1H足の本数 */
  syntheticBars?: number;
}

/**
 * 指定シンボルのマルチタイムフレームデータを取得。
 * 1H足を基に4H/8H足を集約して作る（Yahooは4H/8H足を配信していないため）。
 */
export async function fetchMarketData(
  symbolId: string,
  options: FetchOptions = {},
): Promise<MarketData> {
  const spec = getSymbolSpec(symbolId);
  const { range1H = "60d", rangeDaily = "2y", syntheticBars = 1200 } = options;

  if (process.env.MARKET_DATA_PROVIDER === "mock") {
    return buildSynthetic(spec, "MARKET_DATA_PROVIDER=mock が設定されています", syntheticBars);
  }

  try {
    const [candles1H, candlesDaily] = await Promise.all([
      fetchYahooCandles(spec.yahoo, "1h", range1H),
      fetchYahooCandles(spec.yahoo, "1d", rangeDaily),
    ]);

    // EMA200を1H足で計算するため最低200本、余裕をみて250本を要求
    if (candles1H.length < 250 || candlesDaily.length < 60) {
      return buildSynthetic(
        spec,
        `取得本数が不足しています (1H: ${candles1H.length}本, 日足: ${candlesDaily.length}本)`,
        syntheticBars,
      );
    }

    return {
      symbol: spec.id,
      candles1H,
      candles4H: aggregate(candles1H, 4),
      candles8H: aggregate(candles1H, 8),
      candlesDaily,
      source: "yahoo",
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return buildSynthetic(spec, `実データの取得に失敗しました: ${message}`, syntheticBars);
  }
}

// ============================================================
// Yahoo Finance
// ============================================================

interface YahooChartResponse {
  chart?: {
    result?: Array<{
      timestamp?: number[];
      indicators?: {
        quote?: Array<{
          open?: (number | null)[];
          high?: (number | null)[];
          low?: (number | null)[];
          close?: (number | null)[];
        }>;
      };
    }>;
    error?: { description?: string } | null;
  };
}

async function fetchYahooCandles(
  ticker: string,
  interval: string,
  range: string,
): Promise<OHLC[]> {
  const url =
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}` +
    `?interval=${interval}&range=${range}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { "User-Agent": "Mozilla/5.0 (compatible; xm-auto-signal/0.1)" },
      cache: "no-store",
    });
    if (!response.ok) {
      throw new Error(`Yahoo API が HTTP ${response.status} を返しました`);
    }

    const json = (await response.json()) as YahooChartResponse;
    if (json.chart?.error) {
      throw new Error(json.chart.error.description ?? "Yahoo API エラー");
    }

    const result = json.chart?.result?.[0];
    const timestamps = result?.timestamp;
    const quote = result?.indicators?.quote?.[0];
    if (!timestamps || !quote) {
      throw new Error("Yahoo API のレスポンス形式が想定と異なります");
    }

    const candles: OHLC[] = [];
    for (let i = 0; i < timestamps.length; i++) {
      const open = quote.open?.[i];
      const high = quote.high?.[i];
      const low = quote.low?.[i];
      const close = quote.close?.[i];
      // 市場が閉じている時間帯は null が入るので除外する
      if (
        typeof open !== "number" ||
        typeof high !== "number" ||
        typeof low !== "number" ||
        typeof close !== "number"
      ) {
        continue;
      }
      candles.push({ timestamp: timestamps[i] * 1000, open, high, low, close });
    }
    return candles;
  } finally {
    clearTimeout(timeout);
  }
}

// ============================================================
// 集約
// ============================================================

/**
 * 1H足を上位足に集約する。
 *
 * 区切りはUTCの絶対時刻（timestamp / factor時間）で決める。配列の先頭から
 * factor本ずつ数える方式にすると、取得ウィンドウが1本ずれただけで全ての
 * 上位足の区切り位置がずれ、8Hトレンドや4H MACDの判定が別物になってしまう。
 * 絶対時刻で区切れば、いつ取得しても同じ足が組み上がる。
 */
export function aggregate(candles1H: OHLC[], factor: number): OHLC[] {
  const bucketMs = factor * HOUR_MS;
  const buckets = new Map<number, OHLC[]>();

  for (const candle of candles1H) {
    const key = Math.floor(candle.timestamp / bucketMs) * bucketMs;
    const bucket = buckets.get(key);
    if (bucket) bucket.push(candle);
    else buckets.set(key, [candle]);
  }

  return [...buckets.keys()]
    .sort((a, b) => a - b)
    .map((key) => {
      const chunk = buckets.get(key)!;
      return {
        timestamp: key,
        open: chunk[0].open,
        high: Math.max(...chunk.map((c) => c.high)),
        low: Math.min(...chunk.map((c) => c.low)),
        close: chunk[chunk.length - 1].close,
      };
    });
}

// ============================================================
// 合成データ（オフライン用フォールバック）
// ============================================================

function buildSynthetic(spec: SymbolSpec, note: string, bars1H = 1200): MarketData {
  // 直近の完了済み1H足を終端にする
  const endTime = Math.floor(Date.now() / HOUR_MS) * HOUR_MS;
  const candles1H = generateSyntheticCandles(spec, bars1H, HOUR_MS, endTime);
  const dailyBars = Math.max(400, Math.ceil(bars1H / 24) + 250);
  const candlesDaily = generateSyntheticCandles(spec, dailyBars, 24 * HOUR_MS, endTime);

  return {
    symbol: spec.id,
    candles1H,
    candles4H: aggregate(candles1H, 4),
    candles8H: aggregate(candles1H, 8),
    candlesDaily,
    source: "synthetic",
    note,
  };
}

/**
 * 決定論的な擬似ランダム（seeded）でトレンドとノイズを持つ足を生成する。
 * シンボルごとに同じ系列になるので、UIやテストの結果が再現できる。
 */
function generateSyntheticCandles(
  spec: SymbolSpec,
  count: number,
  stepMs: number,
  endTime: number,
): OHLC[] {
  const rand = mulberry32(hashString(spec.id + stepMs));
  const volatility = spec.basePrice * 0.0012;

  const candles: OHLC[] = [];
  let price = spec.basePrice;
  // 数十本ごとに向きが変わる緩やかなトレンドを重ねる
  let drift = (rand() - 0.5) * volatility * 0.4;

  for (let i = 0; i < count; i++) {
    if (i % 60 === 0) drift = (rand() - 0.5) * volatility * 0.4;

    const open = price;
    const change = drift + (rand() - 0.5) * volatility * 2;
    const close = open + change;
    const wick = Math.abs(change) * 0.5 + rand() * volatility * 0.6;
    const high = Math.max(open, close) + wick * rand();
    const low = Math.min(open, close) - wick * rand();

    candles.push({
      timestamp: endTime - (count - 1 - i) * stepMs,
      open,
      high,
      low,
      close,
    });
    price = close;
  }
  return candles;
}

function hashString(value: string): number {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 最新の足がどれくらい前のものかを文章にする。
 *
 * リアルタイム運用では「今の判定が古い足で出ていないか」が分からないと危ない。
 * 1H足なので通常は0〜60分前に収まり、それを大きく超える場合は取得が
 * 止まっているか市場が閉じている。
 */
export function describeCandleAge(
  latestCandleTime: number,
  now: number,
  staleAfterMinutes = 120,
): { minutes: number; label: string; stale: boolean } {
  const minutes = Math.max(0, Math.floor((now - latestCandleTime) / 60_000));
  const label =
    minutes < 60
      ? `${minutes}分前`
      : `${Math.floor(minutes / 60)}時間${minutes % 60}分前`;
  return { minutes, label, stale: minutes >= staleAfterMinutes };
}
