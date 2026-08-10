/**
 * 戦略パラメータの一元管理
 *
 * 判定の閾値と決済条件（損切り幅・リスクリワード）を1か所にまとめ、
 * 環境変数で上書きできるようにしている。
 *
 * `npm run optimize` で実データを探索して良い設定が見つかっても、
 * それをアプリ側に反映する手段が無ければ意味がない。バックテストと
 * 本番のアプリが同じ設定を読むようにするための入口がここ。
 */
import { DEFAULT_THRESHOLDS, type SignalThresholds } from "./autoSignalEngine";

export interface StrategyConfig {
  thresholds: SignalThresholds;
  /** 損切り幅 = ATR × この倍率 */
  atrStopMultiplier: number;
  /** 利確幅 = 損切り幅 × この倍率 */
  riskRewardRatio: number;
  /**
   * 口座残高（口座通貨建て）。0ならロット計算をしない。
   * pipsは金額ではないので、これが無いとリスクの大きさが分からない
   */
  accountBalance: number;
  /** 1トレードで許容する損失の割合（%） */
  riskPercent: number;
}

export const DEFAULT_STRATEGY: StrategyConfig = {
  thresholds: DEFAULT_THRESHOLDS,
  atrStopMultiplier: 1.5,
  riskRewardRatio: 2,
  accountBalance: 0,
  riskPercent: 2,
};

/** 環境変数名と、その値が満たすべき範囲 */
const NUMERIC_SETTINGS = {
  SIGNAL_BUY_SCORE_MIN: { min: 0, max: 1 },
  SIGNAL_SELL_SCORE_MIN: { min: 0, max: 1 },
  SIGNAL_BUY_RSI_MAX: { min: 1, max: 100 },
  SIGNAL_SELL_RSI_MIN: { min: 0, max: 99 },
  TRADE_ATR_STOP: { min: 0.1, max: 10 },
  TRADE_RISK_REWARD: { min: 0.1, max: 20 },
  ACCOUNT_BALANCE: { min: 0, max: 1_000_000_000_000 },
  RISK_PERCENT: { min: 0.01, max: 100 },
} as const;

type SettingName = keyof typeof NUMERIC_SETTINGS;

export interface LoadResult {
  config: StrategyConfig;
  /** 上書きされた項目（表示・ログ用） */
  overrides: string[];
  /** 値が不正で無視した項目 */
  warnings: string[];
}

/**
 * 環境変数から設定を読む。
 * 未設定・不正な値は既定値のままにし、不正なものは warnings に積む
 * （黙って既定値に落ちると、設定したつもりで効いていない状態に気づけない）。
 */
export function loadStrategyConfig(
  env: Record<string, string | undefined> = process.env,
): LoadResult {
  const overrides: string[] = [];
  const warnings: string[] = [];

  const read = (name: SettingName, fallback: number): number => {
    const raw = env[name];
    if (raw === undefined || raw.trim() === "") return fallback;

    const value = Number(raw);
    const { min, max } = NUMERIC_SETTINGS[name];
    if (!Number.isFinite(value)) {
      warnings.push(`${name}="${raw}" は数値ではないため無視しました（${fallback} を使用）`);
      return fallback;
    }
    if (value < min || value > max) {
      warnings.push(
        `${name}=${value} は範囲外です（${min}〜${max}）。無視しました（${fallback} を使用）`,
      );
      return fallback;
    }
    overrides.push(`${name}=${value}`);
    return value;
  };

  const config: StrategyConfig = {
    thresholds: {
      buyScoreMin: read("SIGNAL_BUY_SCORE_MIN", DEFAULT_STRATEGY.thresholds.buyScoreMin),
      sellScoreMin: read("SIGNAL_SELL_SCORE_MIN", DEFAULT_STRATEGY.thresholds.sellScoreMin),
      buyRsiMax: read("SIGNAL_BUY_RSI_MAX", DEFAULT_STRATEGY.thresholds.buyRsiMax),
      sellRsiMin: read("SIGNAL_SELL_RSI_MIN", DEFAULT_STRATEGY.thresholds.sellRsiMin),
    },
    atrStopMultiplier: read("TRADE_ATR_STOP", DEFAULT_STRATEGY.atrStopMultiplier),
    riskRewardRatio: read("TRADE_RISK_REWARD", DEFAULT_STRATEGY.riskRewardRatio),
    accountBalance: read("ACCOUNT_BALANCE", DEFAULT_STRATEGY.accountBalance),
    riskPercent: read("RISK_PERCENT", DEFAULT_STRATEGY.riskPercent),
  };

  // BUYの下限がSELLの下限を上回るような組み合わせ自体は成立するので、
  // ここでは値域だけを見て、戦略上の妥当性は利用者の判断に委ねる。
  return { config, overrides, warnings };
}
