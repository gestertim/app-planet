import { productProjectHandlers } from "../../../../../../server/product-handlers.ts";

export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  return productProjectHandlers.importTasks(request, { projectId: id });
}
