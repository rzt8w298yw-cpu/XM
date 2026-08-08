import type { ChartDataPoint } from "@/lib/autoSignalEngine";

const WIDTH = 820;
const PRICE_HEIGHT = 240;
const RSI_HEIGHT = 90;
const PADDING = { top: 16, right: 62, bottom: 22, left: 10 };

interface Props {
  data: ChartDataPoint[];
  digits: number;
}

/** 直近30本の終値・EMA・RSIを描くSVGチャート（外部ライブラリなし） */
export default function PriceChart({ data, digits }: Props) {
  if (data.length < 2) {
    return (
      <p className="text-sm text-slate-400">
        チャートを描画するにはデータが不足しています。
      </p>
    );
  }

  const innerWidth = WIDTH - PADDING.left - PADDING.right;
  const innerHeight = PRICE_HEIGHT - PADDING.top - PADDING.bottom;

  // 終値と2本のEMAが全部収まるように上下レンジを決める
  const values = data.flatMap((d) => [d.close, d.ema20, d.ema200]);
  const rawMin = Math.min(...values);
  const rawMax = Math.max(...values);
  const margin = (rawMax - rawMin) * 0.08 || rawMax * 0.001 || 1;
  const min = rawMin - margin;
  const max = rawMax + margin;

  const x = (index: number) =>
    PADDING.left + (index / (data.length - 1)) * innerWidth;
  const y = (value: number) =>
    PADDING.top + ((max - value) / (max - min)) * innerHeight;

  const toPath = (pick: (d: ChartDataPoint) => number) =>
    data
      .map((d, i) => `${i === 0 ? "M" : "L"} ${x(i).toFixed(2)} ${y(pick(d)).toFixed(2)}`)
      .join(" ");

  const gridLines = [0, 0.25, 0.5, 0.75, 1].map((ratio) => {
    const value = max - (max - min) * ratio;
    return { value, yPos: PADDING.top + ratio * innerHeight };
  });

  const rsiInnerHeight = RSI_HEIGHT - 28;
  const rsiY = (value: number) => 14 + ((100 - value) / 100) * rsiInnerHeight;
  const rsiPath = data
    .map((d, i) => `${i === 0 ? "M" : "L"} ${x(i).toFixed(2)} ${rsiY(d.rsi).toFixed(2)}`)
    .join(" ");

  const first = data[0];
  const last = data[data.length - 1];

  return (
    <div className="space-y-2">
      <svg
        viewBox={`0 0 ${WIDTH} ${PRICE_HEIGHT}`}
        className="w-full"
        role="img"
        aria-label="価格と移動平均のチャート"
      >
        {gridLines.map((line) => (
          <g key={line.yPos}>
            <line
              x1={PADDING.left}
              x2={WIDTH - PADDING.right}
              y1={line.yPos}
              y2={line.yPos}
              stroke="#1e293b"
              strokeWidth={1}
            />
            <text
              x={WIDTH - PADDING.right + 8}
              y={line.yPos + 4}
              fill="#64748b"
              fontSize={11}
              className="tabular"
            >
              {line.value.toFixed(digits)}
            </text>
          </g>
        ))}

        <path d={toPath((d) => d.ema200)} fill="none" stroke="#f59e0b" strokeWidth={1.5} />
        <path d={toPath((d) => d.ema20)} fill="none" stroke="#38bdf8" strokeWidth={1.5} />
        <path d={toPath((d) => d.close)} fill="none" stroke="#e2e8f0" strokeWidth={2} />

        <circle cx={x(data.length - 1)} cy={y(last.close)} r={4} fill="#e2e8f0" />

        <text x={PADDING.left} y={PRICE_HEIGHT - 6} fill="#64748b" fontSize={11}>
          {formatTime(first.time)}
        </text>
        <text
          x={WIDTH - PADDING.right}
          y={PRICE_HEIGHT - 6}
          fill="#64748b"
          fontSize={11}
          textAnchor="end"
        >
          {formatTime(last.time)}
        </text>
      </svg>

      <svg
        viewBox={`0 0 ${WIDTH} ${RSI_HEIGHT}`}
        className="w-full"
        role="img"
        aria-label="RSIのチャート"
      >
        {[70, 50, 30].map((level) => (
          <g key={level}>
            <line
              x1={PADDING.left}
              x2={WIDTH - PADDING.right}
              y1={rsiY(level)}
              y2={rsiY(level)}
              stroke={level === 50 ? "#1e293b" : "#334155"}
              strokeWidth={1}
              strokeDasharray={level === 50 ? "0" : "4 4"}
            />
            <text
              x={WIDTH - PADDING.right + 8}
              y={rsiY(level) + 4}
              fill="#64748b"
              fontSize={11}
              className="tabular"
            >
              {level}
            </text>
          </g>
        ))}
        <path d={rsiPath} fill="none" stroke="#a78bfa" strokeWidth={1.8} />
        <text x={PADDING.left} y={RSI_HEIGHT - 2} fill="#64748b" fontSize={11}>
          RSI(14)
        </text>
      </svg>

      <div className="flex flex-wrap gap-4 text-xs text-slate-400">
        <LegendItem color="#e2e8f0" label="終値" />
        <LegendItem color="#38bdf8" label="20EMA" />
        <LegendItem color="#f59e0b" label="200EMA" />
        <LegendItem color="#a78bfa" label="RSI(14)" />
      </div>
    </div>
  );
}

function LegendItem({ color, label }: { color: string; label: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <span
        className="inline-block h-0.5 w-4 rounded"
        style={{ backgroundColor: color }}
      />
      {label}
    </span>
  );
}

function formatTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString("ja-JP", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Asia/Tokyo",
  });
}
