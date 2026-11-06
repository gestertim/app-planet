import { productProjectFileHandlers } from "@/server/product-handlers";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Params = { id: string; snapshotId: string; path: string[] };
async function routeParams(params: Promise<Params>) {
  const resolved = await params;
  return { ...resolved, path: resolved.path.join("/") };
}
export async function GET(request: Request, { params }: { params: Promise<Params> }) {
  return productProjectFileHandlers.snapshotFile(request, await routeParams(params));
}
