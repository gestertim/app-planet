import { productSpecificationReviewHandlers } from "@/server/product-handlers";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return productSpecificationReviewHandlers.detail(request, await params);
}
