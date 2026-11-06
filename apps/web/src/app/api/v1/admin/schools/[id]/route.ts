import { productSchoolHandlers } from "@/server/product-handlers";

export const dynamic = "force-dynamic";
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  return productSchoolHandlers.detail(request, await context.params);
}
