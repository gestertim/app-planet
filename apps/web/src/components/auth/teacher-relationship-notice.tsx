"use client";

import { z } from "zod";
import { useEffect, useRef, useState } from "react";
import { relationshipRefreshEvent } from "./product-fetch.ts";

const view = z.object({
  role: z.literal("student"), account_status: z.literal("approved"),
  teacher_notice: z.object({ teachers: z.array(z.object({ display_label: z.string().max(200) })),
    scope: z.array(z.string()) }).optional(),
});
export function TeacherRelationshipNotice() {
  const [message, setMessage] = useState("正在讀取目前教師關係。");
  const generation = useRef(0);
  useEffect(() => {
    let active = true;
    const refresh = async () => {
      const token = ++generation.current;
      setMessage("正在重新確認教師關係；先前提示暫時隱藏。");
      try {
        const response = await fetch("/api/v1/me", {
          cache: "no-store", credentials: "same-origin", signal: AbortSignal.timeout(10_000),
        });
        if (!response.ok) throw new Error("relationship_unavailable");
        const parsed = view.safeParse(await response.json());
        if (!parsed.success) throw new Error("relationship_unavailable");
        if (!active || token !== generation.current) return;
        const teachers = parsed.data.teacher_notice?.teachers ?? [];
        setMessage(teachers.length
          ? `本次可信讀取的全部有效教師關係（共 ${teachers.length} 位）：${teachers.map((t) => t.display_label).join("、")}。本輪教師可唯讀查看已保存的專案需求、階段草稿、學生確認狀態與任務；不含對話、附件或學習活動，也不表示任何階段已批准。`
          : "本次可信讀取：目前沒有符合資格的教師關係。");
      } catch {
        if (active && token === generation.current) setMessage("目前無法確認教師關係；不沿用先前提示，請稍後再試。");
      }
    };
    const notify = () => { void refresh(); };
    window.addEventListener(relationshipRefreshEvent, notify);
    void refresh();
    return () => { active = false; ++generation.current; window.removeEventListener(relationshipRefreshEvent, notify); };
  }, []);
  return <section className="card" aria-label="目前教師關係提示">
    <h2>教師關係提示</h2><p role="status" data-testid="teacher-relationship-notice">{message}</p>
    <p>提示只描述最後一次可信讀取；下一次產品請求會再次查詢，不是持續即時推播，也不授予完整資源存取。</p>
  </section>;
}
