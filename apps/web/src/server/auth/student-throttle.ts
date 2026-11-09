import { StaffLoginThrottle, staffLoginIsolatedTestPolicy } from "./staff.ts";

export const studentLoginPolicy = Object.freeze({
  ...staffLoginIsolatedTestPolicy,
  sourceAttemptLimit: 60,
  countRejectedPairAttempts: true,
  sessionMaxAgeMaxSeconds: 600,
});

// 與 A-2 分離，不能改變教職員 20/min 的既有設定。
export class StudentLoginThrottle extends StaffLoginThrottle {
  constructor(now: () => number = Date.now) {
    super(studentLoginPolicy, now);
  }
}

const key = Symbol.for("app-planet.student-login-throttle.memory-single-process");
type Global = typeof globalThis & { [key]?: StudentLoginThrottle };
export function processStudentThrottle(): StudentLoginThrottle {
  const global = globalThis as Global;
  return global[key] ??= new StudentLoginThrottle();
}
