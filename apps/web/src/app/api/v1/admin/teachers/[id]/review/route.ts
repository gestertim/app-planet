import { createTeacherReviewHandlers } from "@/server/admin/teacher-review";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
const handler = createTeacherReviewHandlers().review;
export async function POST(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  return handler(request, await context.params);
}
