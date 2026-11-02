import { productProjectHandlers } from "../../../../../server/product-handlers.ts";

export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return productProjectHandlers.read(request, await params);
}
