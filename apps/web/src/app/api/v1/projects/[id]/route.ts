import { productProjectHandlers, productProjectRenameHandlers } from "../../../../../server/product-handlers.ts";

export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return productProjectHandlers.read(request, await params);
}

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return productProjectRenameHandlers.patch(request, await params);
}
