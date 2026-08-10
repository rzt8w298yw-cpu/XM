/**
 * 経済指標カレンダー
 *
 * 重要指標の発表前後は値動きが飛ぶため、その時間帯のエントリーを避ける。
 *
 * 実際の発表予定は外部のカレンダーから取るのが本筋だが、接続先が無い場合の
 * ために「主要指標の定例発表時刻」を使った推定も用意している。推定は
 * あくまで推定なので、判定結果にその旨が残るようにしてある。
 */

export interface EconomicEvent {
  /** 発表時刻（エポックミリ秒） */
  timestamp: number;
  /** 指標名 */
  name: string;
}

export interface CalendarCheck {
  /** 危険時間帯を避けられているか */
  ok: boolean;
  /** 実際の予定に基づく判定か（false なら定例時刻からの推定） */
  fromSchedule: boolean;
  description: string;
}

/**
 * 主要指標の定例発表時刻（JSTの分単位）。
 * 実際のスケジュールとはズレるので、あくまで代替手段。
 */
const ROUTINE_JST_MINUTES = [
  { at: 21 * 60 + 30, name: "米雇用統計/CPI/GDP" },
  { at: 22 * 60, name: "ISM" },
  { at: 3 * 60, name: "FOMC" },
  { at: 12 * 60, name: "日銀" },
];

/** 発表の前後この分数はエントリーを避ける */
export const DEFAULT_AVOID_MINUTES = 30;

/**
 * 指定時刻が指標発表の前後に当たるかを判定する。
 *
 * `events` に実際の発表予定を渡せばそれを使い、渡さなければ定例時刻から
 * 推定する。推定であることは `fromSchedule` で区別できる。
 */
export function checkEconomicCalendar(
  atTime: number,
  events: EconomicEvent[] | null | undefined,
  avoidMinutes = DEFAULT_AVOID_MINUTES,
): CalendarCheck {
  const windowMs = avoidMinutes * 60_000;

  if (events && events.length > 0) {
    const near = events.find((e) => Math.abs(e.timestamp - atTime) <= windowMs);
    return near
      ? {
          ok: false,
          fromSchedule: true,
          description: `${near.name} の発表前後${avoidMinutes}分`,
        }
      : { ok: true, fromSchedule: true, description: "発表予定なし" };
  }

  // 実予定が無い場合は定例時刻から推定する
  const date = new Date(atTime);
  const jstMinutes = (((date.getUTCHours() + 9) % 24) * 60) + date.getUTCMinutes();

  for (const routine of ROUTINE_JST_MINUTES) {
    // 日付をまたぐ距離も見る（23:50 と 00:10 は20分差）
    const direct = Math.abs(jstMinutes - routine.at);
    const wrapped = 1440 - direct;
    if (Math.min(direct, wrapped) <= avoidMinutes) {
      return {
        ok: false,
        fromSchedule: false,
        description: `${routine.name} の定例時刻前後${avoidMinutes}分（推定）`,
      };
    }
  }

  return { ok: true, fromSchedule: false, description: "指標発表なし（推定）" };
}
