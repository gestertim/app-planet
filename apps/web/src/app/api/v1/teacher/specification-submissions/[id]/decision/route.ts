import { productSpecificationReviewHandlers } from "@/server/product-handlers";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return productSpecificationReviewHandlers.decide(request, await params);
}
