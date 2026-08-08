import SignalDashboard from "@/components/SignalDashboard";
import { SYMBOLS } from "@/lib/marketData";

export default function Home() {
  const symbols = SYMBOLS.map((s) => ({ id: s.id, label: s.label }));
  return <SignalDashboard symbols={symbols} />;
}
