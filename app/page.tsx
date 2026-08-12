import SignalDashboard from "@/components/SignalDashboard";
import { SIGNAL_SYMBOLS } from "@/lib/marketData";

export default function Home() {
  // 画面に出すのはシグナルを出す銘柄だけ。API は仕様の分かっている
  // 銘柄をすべて受け付けるが、通知しないものを並べても選ばせる意味が無い
  const symbols = SIGNAL_SYMBOLS.map((s) => ({ id: s.id, label: s.label }));
  return <SignalDashboard symbols={symbols} />;
}
