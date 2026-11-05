import { bindingIntentSchema, bindingReceiptSchema, type BindingIntent, type BindingReceipt } from "@app-planet/core";
import { AdminOperationController, type AdminOperationOptions } from "./admin-operation-controller.ts";

export class BindingOperationController extends AdminOperationController<BindingIntent, BindingReceipt> {
  constructor(options: AdminOperationOptions) {
    super(options, {
      intent: bindingIntentSchema, receipt: bindingReceiptSchema,
      endpoint: (intent) => intent.operation === "create" ? "/api/v1/admin/bindings"
        : `/api/v1/admin/bindings/${encodeURIComponent(intent.target)}`,
      matches: (intent, receipt) => intent.operation !== "end" || receipt.binding_id === intent.target,
      invalidMessage: "請核對教師、學生或有效解除理由。",
      reasons: {
        binding_exists: "這對師生已有有效綁定，沒有新增關係。",
        binding_ended: "指定的舊關聯已解除；沒有解除任何新關聯。",
        teacher_not_eligible: "教師目前不符合資格；須已批准、未停用且未刪除。",
        student_not_approved: "學生目前不符合資格；須已批准、未停用且未刪除。",
        school_not_eligible: "學生學校尚未核准或已失效。",
        teacher_school_mismatch: "教師沒有學生學校的有效持久歸屬。",
        invalid_binding_pair: "不能綁定自己；請核對教師與學生角色。",
        idempotency_key_reuse: "原操作鍵已用於不同內容；本次遭拒，請重新核對關係。",
      },
    });
  }
}
