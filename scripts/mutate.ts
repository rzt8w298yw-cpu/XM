/**
 * ミューテーションテスト
 *
 *   npm run mutate
 *   npm run mutate -- --filter backtest
 *
 * テストの件数は品質の証明にならない。コードにわざと小さなバグを入れて
 * テストが落ちるかを確かめ、**落ちなかったもの＝テストの穴**を洗い出す。
 *
 * 各ミューテーションは適用→テスト実行→復元の順で処理し、復元は必ず
 * finally で行う。中断されてもソースが書き換わったまま残らないよう、
 * 開始前にワーキングツリーが綺麗であることを確認する。
 */
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

interface Mutation {
  /** どの挙動を壊すのか */
  description: string;
  file: string;
  find: string;
  replace: string;
}

/**
 * 意味のある壊し方だけを並べる。
 * 「消しても誰も困らない」変更（等価ミューテーション）は避け、
 * 実際に損益や判定が変わる箇所を狙う。
 */
const MUTATIONS: Mutation[] = [
  // --- 決済ロジック（損益に直結） ---
  {
    description: "決済: 損切り判定の不等号を反転",
    file: "lib/backtest.ts",
    find: "direction === \"BUY\" ? candle.low <= stopLoss : candle.high >= stopLoss",
    replace: "direction === \"BUY\" ? candle.low < stopLoss : candle.high > stopLoss",
  },
  {
    description: "決済: 同一足で両側に触れた時に利確を優先（楽観側に倒す）",
    file: "lib/backtest.ts",
    find: "    if (hitStop) {\n      return buildTrade(direction, candles1H, entryIndex, j, entryPrice, stopLoss, stopLoss, takeProfit, \"stop_loss\", confidence, cfg);\n    }\n    if (hitTarget) {",
    replace: "    if (hitTarget) {\n      return buildTrade(direction, candles1H, entryIndex, j, entryPrice, takeProfit, stopLoss, takeProfit, \"take_profit\", confidence, cfg);\n    }\n    if (hitStop) {",
  },
  {
    description: "決済: エントリーをシグナル足の終値にする（先読み）",
    file: "lib/backtest.ts",
    find: "const entryPrice = candles1H[entryIndex].open;",
    replace: "const entryPrice = candles1H[signalIndex].close;",
  },
  {
    description: "決済: スプレッドを差し引かない",
    file: "lib/backtest.ts",
    find: "pips: rawPips - cfg.spreadPips,",
    replace: "pips: rawPips,",
  },
  {
    description: "決済: 利確幅の計算からリスクリワードを落とす",
    file: "lib/backtest.ts",
    find: "const targetDistance = stopDistance * cfg.riskRewardRatio;",
    replace: "const targetDistance = stopDistance;",
  },
  // --- 集計（成績の見え方に直結） ---
  {
    description: "集計: 勝ちの判定を pips >= 0 にする（引き分けを勝ち扱い）",
    file: "lib/backtest.ts",
    find: "const wins = trades.filter((t) => t.pips > 0);\n  const losses = trades.filter((t) => t.pips <= 0);",
    replace: "const wins = trades.filter((t) => t.pips >= 0);\n  const losses = trades.filter((t) => t.pips < 0);",
  },
  {
    description: "集計: 最大ドローダウンを常に0にする",
    file: "lib/backtest.ts",
    find: "maxDrawdown = Math.max(maxDrawdown, peak - cumulative);",
    replace: "maxDrawdown = Math.max(maxDrawdown, 0);",
  },
  // --- 先読み防止 ---
  {
    description: "バックテスト: 未確定の日足も判定に渡す（先読み）",
    file: "lib/backtest.ts",
    find: "return candlesDaily.filter((d) => d.timestamp + DAY_MS <= atTime);",
    replace: "return candlesDaily.filter((d) => d.timestamp <= atTime);",
  },
  // --- 指標 ---
  {
    description: "EMA: 平滑化係数の分母をずらす",
    file: "lib/technicalAnalysis.ts",
    find: "const k = 2 / (period + 1);",
    replace: "const k = 2 / period;",
  },
  {
    description: "RSI: Wilder平滑を単純平均にする",
    file: "lib/technicalAnalysis.ts",
    find: "avgGain = (avgGain * (period - 1) + gain) / period;",
    replace: "avgGain = (avgGain + gain) / 2;",
  },
  {
    description: "ATR: TrueRangeから前日終値との比較を落とす",
    file: "lib/technicalAnalysis.ts",
    find: "    trueRanges[i] = Math.max(\n      c.high - c.low,\n      Math.abs(c.high - prevClose),\n      Math.abs(c.low - prevClose),\n    );",
    replace: "    trueRanges[i] = c.high - c.low;",
  },
  {
    description: "ボリンジャーバンド: 標準偏差の倍率を無視",
    file: "lib/technicalAnalysis.ts",
    find: "const upper = middle + sd * stdDevMultiplier;",
    replace: "const upper = middle + sd;",
  },
  {
    description: "セッション: ロンドンの開始を1時間ずらす",
    file: "lib/technicalAnalysis.ts",
    find: "if (jstHour >= 16 && jstHour < 21) return \"LONDON\";",
    replace: "if (jstHour >= 17 && jstHour < 21) return \"LONDON\";",
  },
  {
    description: "上位足集約: 絶対時刻ではなく先頭からの本数で区切る",
    file: "lib/marketData.ts",
    find: "const key = Math.floor(candle.timestamp / bucketMs) * bucketMs;",
    replace: "const key = Math.floor(candles1H.indexOf(candle) / factor) * bucketMs;",
  },
  // --- エンジンのゲート ---
  {
    description: "エンジン: 逆行ダイバージェンスを再び成立扱いにする",
    file: "lib/autoSignalEngine.ts",
    find: "const divergenceOk = !divergenceOpposing;",
    replace: "const divergenceOk = true;",
  },
  {
    description: "エンジン: セッションフィルターを無効化",
    file: "lib/autoSignalEngine.ts",
    find: "if (signal !== \"WAIT\" && timeSession !== \"LONDON\" && timeSession !== \"NY\") {",
    replace: "if (false) {",
  },
  {
    description: "エンジン: BUYのスコア閾値を無視",
    file: "lib/autoSignalEngine.ts",
    find: "if (weightedScoreRatio < thresholds.buyScoreMin) {",
    replace: "if (false) {",
  },
  {
    description: "エンジン: MTFフィルターを無効化（BUY側）",
    file: "lib/autoSignalEngine.ts",
    find: "if (signal === \"BUY\" && !mtfBuyPass) {",
    replace: "if (false) {",
  },
  // --- 資金管理 ---
  {
    description: "ロット: 刻みを切り捨てではなく切り上げる（リスク超過）",
    file: "lib/positionSizing.ts",
    find: "const steps = Math.floor(rawLots / lotStep.step);",
    replace: "const steps = Math.ceil(rawLots / lotStep.step);",
  },
  // --- 状態の永続化 ---
  {
    description: "状態保存: 原子的な書き込みをやめる",
    file: "lib/signalState.ts",
    find: "    writeFileSync(tmpPath, JSON.stringify(state, null, 2), \"utf8\");\n    renameSync(tmpPath, path);",
    replace: "    writeFileSync(path, JSON.stringify(state, null, 2), \"utf8\");",
  },
  // --- 通知 ---
  {
    description: "通知: 状態が変わらなくても毎回通知する",
    file: "lib/notifier.ts",
    find: "if (current === previousSignal) continue;",
    replace: "if (false) continue;",
  },
  // --- CSV ---
  {
    description: "CSV: 空セルを0として受け入れる",
    file: "lib/csv.ts",
    find: "if (raw === undefined || raw === \"\") return null;",
    replace: "if (raw === undefined) return null;",
  },
];

function isWorkingTreeClean(): boolean {
  const status = execSync("git status --porcelain", { encoding: "utf8" });
  return status.trim() === "";
}

function runTests(): boolean {
  try {
    execSync("npx vitest run --silent", { stdio: "pipe", encoding: "utf8" });
    return true; // 通った = ミューテーションを検出できなかった
  } catch {
    return false; // 落ちた = 検出できた
  }
}

function main() {
  const filterArg = process.argv.indexOf("--filter");
  const filter = filterArg !== -1 ? process.argv[filterArg + 1] : null;

  if (!isWorkingTreeClean()) {
    console.error(
      "ワーキングツリーに変更があります。ミューテーションはソースを一時的に書き換えるため、",
    );
    console.error("先にコミットするか退避してから実行してください。");
    process.exit(1);
  }

  const targets = filter
    ? MUTATIONS.filter((m) => m.file.includes(filter) || m.description.includes(filter))
    : MUTATIONS;

  if (targets.length === 0) {
    console.error(`--filter "${filter}" に合致するミューテーションがありません`);
    process.exit(1);
  }

  console.log(`${targets.length}件のミューテーションを試します。`);
  console.log("落ちなかったもの＝テストの穴です。\n");

  const survivors: Mutation[] = [];
  // リファクタで対象の文字列が変わると、そのミューテーションは何も検証しない。
  // 黙って通ると「守られている」と誤解するので、見失いは失敗として扱う。
  const unapplied: Mutation[] = [];
  let killed = 0;

  targets.forEach((mutation, index) => {
    const original = readFileSync(mutation.file, "utf8");
    const occurrences = original.split(mutation.find).length - 1;

    if (occurrences !== 1) {
      unapplied.push(mutation);
      console.log(
        `  [${index + 1}/${targets.length}] ⚠ 適用できません（該当${occurrences}箇所）: ${mutation.description}`,
      );
      return;
    }

    try {
      writeFileSync(mutation.file, original.replace(mutation.find, mutation.replace), "utf8");
      const passed = runTests();

      if (passed) {
        survivors.push(mutation);
        console.log(`  [${index + 1}/${targets.length}] ✗ 生存: ${mutation.description}`);
      } else {
        killed++;
        console.log(`  [${index + 1}/${targets.length}] ✓ 検出: ${mutation.description}`);
      }
    } finally {
      // 何があっても必ず元に戻す
      writeFileSync(mutation.file, original, "utf8");
    }
  });

  console.log("");
  console.log("=".repeat(70));
  console.log(
    `検出 ${killed} / 生存 ${survivors.length}` +
      (unapplied.length > 0 ? ` / 適用不可 ${unapplied.length}` : ""),
  );
  console.log("=".repeat(70));

  if (unapplied.length > 0) {
    console.log("\n対象の文字列が見つからず、何も検証できなかったもの:");
    for (const mutation of unapplied) {
      console.log(`  - ${mutation.description}`);
      console.log(`    ${mutation.file}`);
    }
    console.log("\nコードの変更に追随できていません。定義を更新してください。");
  }

  if (survivors.length > 0) {
    console.log("\nテストが見逃した変更:");
    for (const survivor of survivors) {
      console.log(`  - ${survivor.description}`);
      console.log(`    ${survivor.file}`);
    }
    console.log("\nこれらはバグを入れてもテストが通る箇所です。");
  }

  if (!isWorkingTreeClean()) {
    console.error("\n⚠ ワーキングツリーが元に戻っていません。git status を確認してください。");
    process.exit(1);
  }

  process.exit(survivors.length > 0 || unapplied.length > 0 ? 1 : 0);
}

main();
