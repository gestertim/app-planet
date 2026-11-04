import { productProjectClassificationHandlers } from "../../../../../../server/product-handlers.ts";

export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string }> };

export async function GET(request: Request, { params }: Context) {
  return productProjectClassificationHandlers.read(request, await params);
}

export async function PUT(request: Request, { params }: Context) {
  return productProjectClassificationHandlers.save(request, await params);
}
