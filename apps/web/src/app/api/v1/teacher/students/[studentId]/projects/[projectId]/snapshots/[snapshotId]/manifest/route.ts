import { productProjectFileHandlers } from "@/server/product-handlers";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request, {
  params,
}: { params: Promise<{ studentId: string; projectId: string; snapshotId: string }> }) {
  return productProjectFileHandlers.teacherSnapshot(request, await params);
}
