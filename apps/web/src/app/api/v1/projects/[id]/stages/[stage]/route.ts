import { productFoundationHandlers } from "../../../../../../../server/product-handlers.ts";
import { decodeStageParam } from "../../../../../../../server/stage-param.ts";

type RouteContext = {
  params: Promise<{ id: string; stage: string }>;
};

export async function GET(request: Request, { params }: RouteContext): Promise<Response> {
  const { id, stage } = await params;
  return productFoundationHandlers.getStageDraft(request, id, decodeStageParam(stage));
}

export async function PUT(request: Request, { params }: RouteContext): Promise<Response> {
  const { id, stage } = await params;
  return productFoundationHandlers.saveStageDraft(request, id, decodeStageParam(stage));
}
