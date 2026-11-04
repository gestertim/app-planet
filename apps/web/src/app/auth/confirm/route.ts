import { createEmailConfirmLandingHandler } from "../../../server/auth/teacher-signup.ts";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const handler = createEmailConfirmLandingHandler();

export async function GET(request: Request): Promise<Response> {
  return handler(request);
}
