import { productMembershipHandlers } from "@/server/product-handlers";

export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  return productMembershipHandlers.list(request);
}
export async function POST(request: Request) {
  return productMembershipHandlers.create(request);
}
