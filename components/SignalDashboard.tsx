"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { SignalType } from "@/lib/autoSignalEngine";
import type { SignalApiResponse } from "@/lib/types";
import { describeCandleAge } from "@/lib/marketData";
import ConditionList from "./ConditionList";
import PriceChart from "./PriceChart";

interface SymbolOption {
  id: string;
  label: string;
}

const REFRESH_INTERVAL_MS = 60_000;

const SIGNAL_STYLES: Record<
  SignalType,
  { label: string; badge: string; accent: string; description: string }
> = {
  BUY: {
    label: "BUY",
    badge: "bg-emerald-500/15 text-emerald-300 ring-emerald-500/40",
    accent: "text-emerald-300",
    description: "買いエントリー条件を満たしています",
  },
  SELL: {
    label: "SELL",
    badge: "bg-rose-500/15 text-rose-300 ring-rose-500/40",
    accent: "text-rose-300",
    description: "売りエントリー条件を満たしています",
  },
  WAIT: {
    label: "WAIT",
    badge: "bg-slate-500/15 text-slate-300 ring-slate-500/40",
    accent: "text-slate-300",
    description: "条件が揃っていません。エントリーは見送りです",
  },
};

const TREND_LABELS: Record<string, string> = {
  UP: "上昇",
  DOWN: "下降",
  FLAT: "レンジ",
};

export default function SignalDashboard({ symbols }: { symbols: SymbolOption[] }) {
  const [symbol, setSymbol] = useState(symbols[0]?.id ?? "USDJPY");
  const [data, setData] = useState<SignalApiResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);

  // 進行中のリクエストを識別する。銘柄を素早く切り替えると、先に投げた
  // 遅いリクエストが後から返って別銘柄の判定を上書きしうる。取引の判断に
  // 使う画面で表示と銘柄がずれるのは危険なので、最新の要求以外は捨てる。
  const requestId = useRef(0);
  const inFlight = useRef<AbortController | null>(null);

  const load = useCallback(async (target: string) => {
    inFlight.current?.abort();
    const controller = new AbortController();
    inFlight.current = controller;

    const id = ++requestId.current;
    const isStale = () => id !== requestId.current;

    setLoading(true);
    try {
      const response = await fetch(`/api/signal?symbol=${encodeURIComponent(target)}`, {
        cache: "no-store",
        signal: controller.signal,
      });
      const json = await response.json();
      if (isStale()) return;

      if (!response.ok) {
        throw new Error(json?.error ?? `HTTP ${response.status}`);
      }
      setData(json as SignalApiResponse);
      setError(null);
      setUpdatedAt(new Date());
    } catch (err) {
      // 自分で中断したものと、既に古くなった結果は無視する
      if (isStale() || (err instanceof DOMException && err.name === "AbortError")) return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      // 後続のリクエストが走っている間は読み込み中のままにする
      if (!isStale()) setLoading(false);
    }
  }, []);

  // 画面を離れる時に進行中のリクエストを片付ける
  useEffect(() => () => inFlight.current?.abort(), []);

  useEffect(() => {
    void load(symbol);
  }, [symbol, load]);

  useEffect(() => {
    if (!autoRefresh) return;
    const timer = setInterval(() => void load(symbol), REFRESH_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [autoRefresh, symbol, load]);

  const style = data ? SIGNAL_STYLES[data.signal] : SIGNAL_STYLES.WAIT;

  return (
    <div className="mx-auto max-w-6xl space-y-6 px-4 py-8 sm:px-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-slate-50">自動シグナル判定エンジン</h1>
          <p className="mt-1 text-sm text-slate-400">
            マルチタイムフレーム（1H / 4H / 8H / 日足）の15条件を自動判定します
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <label className="sr-only" htmlFor="symbol-select">
            通貨ペア
          </label>
          <select
            id="symbol-select"
            value={symbol}
            onChange={(event) => setSymbol(event.target.value)}
            className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100"
          >
            {symbols.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </select>

          <button
            type="button"
            onClick={() => void load(symbol)}
            disabled={loading}
            className="rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-slate-100 hover:bg-slate-700 disabled:opacity-50"
          >
            {loading ? "更新中…" : "再判定"}
          </button>

          <label className="flex items-center gap-2 text-sm text-slate-400">
            <input
              type="checkbox"
              checked={autoRefresh}
              onChange={(event) => setAutoRefresh(event.target.checked)}
              className="h-4 w-4 accent-sky-500"
            />
            自動更新（60秒）
          </label>
        </div>
      </header>

      {/*
        60秒ごとに勝手に書き換わる画面なので、見ていない人には変化が届かない。
        判定が変わったことだけを読み上げる領域を別に置く。画面全体を
        live region にすると更新のたびに全項目を読み上げてしまう。
      */}
      <main className="space-y-6" aria-busy={loading}>
        <NoEdgeWarning />

        <p className="sr-only" role="status" aria-live="polite">
          {data
            ? `${data.symbolLabel} ${data.signal}　信頼度${data.confidence}%`
            : loading
              ? "相場データを取得しています"
              : ""}
        </p>

        {error && (
          <div className="rounded-lg border border-rose-900 bg-rose-950/40 px-4 py-3 text-sm text-rose-200">
            {error}
          </div>
        )}

        {!data && loading && (
          <p className="text-sm text-slate-400">相場データを取得しています…</p>
        )}

        {data && (
          <>
          {data.dataSource === "synthetic" && (
            <div className="rounded-lg border border-amber-900/70 bg-amber-950/30 px-4 py-3 text-sm text-amber-200">
              <strong className="font-semibold">合成データで動作中です。</strong>{" "}
              表示中のシグナルはデモ用で、実際の相場を反映していません。
              {data.dataNote && <span className="block text-amber-300/80">理由: {data.dataNote}</span>}
            </div>
          )}

          <section className="grid gap-4 lg:grid-cols-3">
            <div className="rounded-xl border border-slate-800 bg-slate-900/50 p-5 lg:col-span-2">
              <div className="flex flex-wrap items-center justify-between gap-4">
                <div>
                  <p className="text-sm text-slate-400">{data.symbolLabel}</p>
                  <p className="tabular mt-1 text-3xl font-bold text-slate-50">
                    {data.analysis.currentPrice.toFixed(data.digits)}
                  </p>
                </div>

                <div className="text-right">
                  <span
                    className={`inline-flex items-center rounded-full px-5 py-2 text-2xl font-black ring-1 ${style.badge}`}
                  >
                    {style.label}
                  </span>
                  <p className="mt-2 text-xs text-slate-400">{style.description}</p>
                </div>
              </div>

              <div className="mt-5">
                <div className="mb-1 flex items-baseline justify-between text-sm">
                  <span className="text-slate-400">信頼度</span>
                  <span className={`tabular font-semibold ${style.accent}`}>
                    {data.confidence}%
                  </span>
                </div>
                <div className="h-2 overflow-hidden rounded-full bg-slate-800">
                  <div
                    className={`h-full rounded-full ${
                      data.signal === "BUY"
                        ? "bg-emerald-500"
                        : data.signal === "SELL"
                          ? "bg-rose-500"
                          : "bg-slate-500"
                    }`}
                    style={{ width: `${data.confidence}%` }}
                  />
                </div>
              </div>

              <dl className="mt-5 grid grid-cols-2 gap-x-6 gap-y-3 text-sm sm:grid-cols-4">
                <Stat label="1H" value={TREND_LABELS[data.analysis.trend1H]} />
                <Stat label="4H" value={TREND_LABELS[data.analysis.trend4H]} />
                <Stat label="日足" value={TREND_LABELS[data.analysis.trendDaily]} />
                <Stat label="セッション" value={data.analysis.timeSession} />
                <Stat label="RSI" value={data.analysis.currentRSI.toFixed(1)} />
                <Stat
                  label="ATR"
                  value={`${(data.analysis.currentATR / data.pipSize).toFixed(1)} pips`}
                />
                <Stat label="20EMA" value={data.analysis.ema20.toFixed(data.digits)} />
                <Stat label="200EMA" value={data.analysis.ema200.toFixed(data.digits)} />
              </dl>

              {data.signal === "WAIT" && <WaitFrequencyNote />}
            </div>

            <div className="space-y-4">
              <div className="rounded-xl border border-slate-800 bg-slate-900/50 p-5">
                <h2 className="text-sm font-semibold text-slate-200">売買プラン</h2>
                {data.tradePlan ? (
                  <dl className="mt-3 space-y-2 text-sm">
                    <PlanRow
                      label="エントリー"
                      value={data.tradePlan.entry.toFixed(data.digits)}
                    />
                    <PlanRow
                      label="損切り"
                      value={`${data.tradePlan.stopLoss.toFixed(data.digits)} (${data.tradePlan.stopPips.toFixed(1)} pips)`}
                      tone="text-rose-300"
                    />
                    <PlanRow
                      label="利確"
                      value={`${data.tradePlan.takeProfit.toFixed(data.digits)} (${data.tradePlan.targetPips.toFixed(1)} pips)`}
                      tone="text-emerald-300"
                    />
                    <PlanRow
                      label="リスクリワード"
                      value={`1 : ${data.tradePlan.riskRewardRatio}`}
                    />
                    {data.lotPlan && data.lotPlan.lots > 0 && (
                      <>
                        <PlanRow
                          label="ロット"
                          value={`${data.lotPlan.lots.toFixed(2)} lot`}
                        />
                        <PlanRow
                          label="損切り時の損失"
                          value={`${Math.round(data.lotPlan.actualLossAtStop).toLocaleString("ja-JP")}（残高の${data.lotPlan.actualRiskPercent.toFixed(2)}%）`}
                        />
                      </>
                    )}
                  </dl>
                ) : (
                  <p className="mt-3 text-sm text-slate-400">
                    WAIT のためプランはありません。
                  </p>
                )}
                {data.lotPlan && data.lotPlan.warnings.length > 0 && (
                  <p className="mt-3 text-xs text-amber-300/90">
                    {data.lotPlan.warnings.join(" / ")}
                  </p>
                )}
                {data.tradePlan && !data.lotPlan && (
                  <p className="mt-3 text-xs text-slate-400">
                    ロットを出すには環境変数 ACCOUNT_BALANCE を設定してください
                    （pipsは金額ではないため、リスクの大きさが分かりません）。
                  </p>
                )}
              </div>

              <div className="rounded-xl border border-slate-800 bg-slate-900/50 p-5">
                <h2 className="text-sm font-semibold text-slate-200">MTFフィルター</h2>
                <dl className="mt-3 space-y-2 text-sm">
                  <PlanRow
                    label="4H MACD"
                    value={`${data.analysis.mtfFilter.macd4H.direction} (${data.analysis.mtfFilter.macd4H.histogram.toFixed(4)})`}
                  />
                  <PlanRow
                    label="8H トレンド"
                    value={data.analysis.mtfFilter.trend8H.direction}
                  />
                  <PlanRow
                    label="BUY通過"
                    value={data.analysis.mtfFilter.buyPass ? "○" : "×"}
                    tone={data.analysis.mtfFilter.buyPass ? "text-emerald-300" : "text-slate-400"}
                  />
                  <PlanRow
                    label="SELL通過"
                    value={data.analysis.mtfFilter.sellPass ? "○" : "×"}
                    tone={data.analysis.mtfFilter.sellPass ? "text-rose-300" : "text-slate-400"}
                  />
                </dl>
              </div>
            </div>
          </section>

          <section className="rounded-xl border border-slate-800 bg-slate-900/50 p-5">
            <h2 className="mb-4 text-sm font-semibold text-slate-200">
              チャート（1H 直近30本）
            </h2>
            <PriceChart data={data.chartData} digits={data.digits} />
          </section>

          <section className="rounded-xl border border-slate-800 bg-slate-900/50 p-5">
            <h2 className="mb-4 text-sm font-semibold text-slate-200">判定条件の内訳</h2>
            <ConditionList conditions={data.conditions} />
          </section>

          <section className="rounded-xl border border-slate-800 bg-slate-900/50 p-5">
            <h2 className="mb-3 text-sm font-semibold text-slate-200">補足分析</h2>
            <dl className="grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
              <PlanRow label="ダウ理論構造" value={data.analysis.marketStructure} />
              <PlanRow label="ローソク足" value={data.analysis.candlePattern} />
              <PlanRow label="ダイバージェンス" value={data.analysis.divergence} />
              <PlanRow label="ATR状態" value={data.analysis.atrStatus} />
              <PlanRow label="BBシグナル" value={data.analysis.bbSignal} />
              <PlanRow label="MACDシグナル" value={data.analysis.macdSignal} />
              <PlanRow
                label="BB+MACD総合"
                value={`${data.analysis.bbMacdComboDirection} (${data.analysis.bbMacdComboConfidence}%)`}
              />
              <PlanRow
                label="サポレジ"
                value={data.analysis.nearSR ? "近接あり" : "離れている"}
              />
            </dl>
            <p className="mt-3 text-xs text-slate-400">
              {data.analysis.bbMacdComboReason}
            </p>
          </section>
          </>
        )}
      </main>

      {data && (
        <footer className="flex flex-wrap justify-between gap-2 pb-8 text-xs text-slate-400">
          <span>
            データ元: {data.dataSource === "yahoo" ? "Yahoo Finance" : "合成データ"} ・
            1H {data.candleCounts.h1}本 / 4H {data.candleCounts.h4}本 / 8H{" "}
            {data.candleCounts.h8}本 / 日足 {data.candleCounts.daily}本
          </span>
          <span className="flex flex-wrap gap-3">
            <Freshness latestCandleTime={data.latestCandleTime} />
            {updatedAt && <span>取得: {updatedAt.toLocaleTimeString("ja-JP")}</span>}
          </span>
        </footer>
      )}
    </div>
  );
}

/**
 * 最新1H足がいつのものかを出す。
 * リアルタイム運用では「今の判定が古い足で出ていないか」が分からないと危ないので、
 * 足の鮮度を数字で見せる。1H足なので通常は0〜60分前になり、
 * 2時間以上あいている場合は取得が止まっているか市場が閉じている。
 */
function Freshness({ latestCandleTime }: { latestCandleTime: number | null }) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);

  if (latestCandleTime === null) return null;

  const { label, stale } = describeCandleAge(latestCandleTime, now);

  return (
    <span className={stale ? "text-amber-400" : undefined}>
      最新の1H足: {label}
      {stale && "（更新が止まっているか市場が閉じています）"}
    </span>
  );
}

/**
 * WAITが続くのは壊れているからではない、と言うための注記。
 *
 * 数字は合成系列8本・22,416時間ぶんの判定を数えたもの（`_rev_freq` の計測）。
 * WAIT以外になったのは1.40%（BUY 123 / SELL 190）で、出ている時間は
 * 平均1.4時間、間隔は平均103時間だった。
 *
 * これを黙っていると、画面が何日もWAITのままなのを見た人は取得が
 * 止まっていると考える。そして、たまたま開いた1回で判定が出ていない
 * ことをもって「使えない」と結論する。実際には、見に来る使い方では
 * ほとんど取り逃す頻度でしか出ない、というのがこの戦略の性質になる。
 */
/**
 * 実データでの検証結果。
 *
 * 画面はBUY/SELLを断定的に出すので、それが何に裏打ちされているかを
 * 同じ画面に置かないと、判定が根拠のあるものに見えてしまう。
 * ドル円9年4か月・440トレードで勝率35.0%・PF 1.05、同じ値動きに対する
 * ランダムエントリー（30.9〜37.3%）と区別がつかなかった。
 *
 * この一文を消してよくなるのは、実データで優位性が確認できたときだけ。
 */
function NoEdgeWarning() {
  return (
    <div className="rounded-lg border border-amber-700/60 bg-amber-950/40 px-4 py-3 text-sm text-amber-100">
      <p className="font-semibold">
        この判定ロジックに、実データ上の優位性は確認できていません。
      </p>
      <p className="mt-1.5 text-xs leading-relaxed text-amber-200/90">
        ドル円 2012-11〜2022-03 の440トレードで勝率
        <span className="tabular"> 35.0% </span>・PF
        <span className="tabular"> 1.05</span>、最大ドローダウン
        <span className="tabular"> 1110 pips</span>。エントリーだけをランダムにした
        対照実験（勝率 30.9〜37.3%）と区別がつきませんでした。
        表示している売買プランは検証用で、資金を入れる根拠にはなりません。
      </p>
      <p className="mt-1.5 text-xs leading-relaxed text-amber-200/90">
        別の入り方も14通り試しました（1時間足7件・日足7件 × 12通貨ペア）。
        残ったのは「月初に前月と逆へ入る」1件だけで、1971年からの22通貨で
        確かめると<strong>直近14年は有効・その前の40年は逆向き</strong>でした。
        優位性ではなく相場付きです。検証の手順は README にあります。
      </p>
    </div>
  );
}

function WaitFrequencyNote() {
  return (
    <div className="mt-5 rounded-lg border border-slate-800 bg-slate-950/40 p-4 text-xs leading-relaxed text-slate-400">
      <p className="font-semibold text-slate-300">WAITが続くのは正常です</p>
      <p className="mt-1.5">
        合成データで22,416時間ぶんを判定したところ、WAIT以外になったのは
        <span className="tabular text-slate-200"> 1.4% </span>
        だけでした。1銘柄あたり平均
        <span className="tabular text-slate-200"> 4.3日に1回</span>
        、出ている時間は平均
        <span className="tabular text-slate-200"> 1.4時間 </span>
        です。
      </p>
      <p className="mt-1.5">
        この頻度だと、画面を見に来る使い方ではほとんど取り逃します。
        <code className="rounded bg-slate-800/70 px-1 py-0.5 text-slate-300">npm run watch</code>
        で通知を受け取る運用を前提にしてください。
      </p>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs text-slate-400">{label}</dt>
      <dd className="tabular mt-0.5 font-medium text-slate-100">{value}</dd>
    </div>
  );
}

function PlanRow({
  label,
  value,
  tone = "text-slate-100",
}: {
  label: string;
  value: string;
  tone?: string;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-slate-400">{label}</dt>
      <dd className={`tabular text-right font-medium ${tone}`}>{value}</dd>
    </div>
  );
}
