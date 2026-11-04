import { productBindingHandlers } from "@/server/product-handlers";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request) { return productBindingHandlers.list(request); }
export async function POST(request: Request) { return productBindingHandlers.create(request); }
