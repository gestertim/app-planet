import { productSpecificationReviewHandlers } from "@/server/product-handlers";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string }> };
export async function GET(request: Request, { params }: Context) {
  return productSpecificationReviewHandlers.read(request, await params);
}
export async function POST(request: Request, { params }: Context) {
  return productSpecificationReviewHandlers.submit(request, await params);
}
