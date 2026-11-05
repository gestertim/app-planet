import { productMembershipHandlers } from "@/server/product-handlers";

export const dynamic = "force-dynamic";
export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  return productMembershipHandlers.end(request, await context.params);
}
