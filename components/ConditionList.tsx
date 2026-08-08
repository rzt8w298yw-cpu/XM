import type { ConditionResult } from "@/lib/autoSignalEngine";

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

        const metWeight = items
          .filter((c) => c.met)
          .reduce((sum, c) => sum + c.weight, 0);
        const totalWeight = items.reduce((sum, c) => sum + c.weight, 0);

        return (
          <section key={category}>
            <header className="mb-2 flex items-baseline justify-between">
              <h3 className="text-sm font-semibold text-slate-200">
                {CATEGORY_LABELS[category]}
              </h3>
              <span className="tabular text-xs text-slate-400">
                {items.filter((c) => c.met).length}/{items.length} 充足 ・ 重み{" "}
                {metWeight}/{totalWeight}
              </span>
            </header>

            <ul className="space-y-1.5">
              {items.map((condition) => (
                <li
                  key={condition.id}
                  className={`flex items-start gap-3 rounded-lg border px-3 py-2 ${
                    condition.met
                      ? "border-emerald-900/60 bg-emerald-950/30"
                      : "border-slate-800 bg-slate-900/40"
                  }`}
                >
                  <span
                    aria-hidden
                    className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-xs font-bold ${
                      condition.met
                        ? "bg-emerald-500/20 text-emerald-300"
                        : "bg-slate-700/50 text-slate-500"
                    }`}
                  >
                    {condition.met ? "✓" : "–"}
                  </span>

                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-slate-100">
                        {condition.name}
                      </span>
                      <span className="tabular rounded bg-slate-800 px-1.5 py-0.5 text-[10px] text-slate-400">
                        重み {condition.weight}
                      </span>
                      <span className="sr-only">
                        {condition.met ? "条件を満たしています" : "条件を満たしていません"}
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
