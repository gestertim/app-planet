import { productTeacherResourceHandlers } from "@/server/product-handlers";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request) { return productTeacherResourceHandlers.students(request); }
