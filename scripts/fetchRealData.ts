/**
 * 実データの取得と変換
 *
 *   npx tsx scripts/fetchRealData.ts --out data
 *   npx tsx scripts/fetchRealData.ts --symbols all --timeframe d1 --out data
 *   npx tsx scripts/fetchRealData.ts --symbol EURUSD --out data
 *
 * ejtraderLabs/historical-data（GitHubの公開リポジトリ）から実際の1時間足と
 * 日足を取り、バックテストが読める形に直して書き出す。
 *
 * 直す点は2つある。どちらも黙って間違える種類のものなので、ここで明示的に
 * 処理する。
 *
 * 1. 価格が「小数点以下の桁数ぶん10倍した整数」で入っている（81121 = 81.121、
 *    130583 = 1.30583）。そのまま読むとATRもpipsも桁が狂う。
 *
 * 2. 時刻がブローカーのサーバー時刻（EET/EEST = UTC+2/+3）で入っている。
 *    UTCに直さないとセッション判定が2〜3時間ずれる。このデータがEETである
 *    ことは中身から確かめられる: 金曜の最終足が23時、月曜の初足が0時で、
 *    これが夏冬どちらでも変わらない。UTC固定やUTC+1固定なら季節でずれる。
 *    さらに3月と11月に金曜22時終わりが集中していて、EUとUSの夏時間切替日の
 *    ずれと一致する（EUの規則で動いている＝Europe/Athens）。
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const BASE = "https://raw.githubusercontent.com/ejtraderLabs/historical-data/main";
const BROKER_TZ = "Europe/Athens"; // EET/EEST

/**
 * 価格は「小数点以下の桁数ぶん10倍した整数」で入っている。
 * 130583 = 1.30583（5桁）、132244 = 132.244（3桁）、172497 = 1724.97（2桁）。
 *
 * 桁を間違えるとpipの大きさが10倍・100倍ずれる。比率では見えないので、
 * 変換後に「日足の値幅がpipでいくつか」を必ず確かめる（`verifyScale`）。
 */
function conventionFor(symbol: string): { digits: number; pipSize: number } {
  if (symbol.startsWith("XAU")) return { digits: 2, pipSize: 0.1 };
  if (symbol.endsWith("JPY")) return { digits: 3, pipSize: 0.01 };
  return { digits: 5, pipSize: 0.0001 };
}

const ALL_SYMBOLS = [
  "USDJPY", "EURUSD", "GBPUSD", "EURJPY", "GBPJPY", "AUDUSD",
  "AUDJPY", "EURCHF", "EURGBP", "USDCAD", "USDCHF", "XAUUSD",
];

interface Args {
  symbols: string[];
  outDir: string;
  timeframes: ("h1" | "d1")[];
}

function parseArgs(argv: string[]): Args {
  const map = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith("--")) continue;
    const eq = token.indexOf("=");
    if (eq !== -1) map.set(token.slice(2, eq), token.slice(eq + 1));
    else map.set(token.slice(2), argv[++i] ?? "");
  }
  const requested = map.get("symbols") ?? map.get("symbol");
  const symbols = requested === "all"
    ? ALL_SYMBOLS
    : (requested ?? "USDJPY").split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);

  const tfRaw = map.get("timeframe") ?? "h1,d1";
  const timeframes = tfRaw.split(",").map((t) => t.trim()) as ("h1" | "d1")[];
  for (const tf of timeframes) {
    if (tf !== "h1" && tf !== "d1") {
      throw new Error(`--timeframe は h1 か d1 で指定してください: ${tf}`);
    }
  }

  return { symbols, outDir: map.get("out") ?? "data", timeframes };
}

/** 指定のUTC時刻における、そのタイムゾーンのUTCからのずれ（分） */
function offsetMinutes(utcMs: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(new Date(utcMs));

  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? "0");
  const asUtc = Date.UTC(
    get("year"), get("month") - 1, get("day"),
    get("hour") % 24, get("minute"), get("second"),
  );
  return (asUtc - utcMs) / 60_000;
}

/**
 * ブローカー時刻の「壁掛け時計の時刻」をUTCのエポックミリ秒にする。
 *
 * ずれ自体がその時刻に依存するので、仮の値でずれを求めてから引き、
 * もう一度求め直す。切替の前後1時間以外はこれで一致する。
 */
function brokerLocalToUtc(
  y: number, mo: number, d: number, h: number, mi: number,
): number {
  const naive = Date.UTC(y, mo - 1, d, h, mi, 0);
  let utc = naive - offsetMinutes(naive, BROKER_TZ) * 60_000;
  utc = naive - offsetMinutes(utc, BROKER_TZ) * 60_000;
  return utc;
}

interface Row {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

function convert(csv: string, scale: number): { rows: Row[]; skipped: number; duplicates: number } {
  const lines = csv.trim().split(/\r?\n/);
  const header = lines[0].split(",").map((c) => c.trim().toLowerCase());
  const idx = {
    date: header.indexOf("date"),
    open: header.indexOf("open"),
    high: header.indexOf("high"),
    low: header.indexOf("low"),
    close: header.indexOf("close"),
  };
  if (Object.values(idx).some((i) => i === -1)) {
    throw new Error(`列が足りません: ${lines[0]}`);
  }

  const seen = new Set<number>();
  const rows: Row[] = [];
  let skipped = 0;
  let duplicates = 0;

  for (let i = 1; i < lines.length; i++) {
    const cells = lines[i].split(",");
    const stamp = (cells[idx.date] ?? "").trim();
    const match = stamp.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?/);
    if (!match) {
      skipped++;
      continue;
    }
    const timestamp = brokerLocalToUtc(
      Number(match[1]), Number(match[2]), Number(match[3]),
      Number(match[4] ?? "0"), Number(match[5] ?? "0"),
    );

    const price = (key: keyof typeof idx) => {
      const raw = (cells[idx[key]] ?? "").trim();
      if (raw === "") return NaN;
      return Number(raw) / scale;
    };
    const open = price("open");
    const high = price("high");
    const low = price("low");
    const close = price("close");

    if (![open, high, low, close].every(Number.isFinite)) {
      skipped++;
      continue;
    }
    // 秋の切替で同じ壁掛け時刻が2回来る。先に来たほうを残す
    if (seen.has(timestamp)) {
      duplicates++;
      continue;
    }
    seen.add(timestamp);
    rows.push({ timestamp, open, high, low, close });
  }

  rows.sort((a, b) => a.timestamp - b.timestamp);
  return { rows, skipped, duplicates };
}

function toCsv(rows: Row[], digits: number): string {
  const lines = ["datetime,open,high,low,close"];
  for (const r of rows) {
    const stamp = new Date(r.timestamp).toISOString().slice(0, 19).replace("T", " ");
    lines.push(
      `${stamp},${r.open.toFixed(digits)},${r.high.toFixed(digits)},` +
        `${r.low.toFixed(digits)},${r.close.toFixed(digits)}`,
    );
  }
  return lines.join("\n") + "\n";
}

/** OHLCの整合と足の間隔を確かめる。取り違えていれば結果より先にここで出る */
function verify(rows: Row[], label: string, expectedStepMs: number): void {
  let inconsistent = 0;
  for (const r of rows) {
    if (r.high < Math.max(r.open, r.close) || r.low > Math.min(r.open, r.close)) {
      inconsistent++;
    }
  }
  let onStep = 0;
  for (let i = 1; i < rows.length; i++) {
    if (rows[i].timestamp - rows[i - 1].timestamp === expectedStepMs) onStep++;
  }
  const first = new Date(rows[0].timestamp).toISOString().slice(0, 16).replace("T", " ");
  const last = new Date(rows[rows.length - 1].timestamp).toISOString().slice(0, 16).replace("T", " ");
  console.log(`  ${label}: ${rows.length}本  ${first} 〜 ${last} (UTC)`);
  console.log(
    `  ${label}: OHLC矛盾 ${inconsistent}件 / 等間隔 ${onStep}件` +
      `（残りは週末と祝日の飛び）`,
  );
  if (inconsistent > 0) {
    throw new Error(`${label}: 高値安値の矛盾が${inconsistent}件あります。取得元を確認してください`);
  }
}

async function download(url: string): Promise<string> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`${url}: HTTP ${response.status}`);
  }
  return response.text();
}

/**
 * 桁の取り違えを検出する。
 *
 * 桁がずれても値動きの「比率」は変わらないので、チャートを見ても気づけない。
 * 変わるのはpipの大きさだけ。日足の値幅をpipで測れば、10倍・100倍のずれは
 * すぐ出る（為替の日足は数十〜数百pips）。
 */
function verifyScale(rows: Row[], symbol: string, pipSize: number, label: string): void {
  const ranges = rows.map((r) => (r.high - r.low) / pipSize).sort((a, b) => a - b);
  const median = ranges[Math.floor(ranges.length / 2)];
  console.log(`  ${label}: 値幅の中央値 ${median.toFixed(0)} pips`);

  if (median < 10 || median > 3000) {
    throw new Error(
      `${symbol}: 値幅の中央値が ${median.toFixed(0)} pips です。` +
        `価格の桁数の想定（${pipSize}）が違う可能性があります`,
    );
  }
}

async function fetchSymbol(symbol: string, args: Args): Promise<void> {
  const { digits, pipSize } = conventionFor(symbol);
  const scale = 10 ** digits;

  console.log("");
  console.log(`${symbol}（小数${digits}桁 / 1pip = ${pipSize}）`);

  for (const suffix of args.timeframes) {
    const label = suffix === "h1" ? "1H足" : "日足";
    const step = suffix === "h1" ? 3_600_000 : 86_400_000;
    const url = `${BASE}/${symbol}/${symbol}${suffix}.csv`;

    const raw = await download(url);
    const { rows, skipped, duplicates } = convert(raw, scale);
    if (rows.length === 0) throw new Error(`${url}: 有効な行がありません`);

    verify(rows, label, step);
    verifyScale(rows, symbol, pipSize, label);
    if (skipped > 0) console.log(`  ${label}: ${skipped}行を読み飛ばしました`);
    if (duplicates > 0) {
      console.log(`  ${label}: 夏時間の戻りで重複した ${duplicates}行を除きました`);
    }

    const outPath = join(args.outDir, `${symbol.toLowerCase()}_${suffix}_utc.csv`);
    writeFileSync(outPath, toCsv(rows, digits));
    console.log(`  → ${outPath}`);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  mkdirSync(args.outDir, { recursive: true });
  console.log(`取得元: ${BASE}`);
  console.log(`対象  : ${args.symbols.join(", ")}（${args.timeframes.join(", ")}）`);

  const failed: string[] = [];
  for (const symbol of args.symbols) {
    try {
      await fetchSymbol(symbol, args);
    } catch (error) {
      // 1銘柄の失敗で全部止めない。何が落ちたかは最後にまとめて出す
      const message = error instanceof Error ? error.message : String(error);
      console.log(`  取得に失敗しました: ${message}`);
      failed.push(symbol);
    }
  }

  console.log("");
  if (failed.length > 0) console.log(`取得できなかった銘柄: ${failed.join(", ")}`);
  const done = args.symbols.filter((s) => !failed.includes(s));
  if (done.length === 0) return;

  console.log("バックテスト:");
  const first = done[0].toLowerCase();
  console.log(
    `  npm run backtest -- --symbol ${done[0].toUpperCase()} ` +
      `--csv-1h ${args.outDir}/${first}_h1_utc.csv --csv-daily ${args.outDir}/${first}_d1_utc.csv`,
  );
  console.log("エントリー仮説の検証（日足・全銘柄）:");
  console.log(`  npx tsx scripts/hypothesis.ts --timeframe daily --dir ${args.outDir}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
