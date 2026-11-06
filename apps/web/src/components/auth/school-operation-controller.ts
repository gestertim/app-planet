import { schoolIntentSchema, schoolReceiptSchema, type SchoolIntent, type SchoolReceipt } from "@app-planet/core";
import { AdminOperationController, type AdminOperationOptions } from "./admin-operation-controller.ts";

export class SchoolOperationController extends AdminOperationController<SchoolIntent, SchoolReceipt> {
  constructor(options: AdminOperationOptions) {
    super(options, {
      intent: schoolIntentSchema, receipt: schoolReceiptSchema,
      endpoint: () => "/api/v1/admin/schools",
      matches: (intent, receipt) => intent.body.label === receipt.label,
      invalidMessage: "請輸入非空的學校名稱；這不是學校身分核驗。",
      reasons: { idempotency_key_reuse: "原操作鍵已用於不同名稱；請重新核對，不會自動換鍵。" },
    });
  }
}
