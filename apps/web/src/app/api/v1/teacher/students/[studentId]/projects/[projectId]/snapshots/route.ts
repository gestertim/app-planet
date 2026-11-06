import { productProjectFileHandlers } from "@/server/product-handlers";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request, {
  params,
}: { params: Promise<{ studentId: string; projectId: string }> }) {
  return productProjectFileHandlers.teacherSnapshots(request, await params);
}
