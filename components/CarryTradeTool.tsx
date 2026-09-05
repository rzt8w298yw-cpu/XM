"use client";

import { useEffect, useMemo, useState } from "react";
import { accumulatedSwap, daysHeld, planCarryPosition, type OpenCarryPosition } from "@/lib/carryTrade";
import { pipValuePerLot, STANDARD_CONTRACT_SIZE } from "@/lib/positionSizing";

interface SymbolOption {
  id: string;
  label: string;
  pipSize: number;
}

const STORAGE_KEY = "xm-carry-positions-v1";

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function isOpenCarryPosition(value: unknown): value is OpenCarryPosition {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === "string" &&
    typeof v.pair === "string" &&
    (v.direction === "LONG" || v.direction === "SHORT") &&
    typeof v.lots === "number" &&
    typeof v.swapPerLotPerNight === "number" &&
    typeof v.entryDate === "string"
  );
}

function loadPositions(): OpenCarryPosition[] {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isOpenCarryPosition);
  } catch {
    return [];
  }
}

function savePositions(positions: OpenCarryPosition[]) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(positions));
  } catch {
    // 保存できない環境（プライベートモード等）でも画面は動かし続ける
  }
}

export default function CarryTradeTool({ symbols }: { symbols: SymbolOption[] }) {
  const [pairId, setPairId] = useState(symbols[0]?.id ?? "USDJPY");
  const pair = symbols.find((s) => s.id === pairId) ?? symbols[0];

  const [accountBalance, setAccountBalance] = useState(1_000_000);
  const [riskPercent, setRiskPercent] = useState(2);
  const [maxAdverseMovePips, setMaxAdverseMovePips] = useState(200);
  const [swapPerLotPerNight, setSwapPerLotPerNight] = useState(0);
  const [pipValue, setPipValue] = useState(() =>
    pipValuePerLot(STANDARD_CONTRACT_SIZE, pair?.pipSize ?? 0.0001, 1),
  );

  const plan = useMemo(
    () =>
      planCarryPosition({
        accountBalance,
        riskPercent,
        maxAdverseMovePips,
        pipValuePerLot: pipValue,
        swapPerLotPerNight,
      }),
    [accountBalance, riskPercent, maxAdverseMovePips, pipValue, swapPerLotPerNight],
  );

  const [positions, setPositions] = useState<OpenCarryPosition[]>([]);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    setPositions(loadPositions());
    setHydrated(true);
  }, []);

  useEffect(() => {
    if (hydrated) savePositions(positions);
  }, [positions, hydrated]);

  const [newDirection, setNewDirection] = useState<"LONG" | "SHORT">("LONG");
  const [newNote, setNewNote] = useState("");

  function addPosition() {
    if (plan.lots <= 0) return;
    const position: OpenCarryPosition = {
      id: `${Date.now()}`,
      pair: pairId,
      direction: newDirection,
      lots: plan.lots,
      swapPerLotPerNight,
      entryDate: todayIso(),
      note: newNote || undefined,
    };
    setPositions((prev) => [...prev, position]);
    setNewNote("");
  }

  function removePosition(id: string) {
    setPositions((prev) => prev.filter((p) => p.id !== id));
  }

  const today = todayIso();
  const totalAccumulatedSwap = positions.reduce((sum, p) => sum + accumulatedSwap(p, today), 0);

  return (
    <div className="mx-auto max-w-5xl space-y-6 px-4 py-8 sm:px-6">
      <header>
        <h1 className="text-2xl font-bold text-slate-50">キャリートレード計算・記録ツール</h1>
        <p className="mt-1 text-sm text-slate-400">
          方向を当てるツールではありません。金利差（スワップ）をリスク管理付きで積み上げるための計算だけを行います
        </p>
      </header>

      <IntroNote />

      <section className="rounded-xl border border-slate-800 bg-slate-900/50 p-5">
        <h2 className="text-sm font-semibold text-slate-100">ポジションサイズとスワップ試算</h2>
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <Field label="通貨ペア">
            <select
              value={pairId}
              onChange={(e) => {
                const next = symbols.find((s) => s.id === e.target.value);
                setPairId(e.target.value);
                if (next) setPipValue(pipValuePerLot(STANDARD_CONTRACT_SIZE, next.pipSize, 1));
              }}
              className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100"
            >
              {symbols.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label}
                </option>
              ))}
            </select>
          </Field>

          <Field label="口座残高（口座通貨）">
            <NumberInput value={accountBalance} onChange={setAccountBalance} min={0} />
          </Field>

          <Field label="1ポジションのリスク割合（%）">
            <NumberInput value={riskPercent} onChange={setRiskPercent} min={0} step={0.5} />
          </Field>

          <Field label="許容する最大逆行幅（pips）">
            <NumberInput value={maxAdverseMovePips} onChange={setMaxAdverseMovePips} min={0} />
          </Field>

          <Field label="1ロット・1晩あたりのスワップ（口座通貨）">
            <NumberInput value={swapPerLotPerNight} onChange={setSwapPerLotPerNight} step={1} />
          </Field>

          <Field label="1ロット・1pipの価値（口座通貨）">
            <NumberInput value={pipValue} onChange={setPipValue} min={0} step={1} />
          </Field>
        </div>

        <div className="mt-3 rounded-lg border border-slate-800 bg-slate-950/40 p-3 text-xs leading-relaxed text-slate-400">
          <p>
            スワップとpip価値はMT5の建玉画面・銘柄仕様から実際の値を確認して入力してください。
            決済通貨と口座通貨が違う通貨ペア（例: 口座がJPYでEURUSD）では、pip価値の換算レートを
            自動では推測しません——ここで適当な値を仮定すると、ロットが静かにずれて実際のリスクが変わります。
          </p>
        </div>

        <div className="mt-5 grid gap-3 sm:grid-cols-2">
          <ResultRow label="推奨ロット数" value={`${plan.lots.toFixed(2)} lot`} emphasis />
          <ResultRow
            label="この設定での損失額"
            value={`${Math.round(plan.actualLossAtMaxAdverse).toLocaleString("ja-JP")}（残高の${plan.actualRiskPercent.toFixed(2)}%）`}
          />
          <ResultRow label="1日あたりスワップ" value={formatMoney(plan.dailySwap)} />
          <ResultRow label="1ヶ月あたりスワップ（目安）" value={formatMoney(plan.monthlySwap)} />
          <ResultRow label="1年あたりスワップ（目安）" value={formatMoney(plan.annualSwap)} />
          <ResultRow label="年間利回り（対口座残高）" value={`${plan.annualYieldOnBalance.toFixed(2)}%`} />
        </div>

        {plan.daysOfSwapToOffsetMaxAdverse !== null && (
          <p className="mt-3 text-xs text-slate-400">
            想定した最大逆行をスワップだけで取り戻すには、約
            <span className="tabular text-slate-200"> {plan.daysOfSwapToOffsetMaxAdverse} </span>
            日かかります（値動きが無い前提の単純計算）。
          </p>
        )}

        {plan.warnings.length > 0 && (
          <div className="mt-4 space-y-1.5">
            {plan.warnings.map((w, i) => (
              <p key={i} className="rounded-lg border border-amber-900/70 bg-amber-950/30 px-3 py-2 text-xs text-amber-200">
                {w}
              </p>
            ))}
          </div>
        )}

        <div className="mt-5 flex flex-wrap items-end gap-3 border-t border-slate-800 pt-4">
          <Field label="方向">
            <select
              value={newDirection}
              onChange={(e) => setNewDirection(e.target.value as "LONG" | "SHORT")}
              className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100"
            >
              <option value="LONG">買い（高金利側を買う）</option>
              <option value="SHORT">売り（低金利側を買う＝高金利側を売る）</option>
            </select>
          </Field>
          <Field label="メモ（任意）">
            <input
              value={newNote}
              onChange={(e) => setNewNote(e.target.value)}
              className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100"
              placeholder="例: 2026年8月分"
            />
          </Field>
          <button
            type="button"
            onClick={addPosition}
            disabled={plan.lots <= 0}
            className="rounded-lg border border-sky-800 bg-sky-900/40 px-4 py-2 text-sm text-sky-200 hover:bg-sky-900/60 disabled:opacity-40"
          >
            この内容でポジションを記録
          </button>
        </div>
      </section>

      <HistoricalContextNote />

      <section className="rounded-xl border border-slate-800 bg-slate-900/50 p-5">
        <div className="flex items-baseline justify-between">
          <h2 className="text-sm font-semibold text-slate-100">保有中のキャリーポジション</h2>
          <span className="text-xs text-slate-400">
            累積スワップ合計:{" "}
            <span className="tabular font-semibold text-slate-200">{formatMoney(totalAccumulatedSwap)}</span>
          </span>
        </div>

        {positions.length === 0 ? (
          <p className="mt-3 text-sm text-slate-400">記録済みのポジションはありません。</p>
        ) : (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-slate-800 text-xs text-slate-400">
                  <th className="py-2 pr-3">ペア</th>
                  <th className="py-2 pr-3">方向</th>
                  <th className="py-2 pr-3">ロット</th>
                  <th className="py-2 pr-3">スワップ/晩</th>
                  <th className="py-2 pr-3">開始日</th>
                  <th className="py-2 pr-3">保有日数</th>
                  <th className="py-2 pr-3">累積スワップ</th>
                  <th className="py-2 pr-3">メモ</th>
                  <th className="py-2" />
                </tr>
              </thead>
              <tbody>
                {positions.map((p) => (
                  <tr key={p.id} className="border-b border-slate-900 text-slate-200">
                    <td className="py-2 pr-3">{p.pair}</td>
                    <td className="py-2 pr-3">{p.direction === "LONG" ? "買い" : "売り"}</td>
                    <td className="tabular py-2 pr-3">{p.lots.toFixed(2)}</td>
                    <td className="tabular py-2 pr-3">{formatMoney(p.swapPerLotPerNight)}</td>
                    <td className="py-2 pr-3">{p.entryDate}</td>
                    <td className="tabular py-2 pr-3">{daysHeld(p.entryDate, today)}日</td>
                    <td className="tabular py-2 pr-3">{formatMoney(accumulatedSwap(p, today))}</td>
                    <td className="py-2 pr-3 text-slate-400">{p.note}</td>
                    <td className="py-2">
                      <button
                        type="button"
                        onClick={() => removePosition(p.id)}
                        className="text-xs text-rose-300 hover:text-rose-200"
                      >
                        削除
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="mt-3 text-xs text-slate-400">
          この記録はブラウザ内（localStorage）にのみ保存されます。別の端末やブラウザからは見えません。
          値動きによる含み損益は含まれておらず、あくまでスワップだけの積み上げです。
        </p>
      </section>
    </div>
  );
}

function IntroNote() {
  return (
    <section className="rounded-xl border border-slate-800 bg-slate-900/50 p-5 text-xs leading-relaxed">
      <h2 className="text-sm font-semibold text-slate-100">このツールの前提</h2>
      <p className="mt-2 text-slate-400">
        トップページのシグナルエンジンは、実データで検証した結果、方向を当てる優位性がゼロでした
        （USD/JPY 9年4ヶ月・440トレードでランダムエントリーと統計的に区別不可。テクニカル指標・出来高・
        VIX・金利レジーム・通貨バスケット・トレーリングストップなど12個の追加検証もすべて同じ結論）。
      </p>
      <p className="mt-2 text-slate-400">
        キャリートレードは方向を当てる手法ではなく、金利が高い通貨を買い・低い通貨を売って
        その差（スワップ）を積み上げる手法です。<strong className="text-slate-200">平常時は毎日じわじわ稼ぎ、
        リスクオフ（急激な円高など）が起きた時に一気に含み損を抱えるという、性質の違うリスクを負います。</strong>
        このツールはその積み上げを計算・記録するだけで、いつ相場が急変するかは予測しません。
      </p>
    </section>
  );
}

function HistoricalContextNote() {
  return (
    <section className="rounded-xl border border-slate-800 bg-slate-900/50 p-5 text-xs leading-relaxed">
      <h2 className="text-sm font-semibold text-slate-100">参考: 直近の実データ（USD/JPY）</h2>
      <p className="mt-2 text-slate-400">
        米財務省のFX日次データ（
        <code className="rounded bg-slate-800/70 px-1 py-0.5 text-slate-300">datasets/exchange-rates</code>
        、2026年8月時点で更新継続を確認）によると、2024-09-05の143.43円から2026-08-28の159.97円まで
        +11.5%の円安が続き、高値からの最大下落幅は-17.5円でした。
      </p>
      <p className="mt-2 text-slate-400">
        これは「今後もこうなる」という予測ではなく、直近2年の実際の値幅感を知るための参考情報です。
        上の「許容する最大逆行幅」を決める際の目安の一つにしてください。
      </p>
    </section>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block text-xs text-slate-400">
      <span className="mb-1 block">{label}</span>
      {children}
    </label>
  );
}

function NumberInput({
  value,
  onChange,
  min,
  step = 1,
}: {
  value: number;
  onChange: (v: number) => void;
  min?: number;
  step?: number;
}) {
  return (
    <input
      type="number"
      value={value}
      min={min}
      step={step}
      onChange={(e) => onChange(Number(e.target.value))}
      className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100"
    />
  );
}

function ResultRow({ label, value, emphasis }: { label: string; value: string; emphasis?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3 rounded-lg border border-slate-800 bg-slate-950/40 px-3 py-2">
      <span className="text-xs text-slate-400">{label}</span>
      <span className={`tabular text-right font-medium ${emphasis ? "text-lg text-slate-50" : "text-sm text-slate-100"}`}>
        {value}
      </span>
    </div>
  );
}

function formatMoney(value: number): string {
  return `${Math.round(value).toLocaleString("ja-JP")}`;
}
