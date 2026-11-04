import { productTeacherResourceHandlers } from "@/server/product-handlers";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request, {
  params,
}: { params: Promise<{ studentId: string; projectId: string; stage: string }> }) {
  return productTeacherResourceHandlers.stageDraft(request, await params);
}
