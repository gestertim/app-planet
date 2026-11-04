import { createTeacherReviewHandlers } from "@/server/admin/teacher-review";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
const handler = createTeacherReviewHandlers().list;
export async function GET(request: Request): Promise<Response> {
  return handler(request);
}
