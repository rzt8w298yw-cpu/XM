import CarryTradeTool from "@/components/CarryTradeTool";
import { SYMBOLS } from "@/lib/marketData";

export default function CarryPage() {
  const symbols = SYMBOLS.map((s) => ({ id: s.id, label: s.label, pipSize: s.pipSize }));
  return <CarryTradeTool symbols={symbols} />;
}
