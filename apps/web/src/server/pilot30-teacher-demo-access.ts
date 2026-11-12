import "server-only";

export type Pilot30TeacherDemoEnvironment = Readonly<{
  NODE_ENV?: string;
  PILOT30_TEACHER_DEMO_ENABLED?: string;
}>;

export function isPilot30TeacherDemoEnabled(env: Pilot30TeacherDemoEnvironment): boolean {
  return env.NODE_ENV === "development" && env.PILOT30_TEACHER_DEMO_ENABLED === "true";
}
