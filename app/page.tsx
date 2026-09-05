import Link from "next/link";
import SignalDashboard from "@/components/SignalDashboard";
import { SIGNAL_SYMBOLS } from "@/lib/marketData";

export default function Home() {
  // 画面に出すのはシグナルを出す銘柄だけ。API は仕様の分かっている
  // 銘柄をすべて受け付けるが、通知しないものを並べても選ばせる意味が無い
  const symbols = SIGNAL_SYMBOLS.map((s) => ({ id: s.id, label: s.label }));
  return (
    <>
      <div className="mx-auto max-w-6xl px-4 pt-6 sm:px-6">
        <Link
          href="/carry"
          className="inline-flex items-center gap-1.5 rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-xs text-slate-300 hover:bg-slate-800"
        >
          キャリートレード計算・記録ツールへ →
        </Link>
      </div>
      <SignalDashboard symbols={symbols} />
    </>
  );
}
