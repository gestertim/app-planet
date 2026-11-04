import { productProjectClassificationHandlers } from "../../../../../../../server/product-handlers.ts";

export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string }> };

export async function POST(request: Request, { params }: Context) {
  return productProjectClassificationHandlers.confirm(request, await params);
}
