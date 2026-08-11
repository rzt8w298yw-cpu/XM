/**
 * 標本の外での検証
 *
 *   npx tsx scripts/validateOutOfSample.ts
 *   npx tsx scripts/validateOutOfSample.ts --hold 5 --cache data/fed-h10.csv
 *
 * `turn_of_month_reversal`（月初に前月と逆へ入る）は**事後に見つけたもの**です。
 * 順張り版が逆に効いていたので符号を反転させただけで、先に立てた仮説では
 * ありません。そして反転させた時点で、見つけるのに使った12ペア・2012〜2022年は
 * もう検証に使えません。当てはめたデータで当てはまるのは当たり前だからです。
 *
 * 確かめるには標本の外が要ります。ここでは米連邦準備制度のH.10（22通貨の
 * 対ドル日次レート、1971年〜）を使い、次の3つに分けて同じ計測をします。
 *
 *   - 発見前（1971〜2012）    … 40年ぶん、まったく見ていない
 *   - 発見に使った期間（2012〜2022）
 *   - 発見後（2022〜）        … まったく見ていない
 *
 * 通貨も違います。見つけたときの12ペアに入っていなかったものが多数あります。
 * データの出所も、日次の値を決める時刻も違います。**同じものが別の場所で
 * 出るか**を見るのが目的なので、条件が揃っていないことはむしろ良いことです。
 *
 * 終値しかないので、ATRの代わりに直近の日次変化率のばらつきで正規化します。
 * 売買のシミュレーションもしません。「向きが当たっているか」だけを見ます。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { trackRegime } from "../lib/edgeMath";
import {
  collectMonthEffect,
  mean,
  permutationTest,
  type MonthEffectSample,
} from "../lib/monthEffect";

const SOURCE = "https://raw.githubusercontent.com/datasets/exchange-rates/main/data/daily.csv";

/**
 * 為替として動いていない通貨は外す。
 * ドルにペッグされていたり管理されていたりすると、日々の値動きが
 * 市場ではなく当局の運用を映すので、この検証の対象にならない。
 */
const EXCLUDED = new Set([
  "Hong Kong",   // 対ドルペッグ
  "China",       // 管理変動
  "Malaysia",    // 一時ペッグ
  "Denmark",     // ユーロにペッグ
  "Venezuela",   // 高インフレで水準が桁で動く
  "Euro",        // ユーロは1999年から。他と期間が揃わないので別扱い
]);

const PERMUTATIONS = 20_000;

/** 元の12ペアに近い顔ぶれ。新興国通貨に引きずられていないかを見るため */
const MAJORS = new Set([
  "Australia", "Canada", "Japan", "New Zealand",
  "Norway", "Sweden", "Switzerland", "United Kingdom",
]);

interface Args {
  hold: number;
  lookback: number;
  cachePath: string;
  /** "all" か "majors" */
  group: string;
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
  const num = (key: string, fallback: number) => {
    const raw = map.get(key);
    if (raw === undefined) return fallback;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed < 1) {
      throw new Error(`--${key} は1以上の数値で指定してください: ${raw}`);
    }
    return parsed;
  };
  const group = map.get("group") ?? "all";
  if (group !== "all" && group !== "majors") {
    throw new Error("--group は all か majors で指定してください");
  }
  return {
    hold: num("hold", 5),
    lookback: num("lookback", 21),
    cachePath: map.get("cache") ?? "data/fed-h10-daily.csv",
    group,
  };
}

interface Series {
  country: string;
  dates: string[];
  rates: number[];
}

async function loadSeries(cachePath: string): Promise<Series[]> {
  let text: string;
  if (existsSync(cachePath)) {
    console.log(`手元の写しを使います: ${cachePath}`);
    text = readFileSync(cachePath, "utf8");
  } else {
    console.log(`取得中: ${SOURCE}`);
    const response = await fetch(SOURCE);
    if (!response.ok) throw new Error(`${SOURCE}: HTTP ${response.status}`);
    text = await response.text();
    mkdirSync(dirname(cachePath), { recursive: true });
    writeFileSync(cachePath, text);
    console.log(`写しを置きました: ${cachePath}`);
  }

  const lines = text.trim().split(/\r?\n/);
  const header = lines[0].split(",").map((c) => c.trim().toLowerCase());
  const iDate = header.indexOf("date");
  const iCountry = header.indexOf("country");
  const iRate = header.findIndex((c) => c.includes("exchange"));
  if (iDate === -1 || iCountry === -1 || iRate === -1) {
    throw new Error(`列を判別できません: ${lines[0]}`);
  }

  const byCountry = new Map<string, { dates: string[]; rates: number[] }>();
  for (let i = 1; i < lines.length; i++) {
    const cells = lines[i].split(",");
    const country = (cells[iCountry] ?? "").trim();
    const date = (cells[iDate] ?? "").trim();
    const raw = (cells[iRate] ?? "").trim();
    if (country === "" || !/^\d{4}-\d{2}-\d{2}$/.test(date) || raw === "") continue;
    const rate = Number(raw);
    if (!Number.isFinite(rate) || rate <= 0) continue;

    const slot = byCountry.get(country) ?? { dates: [], rates: [] };
    slot.dates.push(date);
    slot.rates.push(rate);
    byCountry.set(country, slot);
  }

  return [...byCountry.entries()]
    .filter(([country]) => !EXCLUDED.has(country))
    .map(([country, slot]) => ({ country, ...slot }))
    .sort((a, b) => a.country.localeCompare(b.country));
}

type Observation = MonthEffectSample & { country: string };

function observe(series: Series, hold: number, lookback: number): Observation[] {
  return collectMonthEffect({
    dates: series.dates,
    values: series.rates,
    lookback,
    hold,
  }).map((sample) => ({ ...sample, country: series.country }));
}

function fmt(v: number, d = 4): string {
  return Number.isFinite(v) ? v.toFixed(d) : "—";
}

function report(label: string, observations: Observation[], seed: number): void {
  if (observations.length < 50) {
    console.log(`  ${label.padEnd(24)} 件数不足（${observations.length}）`);
    return;
  }
  const { actual, p } = permutationTest(observations, seed, PERMUTATIONS);
  const countries = [...new Set(observations.map((o) => o.country))];
  const positive = countries.filter(
    (c) => mean(observations.filter((o) => o.country === c).map((o) => o.signedReturn)) > 0,
  ).length;

  console.log(
    `  ${label.padEnd(24)}${String(observations.length).padStart(7)}件` +
      `${fmt(actual).padStart(11)}${fmt(p, 4).padStart(10)}` +
      `${`${positive}/${countries.length}`.padStart(10)}${p < 0.05 ? "  ←" : ""}`,
  );
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const loaded = await loadSeries(args.cachePath);
  const series = args.group === "majors"
    ? loaded.filter((s) => MAJORS.has(s.country))
    : loaded;

  const all = series.flatMap((s) => observe(s, args.hold, args.lookback));
  const first = all.reduce((min, o) => Math.min(min, o.year), Infinity);
  const last = all.reduce((max, o) => Math.max(max, o.year), -Infinity);

  console.log("");
  console.log("=".repeat(78));
  console.log("月初の逆張り: 標本の外での検証");
  console.log("=".repeat(78));
  console.log(`出所      : 米連邦準備制度 H.10（対ドル日次レート）`);
  console.log(`通貨      : ${series.length}件  ${series.map((s) => s.country).join(", ")}`);
  console.log(`期間      : ${first} 〜 ${last}`);
  console.log(`ルール    : 月が変わった最初の営業日に、前${args.lookback}営業日と逆へ入り${args.hold}営業日持つ`);
  console.log(`単位      : 直近のばらつきで割ったリターン（0.1 = 平常の値動きの1割ぶん有利）`);
  console.log(`検定      : 向きの並べ替え ${PERMUTATIONS.toLocaleString("en-US")}回（片側）`);
  console.log("");
  console.log("⚠ このルールは事後に見つけたものです。2012〜2022の12ペアで符号を");
  console.log("  反転させて作ったので、そこで当てはまるのは当たり前です。");
  console.log("  見るべきは**発見前**と**発見後**の行です。");
  console.log("");
  console.log(`  ${"期間".padEnd(24)}${"件数".padStart(9)}${"平均".padStart(11)}${"p値".padStart(10)}${"プラスの通貨".padStart(12)}`);
  console.log("  " + "-".repeat(66));

  report("発見前 1971〜2011", all.filter((o) => o.year < 2012), 101);
  report("発見に使った 2012〜2021", all.filter((o) => o.year >= 2012 && o.year < 2022), 102);
  report("発見後 2022〜", all.filter((o) => o.year >= 2022), 103);
  console.log("  " + "-".repeat(66));
  report("全期間", all, 104);

  console.log("");
  console.log("  参考: 発見前をさらに分けたもの");
  for (const [from, to] of [[1971, 1985], [1985, 1999], [1999, 2012]] as const) {
    report(`  ${from}〜${to - 1}`, all.filter((o) => o.year >= from && o.year < to), from);
  }

  /*
   * 符号の推移。
   *
   * 「効いていた向きが今も同じか」は、使い続けてよいかの判断そのもの。
   * 表の数字を毎回読み直さなくても分かるよう、窓をずらして並べる。
   *
   * この効果は一度に反転したのではなく、55年かけて少しずつ動いた。
   * だから見るべきは最新の窓の符号と、その1つ前との比較になる。
   */
  console.log("");
  console.log("=".repeat(78));
  console.log("符号の推移（いま使ってよいかの判断）");
  console.log("=".repeat(78));
  const regime = trackRegime(all, 5);
  const scale = 0.25; // バーの1文字あたりの大きさ
  for (const window of regime.windows) {
    const bars = Math.min(Math.round(Math.abs(window.mean) / scale * 20), 30);
    const bar = (window.mean < 0 ? "◀" : "▶").repeat(Math.max(bars, 1));
    console.log(
      `  ${window.label}  ${window.mean >= 0 ? "+" : ""}${window.mean.toFixed(3).padStart(6)}` +
        `  ${String(window.samples).padStart(4)}件  ${bar}`,
    );
  }
  console.log("");
  console.log(`  ${regime.message}`);
  if (regime.flipped) {
    console.log("  ⚠ 符号が変わりました。この効果を使っているなら止める判断が要ります。");
  }

  console.log("");
  console.log("=".repeat(78));
  const before = all.filter((o) => o.year < 2012);
  const after = all.filter((o) => o.year >= 2022);
  const beforeTest = permutationTest(before, 101, PERMUTATIONS);
  const afterTest = permutationTest(after, 103, PERMUTATIONS);

  if (beforeTest.p < 0.05 && afterTest.p < 0.05) {
    console.log("発見前・発見後のどちらでも偶然と区別できました。");
    console.log("別の通貨・別の出所・別の期間で同じ向きに出たことになります。");
  } else if (beforeTest.p < 0.05 || afterTest.p < 0.05) {
    console.log("片方でしか出ませんでした。");
    console.log("同じものが一貫して現れているとは言えません。");
  } else {
    console.log("発見前・発見後のどちらでも、偶然と区別できませんでした。");
    console.log("");
    console.log("2012〜2022の12ペアで見えたものは、その標本に固有だったということです。");
    console.log("符号を反転させて良く見えるようになったのは、反転させる先を");
    console.log("そのデータを見てから選んだためです。");
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
