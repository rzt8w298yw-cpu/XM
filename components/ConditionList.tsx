import { weightedScore, type ConditionResult } from "@/lib/autoSignalEngine";

const CATEGORY_LABELS: Record<ConditionResult["category"], string> = {
  trend: "トレンド確認",
  entry: "エントリー条件",
  confirmation: "確認シグナル",
  filter: "フィルター",
};

const CATEGORY_ORDER: ConditionResult["category"][] = [
  "trend",
  "entry",
  "confirmation",
  "filter",
];

export default function ConditionList({
  conditions,
}: {
  conditions: ConditionResult[];
}) {
  return (
    <div className="space-y-5">
      {CATEGORY_ORDER.map((category) => {
        const items = conditions.filter((c) => c.category === category);
        if (items.length === 0) return null;

        // 評価できない条件はスコアの対象外なので、集計からも外して
        // 画面の数字と実際のスコアが食い違わないようにする
        const evaluated = items.filter((c) => c.available !== false);
        const excluded = items.length - evaluated.length;
        const { metWeight, totalWeight } = weightedScore(items);

        return (
          <section key={category}>
            <header className="mb-2 flex items-baseline justify-between">
              <h3 className="text-sm font-semibold text-slate-200">
                {CATEGORY_LABELS[category]}
              </h3>
              <span className="tabular text-xs text-slate-400">
                {evaluated.filter((c) => c.met).length}/{evaluated.length} 充足 ・ 重み{" "}
                {metWeight}/{totalWeight}
                {excluded > 0 && ` ・ 対象外 ${excluded}`}
              </span>
            </header>

            <ul className="space-y-1.5">
              {items.map((condition) => (
                <li
                  key={condition.id}
                  className={`flex items-start gap-3 rounded-lg border px-3 py-2 ${
                    condition.available === false
                      ? "border-slate-800/60 bg-slate-900/20 opacity-60"
                      : condition.met
                        ? "border-emerald-900/60 bg-emerald-950/30"
                        : "border-slate-800 bg-slate-900/40"
                  }`}
                >
                  <span
                    aria-hidden
                    className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-xs font-bold ${
                      condition.available === false
                        ? "bg-slate-800 text-slate-600"
                        : condition.met
                          ? "bg-emerald-500/20 text-emerald-300"
                          : "bg-slate-700/50 text-slate-500"
                    }`}
                  >
                    {condition.available === false ? "?" : condition.met ? "✓" : "–"}
                  </span>

                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-slate-100">
                        {condition.name}
                      </span>
                      <span className="tabular rounded bg-slate-800 px-1.5 py-0.5 text-[10px] text-slate-400">
                        重み {condition.weight}
                      </span>
                      {condition.available === false && (
                        <span className="rounded bg-slate-800 px-1.5 py-0.5 text-[10px] text-slate-400">
                          評価対象外
                        </span>
                      )}
                      <span className="sr-only">
                        {condition.available === false
                          ? "判定に必要な情報が無いため評価から除外されています"
                          : condition.met
                            ? "条件を満たしています"
                            : "条件を満たしていません"}
                      </span>
                    </div>
                    <p className="tabular mt-0.5 truncate text-xs text-slate-400">
                      {condition.value}
                    </p>
                  </div>
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}
