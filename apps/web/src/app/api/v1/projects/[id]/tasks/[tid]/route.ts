import { productProjectHandlers } from "../../../../../../../server/product-handlers.ts";

export const dynamic = "force-dynamic";

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string; tid: string }> },
): Promise<Response> {
  const { id, tid } = await params;
  return productProjectHandlers.patchTaskDone(request, { projectId: id, taskId: tid });
}
