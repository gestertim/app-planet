import { createTeacherSignupVerifyHandler } from "../../../../../../server/auth/teacher-signup.ts";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const handler = createTeacherSignupVerifyHandler();

export async function POST(request: Request): Promise<Response> {
  return handler(request);
}

export async function DELETE(request: Request): Promise<Response> {
  return handler(request);
}
