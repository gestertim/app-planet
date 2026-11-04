import { createTeacherSignupHandler } from "../../../../../server/auth/teacher-signup.ts";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const handler = createTeacherSignupHandler();

export async function POST(request: Request): Promise<Response> {
  return handler(request);
}
