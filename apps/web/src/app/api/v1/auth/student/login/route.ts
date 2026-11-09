import { createStudentLoginHandler } from "@/server/auth/student";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const POST = createStudentLoginHandler();
