import { productFoundationHandlers } from "../../../../../../server/product-handlers.ts";

type RouteContext = { params: Promise<{ id: string }> };

export async function POST(request: Request, { params }: RouteContext): Promise<Response> {
  const { id } = await params;
  return productFoundationHandlers.stopAgentRun(request, id);
}
