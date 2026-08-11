/**
 * 勝つために必要な数字を出す
 *
 *   npm run edge
 *   npm run edge -- --spread 1.8 --atr 10 --rr 2 --risk 2
 *   npm run edge -- --atr 90 --win-rate 54.1 --avg-win 102 --avg-loss 96 --risk 1
 *
 * このリポジトリの検証で、価格から方向を当てることはできなかった。
 * 当てられないなら、当てにいかないところで勝負を決めるしかない。
 *
 * ここは予測を1つも含まない。あなたのブローカーのコストと、あなたが賭ける
 * 割合を入れると、次の3つが出る。
 *
 *   1. その条件で損益が±0になる的中率
 *   2. 「運ではない」と言うのに要るトレード数
 *   3. その枚数で口座がどこまで減りうるか
 *
 * 1つ目で大半の手法は落ちる。2つ目で「まだ判断できる件数に達していない」
 * ことが分かる。3つ目で、期待値がプラスでも枚数で壊れることが分かる。
 */
import {
  maxSafeRiskPercent,
  requiredAccuracy,
  simulateRuin,
  tradesNeededToConfirm,
} from "../lib/edgeMath";

interface Args {
  spreadPips: number;
  slippagePips: number;
  atrPips: number;
  atrStopMultiplier: number;
  riskRewardRatio: number;
  riskPercent: number;
  /** 実測の的中率（%）。分かっていれば期待値まで出す */
  winRate?: number;
  /** 1トレードあたりの損益のばらつき（pips）。省略時は勝ち負けの幅から見積もる */
  stdDevPips?: number;
  /** 実測の平均利益（pips）。的中率を測ったときの決済条件のもの */
  avgWinPips?: number;
  /** 実測の平均損失（pips、正の数） */
  avgLossPips?: number;
  trades: number;
  ruinThresholdPercent: number;
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
    if (!Number.isFinite(parsed)) throw new Error(`--${key} は数値で指定してください: ${raw}`);
    return parsed;
  };
  const optional = (key: string) => {
    const raw = map.get(key);
    if (raw === undefined) return undefined;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) throw new Error(`--${key} は数値で指定してください: ${raw}`);
    return parsed;
  };

  return {
    // XMのスタンダード口座のドル円は、実測で1.6〜2.0 pips あたり
    spreadPips: num("spread", 1.8),
    slippagePips: num("slippage", 0.5),
    atrPips: num("atr", 10),
    atrStopMultiplier: num("atr-stop", 1.5),
    riskRewardRatio: num("rr", 2),
    riskPercent: num("risk", 2),
    winRate: optional("win-rate"),
    stdDevPips: optional("stddev"),
    avgWinPips: optional("avg-win"),
    avgLossPips: optional("avg-loss"),
    trades: num("trades", 200),
    ruinThresholdPercent: num("ruin-at", 50),
  };
}

function fmt(v: number, d = 1): string {
  return Number.isFinite(v) ? v.toFixed(d) : "—";
}

function heading(text: string): void {
  console.log("");
  console.log("-".repeat(72));
  console.log(text);
  console.log("-".repeat(72));
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const stop = args.atrPips * args.atrStopMultiplier;
  const cost = args.spreadPips + args.slippagePips;

  console.log("=".repeat(72));
  console.log("勝つために必要な数字（予測を含まない計算）");
  console.log("=".repeat(72));
  console.log(`コスト      : スプレッド ${args.spreadPips} + 滑り ${args.slippagePips} = ${fmt(cost)} pips`);
  console.log(`損切り幅    : ATR ${args.atrPips} pips × ${args.atrStopMultiplier} = ${fmt(stop)} pips`);
  console.log(`利確幅      : ${fmt(stop * args.riskRewardRatio)} pips（RR 1:${args.riskRewardRatio}）`);
  console.log(`1回のリスク : 残高の ${args.riskPercent}%`);

  // 実測の決済条件が分かっているなら、必要的中率もそちらで測る。
  // 損切り利確を前提にした比率を当てはめると、別の決め方で測った的中率が
  // 実際より余裕を持って見える
  const hasPayoff = args.avgWinPips !== undefined && args.avgLossPips !== undefined;
  const measured = args.winRate !== undefined;

  // --- 1. 必要的中率 ---
  heading("1. 損益が±0になる的中率");
  const accuracy = requiredAccuracy(
    hasPayoff
      ? {
          stopDistancePips: args.avgLossPips!,
          riskRewardRatio: args.avgWinPips! / args.avgLossPips!,
          costPips: cost,
        }
      : { stopDistancePips: stop, riskRewardRatio: args.riskRewardRatio, costPips: cost },
  );
  if (hasPayoff) {
    console.log(
      `  （実測の決済条件で計算: 平均利益 ${args.avgWinPips} / 平均損失 ${args.avgLossPips} pips）`,
    );
  }
  console.log(`  コストが無ければ    ${fmt(accuracy.idealWinRate)}%`);
  console.log(`  あなたのコストでは  ${fmt(accuracy.requiredWinRate)}%　（+${fmt(accuracy.costPenalty)} ポイント）`);
  console.log(`  コストは損切り幅の  ${fmt(accuracy.costAsShareOfStop)}%`);
  for (const warning of accuracy.warnings) console.log(`  ⚠ ${warning}`);

  if (args.winRate !== undefined) {
    const margin = args.winRate - accuracy.requiredWinRate;
    console.log("");
    console.log(`  実測の的中率        ${fmt(args.winRate)}%`);
    console.log(
      margin > 0
        ? `  → 損益分岐を ${fmt(margin)} ポイント上回っています`
        : `  → 損益分岐に ${fmt(-margin)} ポイント足りません。期待値はマイナスです`,
    );
  }

  /**
   * コストを差し引いた実質のリスクリワード。
   *
   * 破産の計算に生のRRを渡すと、**コストを払わずに勝負している口座**を
   * 模したことになる。損益分岐の的中率を入れたのに残高が増える、という
   * 矛盾がそこで生まれる。勝ち幅から往復コストを引き、負け幅にコストを
   * 足したうえで、負け幅を1とした比率に直す。
   */
  /**
   * 勝ち幅と負け幅。実測値が渡されていればそちらを使う。
   *
   * **的中率は決済条件とセットでしか意味を持たない。** 5日で切る決済で
   * 測った54%を、1:2の損切り利確に当てはめると、勝ち幅が実際の倍近くに
   * なって期待値が跳ね上がる。ここを分けていないツールは、うまくいって
   * いない手法を「もう少しで勝てる」と見せてしまう。
   */
  const win = hasPayoff ? args.avgWinPips! - cost : stop * args.riskRewardRatio - cost;
  const loss = hasPayoff ? -(args.avgLossPips! + cost) : -(stop + cost);
  const effectiveRR = win / -loss;

  // --- 2. 必要件数 ---
  heading("2.「運ではない」と言うのに要るトレード数");
  const winRate = args.winRate ?? accuracy.requiredWinRate;
  const p = winRate / 100;
  const expectancy = p * win + (1 - p) * loss;
  // 二値の分布なので、ばらつきは勝ち負けの幅から出せる
  const variance = p * (win - expectancy) ** 2 + (1 - p) * (loss - expectancy) ** 2;
  const stdDev = args.stdDevPips ?? Math.sqrt(variance);

  if (measured && !hasPayoff) {
    console.log("  ⚠ 実測の的中率だけが渡されています。的中率は決済条件とセットでしか");
    console.log("     意味を持ちません。損切り・利確とは別の決め方（時間で切るなど）で");
    console.log("     測った値なら、`--avg-win` と `--avg-loss` に実測の平均幅を渡してください。");
    console.log("     渡さない場合、ここでは 1:" + args.riskRewardRatio + " を仮定します。");
    console.log("");
  }
  console.log(`  勝ち幅 / 負け幅     ${fmt(win)} / ${fmt(-loss)} pips${hasPayoff ? "（実測）" : "（仮定）"}`);
  console.log(`  1トレードの期待値   ${fmt(expectancy, 2)} pips`);
  console.log(`  1トレードのばらつき ${fmt(stdDev)} pips`);
  const need = tradesNeededToConfirm({ expectancyPips: expectancy, stdDevPips: stdDev });
  console.log(`  必要件数（95%）     ${Number.isFinite(need.trades) ? need.trades.toLocaleString("en-US") : "—"}`);
  if (!measured) {
    console.log("  実測の的中率が渡されていないので、損益分岐ちょうどを仮に置いています。");
    console.log("  期待値が0になるのは当然なので、`--win-rate` に実測値を渡してください。");
  } else {
    console.log(`  ${need.message}`);
  }
  if (measured && Number.isFinite(need.trades) && need.trades > 500) {
    console.log("");
    console.log("  ※ フォワードテスト数十件では、勝っていても負けていても判断できません。");
    console.log("     「3か月やって勝てたから本物」と言えるだけの件数か、先に確かめてください。");
  }

  // --- 3. 破産確率 ---
  heading("3. その枚数で口座がどこまで減りうるか");
  const ruin = simulateRuin({
    winRate,
    riskRewardRatio: effectiveRR,
    riskPercent: args.riskPercent,
    ruinThresholdPercent: args.ruinThresholdPercent,
    trades: args.trades,
    paths: 5000,
  });
  console.log(
    `  前提                的中率 ${fmt(winRate)}%${measured ? "（実測）" : "（損益分岐の値を仮置き）"}` +
      ` / ${args.trades}トレード / 5000回の試行`,
  );
  console.log(
    `  実質のRR            1:${fmt(effectiveRR, 2)}（コスト控除後）` +
      (hasPayoff ? "" : `　額面は 1:${args.riskRewardRatio}`),
  );
  console.log(`  残高が${args.ruinThresholdPercent}%減る確率  ${fmt(ruin.ruinProbability)}%`);
  console.log(`  最終残高の中央値    ${fmt(ruin.medianFinalBalance)}（開始を100として）`);
  console.log(`  最大DDの中央値      ${fmt(ruin.medianMaxDrawdown)}%`);
  for (const warning of ruin.warnings) console.log(`  ⚠ ${warning}`);

  const safe = maxSafeRiskPercent(
    {
      winRate,
      riskRewardRatio: effectiveRR,
      ruinThresholdPercent: args.ruinThresholdPercent,
      trades: args.trades,
      paths: 2000,
    },
    1,
  );
  console.log("");
  console.log(
    safe.riskPercent === null
      ? `  破産確率を1%以下にできるリスク割合はありませんでした（期待値そのものを疑ってください）`
      : `  破産確率を1%以下に収めるなら、1回あたり ${safe.riskPercent}% までです`,
  );

  console.log("");
  console.log("=".repeat(72));
  console.log("この3つはどれも予測を含みません。相場が何をするかに関係なく成り立ちます。");
  console.log("手法を探す前に、その手法が満たすべき水準をここで確かめてください。");
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
