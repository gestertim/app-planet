import { membershipIntentSchema, membershipReceiptSchema, type MembershipIntent, type MembershipReceipt } from "@app-planet/core";
import { AdminOperationController, type AdminOperationOptions } from "./admin-operation-controller.ts";

export class MembershipOperationController extends AdminOperationController<MembershipIntent, MembershipReceipt> {
  constructor(options: AdminOperationOptions) {
    super(options, {
      intent: membershipIntentSchema, receipt: membershipReceiptSchema,
      endpoint: (intent) => intent.operation === "create" ? "/api/v1/admin/teacher-school-memberships"
        : `/api/v1/admin/teacher-school-memberships/${encodeURIComponent(intent.target)}`,
      matches: (intent, receipt) => intent.operation === "end" ? receipt.membership_id === intent.target
        : receipt.teacher_id === intent.body.teacher_id && receipt.school_id === intent.body.school_id,
      invalidMessage: "請核對既有教師、學校與指定歸屬。",
      reasons: {
        membership_exists: "這位教師已有該校有效歸屬，沒有新增關係。",
        membership_ended: "指定的舊歸屬已結束；沒有結束任何新歸屬。",
        teacher_not_eligible: "教師目前不符合資格；須已批准、未停用且未刪除。",
        membership_school_not_supported: "本輪目前不支援新增至未確認、撤回或到期學校；只開放已核准且未到期的既有學校。",
        idempotency_key_reuse: "原操作鍵已用於不同原意圖；請重新核對，不會自動換鍵。",
      },
    });
  }
}
