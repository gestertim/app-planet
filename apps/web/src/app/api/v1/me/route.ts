import { createMeHandler } from "../../../../server/auth/me.ts";

export const dynamic = "force-dynamic";

const handler = createMeHandler();

export async function GET(request: Request): Promise<Response> {
  return handler(request);
}
