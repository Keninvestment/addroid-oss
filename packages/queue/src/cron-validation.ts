// AdDroid OSS — cron expression validator (this implementation).
//
// CLI (`addroid cron set`) と Web UI (`POST /api/cron/[name]/schedule`) が
// 両方とも cron_schedules.cron に永続化する前に同じ厳格な検証を通せるよう、
// queue パッケージに寄せた共有ユーティリティ。
//
// pg-boss は内部で cron-parser を用いて enabled スケジュール時に式を validate
// するが、disabled プリセットに直接 set した cron 文字列はその経路を通らない。
// `cron_schedules.cron` にゴミが残ると、後で enable した瞬間に pg-boss が
// 失敗する/UI ミラーが嘘を表示するため、永続化前に 5 フィールド標準 crontab
// 構文を厳格に検証する。
//
// 受理する文法 (各フィールド共通):
//   `*`、整数、`a-b` 範囲、`a,b,c` リスト、`*/k` および `a-b/k` ステップ
//   month  : 1-12 または JAN..DEC (大文字小文字無視)
//   dow    : 0-7 または SUN..SAT (0 と 7 は日曜)
// 受理しない: Quartz 拡張 (`?`,`L`,`W`,`#`)、`@daily` 等のエイリアス、
//   6 フィールド (秒) 形式。

interface CronFieldSpec {
  label: string;
  min: number;
  max: number;
  names?: Record<string, number>;
}

const MONTH_NAMES: Record<string, number> = {
  JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6,
  JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12,
};

const DOW_NAMES: Record<string, number> = {
  SUN: 0, MON: 1, TUE: 2, WED: 3, THU: 4, FRI: 5, SAT: 6,
};

const CRON_FIELD_SPECS: readonly CronFieldSpec[] = [
  { label: "minute", min: 0, max: 59 },
  { label: "hour", min: 0, max: 23 },
  { label: "day-of-month", min: 1, max: 31 },
  { label: "month", min: 1, max: 12, names: MONTH_NAMES },
  { label: "day-of-week", min: 0, max: 7, names: DOW_NAMES },
];

export type CronValidationResult =
  | { ok: true }
  | { ok: false; reason: string };

export function validateCronExpression(expr: string): CronValidationResult {
  if (typeof expr !== "string") {
    return { ok: false, reason: "cron 式が文字列ではありません" };
  }
  const trimmed = expr.trim();
  if (trimmed === "") {
    return { ok: false, reason: "cron 式が空です" };
  }
  const fields = trimmed.split(/\s+/);
  if (fields.length !== 5) {
    return {
      ok: false,
      reason: `5 フィールド (分 時 日 月 曜) を期待しますが ${fields.length} フィールドでした`,
    };
  }
  for (let i = 0; i < 5; i += 1) {
    const result = validateCronField(fields[i]!, CRON_FIELD_SPECS[i]!);
    if (!result.ok) {
      return {
        ok: false,
        reason: `${CRON_FIELD_SPECS[i]!.label} フィールドが不正: ${result.reason}`,
      };
    }
  }
  return { ok: true };
}

function validateCronField(
  field: string,
  spec: CronFieldSpec
): CronValidationResult {
  if (field === "") return { ok: false, reason: "空のフィールド" };
  const parts = field.split(",");
  for (const part of parts) {
    if (part === "") return { ok: false, reason: "空のリスト要素" };
    const r = validateCronPart(part, spec);
    if (!r.ok) return r;
  }
  return { ok: true };
}

function validateCronPart(
  part: string,
  spec: CronFieldSpec
): CronValidationResult {
  const slashIdx = part.indexOf("/");
  let body: string;
  let stepStr: string | null;
  if (slashIdx >= 0) {
    body = part.slice(0, slashIdx);
    stepStr = part.slice(slashIdx + 1);
    if (body === "") return { ok: false, reason: `不正なステップ表記: ${part}` };
    if (stepStr === "") return { ok: false, reason: `ステップ値がありません: ${part}` };
    if (!/^\d+$/.test(stepStr)) {
      return { ok: false, reason: `ステップ値が整数ではありません: ${stepStr}` };
    }
    const step = Number.parseInt(stepStr, 10);
    if (step <= 0) {
      return { ok: false, reason: `ステップ値は正の整数: ${stepStr}` };
    }
    if (step > spec.max - spec.min + 1) {
      return { ok: false, reason: `ステップ値が範囲を超えています: ${stepStr}` };
    }
  } else {
    body = part;
    stepStr = null;
  }

  if (body === "*") return { ok: true };

  const dashIdx = body.indexOf("-");
  if (dashIdx > 0) {
    const aStr = body.slice(0, dashIdx);
    const bStr = body.slice(dashIdx + 1);
    const a = parseCronValue(aStr, spec);
    const b = parseCronValue(bStr, spec);
    if (a === null) return { ok: false, reason: `範囲開始値が不正: ${aStr}` };
    if (b === null) return { ok: false, reason: `範囲終了値が不正: ${bStr}` };
    if (a < spec.min || a > spec.max) {
      return { ok: false, reason: `範囲開始値が範囲外 [${spec.min}-${spec.max}]: ${aStr}` };
    }
    if (b < spec.min || b > spec.max) {
      return { ok: false, reason: `範囲終了値が範囲外 [${spec.min}-${spec.max}]: ${bStr}` };
    }
    if (a > b) {
      return { ok: false, reason: `範囲が逆順 (${aStr}-${bStr})` };
    }
    return { ok: true };
  }

  const v = parseCronValue(body, spec);
  if (v === null) return { ok: false, reason: `値が不正: ${body}` };
  if (v < spec.min || v > spec.max) {
    return { ok: false, reason: `値が範囲外 [${spec.min}-${spec.max}]: ${body}` };
  }
  return { ok: true };
}

function parseCronValue(token: string, spec: CronFieldSpec): number | null {
  if (token === "") return null;
  if (/^\d+$/.test(token)) {
    const n = Number.parseInt(token, 10);
    return Number.isFinite(n) ? n : null;
  }
  if (spec.names) {
    const named = spec.names[token.toUpperCase()];
    if (typeof named === "number") return named;
  }
  return null;
}
