import { createStaffLoginHandler } from "../../../../../../server/auth/staff.ts";

export const dynamic = "force-dynamic";

const handler = createStaffLoginHandler();

export async function POST(request: Request): Promise<Response> {
  return handler(request);
}
