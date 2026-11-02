import { productProjectHandlers } from "../../../../../../../../server/product-handlers.ts";
import { decodeStageParam } from "../../../../../../../../server/stage-param.ts";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string; stage: string }> };

export async function GET(request: Request, { params }: RouteContext): Promise<Response> {
  const { id, stage } = await params;
  return productProjectHandlers.readStageConfirmation(request, { projectId: id, stage: decodeStageParam(stage) });
}

export async function POST(request: Request, { params }: RouteContext): Promise<Response> {
  const { id, stage } = await params;
  return productProjectHandlers.confirmStage(request, { projectId: id, stage: decodeStageParam(stage) });
}
