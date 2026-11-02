import { productProjectHandlers } from "../../../../../server/product-handlers.ts";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  return productProjectHandlers.recover(request);
}
