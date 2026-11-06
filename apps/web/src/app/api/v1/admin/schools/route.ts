import { productSchoolHandlers } from "@/server/product-handlers";

export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  return productSchoolHandlers.list(request);
}
export async function POST(request: Request) {
  return productSchoolHandlers.create(request);
}
