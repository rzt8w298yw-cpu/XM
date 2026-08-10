/**
 * シグナルの予測力を、決済から切り離して測る
 *
 *   npx tsx scripts/predictive.ts --timeframe daily --dir data
 *   npx tsx scripts/predictive.ts --timeframe hourly --csv data/usdjpy_h1_utc.csv
 *
 * ここまでの検証はすべて同じ決済（1.5ATRの損切り・1:2の利確・保有上限）を
 * 通していた。そしてどのルールも、勝率が損益分岐のすぐ上に張り付いた。
 * これは2通りに読める。
 *
 *   (a) エントリーに情報が無い
 *   (b) 情報はあるが、この決済が捨てている
 *
 * 損切りと利確は経路に依存する。行き先が同じでも、途中で損切りに触れば
 * 負けになる。だから決済を挟んだ計測は、この2つを区別できない。
 *
 * ここでは決済を外す。シグナルが出たら n本後の終値と比べるだけ。
 * 損切りも利確もコストも無い、**方向が当たっているかどうか**だけの計測。
 * これで何も出ないなら、決済を工夫しても出るものは無い。
 *
 * 有意性は並べ替え検定で見る。t検定は観測が独立である前提を置くが、
 * 期間が重なるシグナルは独立ではないので、そのまま使うと過大に出る。
 * 代わりに「同じシグナル位置のまま向きだけをコインで決め直す」のを
 * 何千回も行い、実際の平均がその分布のどこに入るかを見る。重なりの
 * 構造は帰無仮説側にも同じだけ入るので、そこは打ち消される。
 */
import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { parseCandleCsv } from "../lib/csv";
import {
  DAILY_RULES,
  HOURLY_RULES,
  buildContext,
  scanRule,
  type EntryRule,
} from "../lib/hypotheses";
import { calculateATR, type OHLC } from "../lib/technicalAnalysis";

const PERMUTATIONS = 5000;

interface Args {
  timeframe: "hourly" | "daily";
  files: string[];
  horizons: number[];
  rule?: string;
  /** 0 なら分割しない。0.6 なら前半60%と後半40%を別々に出す */
  splitRatio: number;
}

function specFromFilename(path: string): { symbol: string; pipSize: number } {
  const symbol = basename(path).split("_")[0].toUpperCase();
  if (symbol.startsWith("XAU")) return { symbol, pipSize: 0.1 };
  if (symbol.endsWith("JPY")) return { symbol, pipSize: 0.01 };
  return { symbol, pipSize: 0.0001 };
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

  const timeframe = (map.get("timeframe") ?? "daily") as "hourly" | "daily";
  if (timeframe !== "hourly" && timeframe !== "daily") {
    throw new Error("--timeframe は hourly か daily で指定してください");
  }

  const suffix = timeframe === "daily" ? "_d1_utc.csv" : "_h1_utc.csv";
  const dir = map.get("dir");
  const csv = map.get("csv");
  let files: string[];
  if (dir) {
    files = readdirSync(dir).filter((n) => n.endsWith(suffix)).sort().map((n) => join(dir, n));
    if (files.length === 0) throw new Error(`${dir} に ${suffix} で終わるファイルがありません`);
  } else if (csv) {
    files = [csv];
  } else {
    throw new Error("--dir か --csv を指定してください");
  }

  const horizonRaw = map.get("horizons") ?? (timeframe === "daily" ? "1,3,5,10,20" : "1,4,8,24,48");
  const horizons = horizonRaw.split(",").map(Number);
  if (horizons.some((h) => !Number.isFinite(h) || h < 1)) {
    throw new Error(`--horizons が不正です: ${horizonRaw}`);
  }

  const splitRaw = map.get("split");
  const splitRatio = splitRaw === undefined ? 0 : Number(splitRaw);
  if (!Number.isFinite(splitRatio) || splitRatio < 0 || splitRatio >= 1) {
    throw new Error(`--split は 0 以上 1 未満で指定してください: ${splitRaw}`);
  }

  return { timeframe, files, horizons, rule: map.get("rule"), splitRatio };
}

/** シグナル1件ぶんの、向きを掛ける前の先行リターン */
interface Observation {
  symbol: string;
  /** +1 = BUY, -1 = SELL */
  sign: number;
  /** 期間ごとの、その後の値動き（ATR何個ぶんか） */
  forwardAtr: number[];
  /** 期間ごとの、その後の値動き（pips） */
  forwardPips: number[];
}

function collect(
  rule: EntryRule,
  candles: OHLC[],
  atr: number[],
  pipSize: number,
  symbol: string,
  horizons: number[],
  from = 250,
  to = candles.length,
): Observation[] {
  const ctx = buildContext(candles);
  const maxHorizon = Math.max(...horizons);
  const scan = scanRule(rule, ctx, from, Math.min(to, candles.length - maxHorizon));
  const out: Observation[] = [];

  for (const hit of scan.hits) {
    const entry = candles[hit.index].close;
    const scale = atr[hit.index];
    if (!Number.isFinite(scale) || scale <= 0) continue;

    const forwardAtr: number[] = [];
    const forwardPips: number[] = [];
    let usable = true;
    for (const h of horizons) {
      const later = candles[hit.index + h];
      if (!later) {
        usable = false;
        break;
      }
      forwardAtr.push((later.close - entry) / scale);
      forwardPips.push((later.close - entry) / pipSize);
    }
    if (!usable) continue;

    out.push({ symbol, sign: hit.direction === "BUY" ? 1 : -1, forwardAtr, forwardPips });
  }
  return out;
}

function makeRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function mean(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length;
}

/**
 * 並べ替え検定。向きだけをコインで決め直した分布と比べる。
 *
 * p値は「でたらめな向きでも、これくらいの平均が出る確率」。
 * 0.05 を下回れば、向きに情報がある可能性が出てくる（7ルール×5期間を
 * 試している点は、読むときに割り引くこと）。
 */
function permutationTest(
  observations: Observation[],
  horizonIndex: number,
  seed: number,
): { actual: number; p: number; nullMean: number; nullSpread: number } {
  const raw = observations.map((o) => o.forwardAtr[horizonIndex]);
  const signs = observations.map((o) => o.sign);
  const actual = mean(raw.map((v, i) => v * signs[i]));

  const rand = makeRandom(seed);
  const nulls: number[] = [];
  let atLeastAsExtreme = 0;

  for (let p = 0; p < PERMUTATIONS; p++) {
    let total = 0;
    for (let i = 0; i < raw.length; i++) total += rand() < 0.5 ? raw[i] : -raw[i];
    const value = total / raw.length;
    nulls.push(value);
    // 片側ではなく両側で見る。「逆に効いている」も見つけたい
    if (Math.abs(value) >= Math.abs(actual)) atLeastAsExtreme++;
  }

  const nullMean = mean(nulls);
  const nullSpread = Math.sqrt(mean(nulls.map((v) => (v - nullMean) ** 2)));
  return { actual, p: atLeastAsExtreme / PERMUTATIONS, nullMean, nullSpread };
}

function fmt(v: number, d = 3): string {
  return Number.isFinite(v) ? v.toFixed(d) : "—";
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const catalogue = args.timeframe === "daily" ? DAILY_RULES : HOURLY_RULES;
  const rules = args.rule ? catalogue.filter((r) => r.id === args.rule) : catalogue;
  if (rules.length === 0) {
    throw new Error(`--rule が不正です（指定できるのは ${catalogue.map((r) => r.id).join(", ")}）`);
  }

  const datasets = args.files.map((path) => {
    const { symbol, pipSize } = specFromFilename(path);
    const candles = parseCandleCsv(readFileSync(path, "utf8")).candles;
    return { symbol, candles, atr: calculateATR(candles, 14), pipSize };
  });

  const unit = args.timeframe === "daily" ? "日" : "時間";

  console.log("=".repeat(80));
  console.log("シグナルの予測力（決済を外した計測）");
  console.log("=".repeat(80));
  console.log(`銘柄    : ${datasets.length}件  ${datasets.map((d) => d.symbol).join(" ")}`);
  console.log(`期間    : ${args.horizons.map((h) => `${h}${unit}後`).join(" / ")}`);
  console.log(`検定    : 向きの並べ替え ${PERMUTATIONS}回`);
  console.log("");
  console.log("損切りも利確もコストも無し。シグナルの向きに、その後の値動きが");
  console.log("従っているかだけを見ます。単位はATR（1.0 = 平均的な値幅ぶん動いた）。");
  console.log("");
  console.log("何も無ければ平均は0の近くに散らばります。p値は「でたらめな向きでも");
  console.log(`これくらい出る確率」です。${rules.length}ルール×${args.horizons.length}期間を試すので、`);
  console.log("1つや2つ 0.05 を下回るのはむしろ普通だと思って読んでください。");

  const flagged: string[] = [];

  for (const rule of rules) {
    console.log("");
    console.log("-".repeat(80));

    const periods: { label: string; observations: Observation[] }[] = [];
    if (args.splitRatio > 0) {
      periods.push({
        label: "学習",
        observations: datasets.flatMap((d) =>
          collect(rule, d.candles, d.atr, d.pipSize, d.symbol, args.horizons, 250,
            Math.floor(d.candles.length * args.splitRatio)),
        ),
      });
      periods.push({
        label: "検証",
        observations: datasets.flatMap((d) =>
          collect(rule, d.candles, d.atr, d.pipSize, d.symbol, args.horizons,
            Math.floor(d.candles.length * args.splitRatio), d.candles.length),
        ),
      });
    } else {
      periods.push({
        label: "全期間",
        observations: datasets.flatMap((d) =>
          collect(rule, d.candles, d.atr, d.pipSize, d.symbol, args.horizons),
        ),
      });
    }

    console.log(
      `${rule.name}（${rule.id}）  ` +
        periods.map((p) => `${p.label} ${p.observations.length}件`).join(" / "),
    );

    for (const period of periods) {
      if (period.observations.length < 30) {
        console.log(`  ${period.label}: 件数が足りません`);
        continue;
      }
      if (periods.length > 1) console.log(`  [${period.label}]`);
      console.log(
        `  ${"期間".padEnd(8)}${"平均(ATR)".padStart(11)}${"ばらつき".padStart(11)}` +
          `${"平均(pips)".padStart(12)}${"p値".padStart(8)}${"プラスの銘柄".padStart(14)}`,
      );

      for (let h = 0; h < args.horizons.length; h++) {
        const { actual, p, nullSpread } = permutationTest(period.observations, h, 1234 + h);
        const pips = mean(period.observations.map((o) => o.forwardPips[h] * o.sign));

        // 銘柄ごとに符号を数える。1〜2銘柄で作られた平均かどうかが分かる
        const symbols = [...new Set(period.observations.map((o) => o.symbol))];
        const positive = symbols.filter((sym) => {
          const subset = period.observations.filter((o) => o.symbol === sym);
          return mean(subset.map((o) => o.forwardAtr[h] * o.sign)) > 0;
        }).length;

        const mark = p < 0.05 ? "  ←" : "";
        console.log(
          `  ${`${args.horizons[h]}${unit}後`.padEnd(8)}${fmt(actual).padStart(11)}` +
            `${fmt(nullSpread).padStart(11)}${fmt(pips, 1).padStart(12)}${fmt(p, 3).padStart(8)}` +
            `${`${positive}/${symbols.length}`.padStart(14)}${mark}`,
        );
        if (p < 0.05) {
          flagged.push(`${rule.id} ${period.label} ${args.horizons[h]}${unit}後 (p=${fmt(p, 3)})`);
        }
      }
    }
  }

  console.log("");
  console.log("=".repeat(80));
  const tests = rules.length * args.horizons.length * (args.splitRatio > 0 ? 2 : 1);
  const expected = tests * 0.05;
  if (flagged.length === 0) {
    console.log(`${tests}通り試して、偶然と区別できるものはありませんでした。`);
    console.log("");
    console.log("決済の工夫では解決しません。シグナルの向きに、その後の値動きが");
    console.log("従っていないためです。");
  } else {
    console.log(`p < 0.05 だったもの: ${flagged.length}件 / ${tests}通り`);
    for (const item of flagged) console.log(`  - ${item}`);
    console.log("");
    console.log(`ただし ${tests}通り試せば、何も無くても平均 ${expected.toFixed(1)}件は下回ります。`);
    console.log("この件数がそれを大きく超えていなければ、偶然の範囲です。");
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
