import { randomUUID } from "node:crypto";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { sessionCookieName } from "../../apps/web/src/server/auth-principal.ts";
import {
  createSyntheticAuthAccount,
  deleteSyntheticAuthAccount,
  loginSyntheticAccount,
  openControlPool,
  type SyntheticAuthAccount,
} from "../support/real-auth-fixture.ts";

test.use({ actionTimeout: 15_000 });

test("真 Next HTTPS：學生保存→管理員綁定→教師唯讀→解除拒絕→重綁恢復", async ({ browser }) => {
  test.setTimeout(300_000);
  const control = openControlPool();
  const origin = process.env.APP_PLANET_APP_ORIGIN!;
  const accounts: SyntheticAuthAccount[] = [];
  const projectIds: string[] = [];
  const contexts: BrowserContext[] = [];
  let bindingId: string | null = null;
  try {
    const [studentAccount, teacherAccount, adminAccount, studentB] = await Promise.all([
      createSyntheticAuthAccount(control, "TeacherReadStudent"),
      createSyntheticAuthAccount(control, "TeacherReadTeacher"),
      createSyntheticAuthAccount(control, "TeacherReadAdmin"),
      createSyntheticAuthAccount(control, "TeacherReadStudentB"),
    ]);
    accounts.push(studentAccount, teacherAccount, adminAccount, studentB);
    await control.query("UPDATE app.profiles SET role='teacher' WHERE id=$1", [teacherAccount.id]);
    await control.query("UPDATE app.profiles SET role='admin' WHERE id=$1", [adminAccount.id]);
    await control.query("UPDATE app.profiles SET school_id=$2 WHERE id=$1", [teacherAccount.id, studentAccount.schoolId]);
    const membership = randomUUID();
    await control.query(`INSERT INTO app.teacher_school_memberships
      (id,teacher_id,school_id,state,created_by_aid,created_at)
      VALUES($1,$2,$3,'active',$4,clock_timestamp())`,
    [membership, teacherAccount.id, studentAccount.schoolId, randomUUID()]);

    const [studentContext, studentBContext, teacherContext, adminContext] = await Promise.all(
      accounts.map(() => browser.newContext({ locale: "zh-TW", ignoreHTTPSErrors: true })),
    );
    contexts.push(studentContext, studentBContext, teacherContext, adminContext);
    const [student, studentBPage, teacher, admin] = await Promise.all(contexts.map((context) => context.newPage()));
    const addSession = async (context: BrowserContext, account: SyntheticAuthAccount) => {
      const session = await loginSyntheticAccount(account);
      await context.addCookies([{
        name: sessionCookieName, value: session.accessToken, url: origin,
        secure: true, httpOnly: true, sameSite: "Strict",
      }]);
    };
    const waitResponse = (page: Page, path: string, method: string) => page.waitForResponse((response) =>
      new URL(response.url()).pathname === path && response.request().method() === method);
    const loginStaff = async (page: Page, account: SyntheticAuthAccount, role: "admin" | "teacher") => {
      await page.goto(`${origin}/login`);
      await expect(page.locator('form[data-ready="true"]')).toHaveCount(1);
      await page.getByLabel("電子郵件").fill(account.email);
      await page.getByLabel("密碼").fill(account.password);
      const response = waitResponse(page, "/api/v1/auth/staff/login", "POST");
      await page.getByRole("button", { name: "登入", exact: true }).press("Enter");
      expect((await response).status()).toBe(200);
      await expect(page).toHaveURL(`${origin}/${role}`);
    };
    const createStudentProject = async (page: Page, title: string) => {
      await page.goto(`${origin}/student`);
      await page.getByLabel("專案名稱").fill(title);
      const created = waitResponse(page, "/api/v1/projects", "POST");
      await page.getByRole("button", { name: "建立專案", exact: true }).click();
      const result = await created;
      expect(result.status()).toBe(201);
      const body = await result.json();
      projectIds.push(body.id as string);
      return body.id as string;
    };
    const selectBindingPair = async () => {
      const region = admin.getByRole("region", { name: "師生綁定管理", exact: true });
      await expect(region.getByLabel("合格教師與學校")).toBeEnabled();
      await region.getByLabel("合格教師與學校").selectOption(membership);
      await region.getByLabel("合格學生").selectOption(studentAccount.id);
      await expect(region.getByRole("button", { name: "核對並建立綁定", exact: true })).toBeEnabled();
    };
    const createBindingFromUI = async () => {
      const region = admin.getByRole("region", { name: "師生綁定管理", exact: true });
      await selectBindingPair();
      const sent = waitResponse(admin, "/api/v1/admin/bindings", "POST");
      await region.getByRole("button", { name: "核對並建立綁定", exact: true }).press("Enter");
      await expect(admin.getByRole("dialog")).toBeVisible();
      await admin.getByRole("dialog").getByRole("button", {
        name: "明確確認並送出建立", exact: true,
      }).press("Enter");
      const response = await sent;
      expect(response.status()).toBe(201);
      return (await response.json()).binding_id as string;
    };

    await Promise.all([
      addSession(studentContext, studentAccount),
      addSession(studentBContext, studentB),
    ]);
    const project = await createStudentProject(student, "教師唯讀垂直驗收");
    const bProject = await createStudentProject(studentBPage, "其他學生的私有專案");

    await student.goto(`${origin}/student/projects/${project}/stages/A%2FB`);
    await student.getByLabel("正式需求說明").fill("教師唯讀查看保存版本與 Unicode café");
    const requirements = waitResponse(student, `/api/v1/projects/${project}/requirements`, "PUT");
    await student.getByRole("button", { name: "保存正式需求", exact: true }).click();
    expect((await requirements).status()).toBe(200);
    await student.getByLabel("正式 A/B 分類", { exact: true }).selectOption("A");
    await student.getByLabel("需要識別訪客身分嗎", { exact: true }).selectOption("false");
    const classification = waitResponse(student,
      `/api/v1/projects/${project}/classification/confirmation`, "POST");
    await student.getByRole("button", { name: "明確確認正式分類", exact: true }).click();
    expect((await classification).status()).toBe(200);

    await student.goto(`${origin}/student/projects/${project}/stages/Specification`);
    await student.getByLabel("階段草稿文字").fill("學生保存的 Specification 草稿 café");
    const draft = waitResponse(student, `/api/v1/projects/${project}/stages/Specification`, "PUT");
    await student.getByRole("button", { name: "保存", exact: true }).click();
    expect((await draft).status()).toBe(201);
    const confirmation = student.getByTestId("confirm-saved-version");
    await expect(confirmation).toBeEnabled();
    const confirmed = waitResponse(student,
      `/api/v1/projects/${project}/stages/Specification/confirmation`, "POST");
    await confirmation.press("Enter");
    expect((await confirmed).status()).toBe(201);

    await student.goto(`${origin}/student/projects/${project}/plan`);
    await student.getByLabel(/任務清單（每行一項/).fill("確認資料使用保存版本");
    await student.getByRole("button", { name: "預覽任務清單", exact: true }).click();
    const imported = waitResponse(student, `/api/v1/projects/${project}/tasks`, "POST");
    await student.getByRole("button", { name: "確認並建立任務清單", exact: true }).click();
    const importedResponse = await imported;
    expect(importedResponse.status()).toBe(201);
    const taskId = (await importedResponse.json()).tasks[0].id as string;
    const task = student.getByRole("checkbox", { name: "完成任務：確認資料使用保存版本" });
    await expect(task).toBeVisible();
    const taskSaved = waitResponse(student, `/api/v1/projects/${project}/tasks/${taskId}`, "PATCH");
    await task.check();
    expect((await taskSaved).status()).toBe(200);

    await loginStaff(admin, adminAccount, "admin");
    await admin.getByRole("link", { name: "師生綁定", exact: true }).click();
    await expect(admin).toHaveURL(`${origin}/admin/bindings`);
    bindingId = await createBindingFromUI();
    await student.goto(`${origin}/student`);
    await expect(student.getByTestId("teacher-relationship-notice"))
      .toContainText("合成帳號TeacherReadTeacher");
    await expect(student.getByTestId("teacher-relationship-notice"))
      .toContainText("不含對話、附件或學習活動");
    await loginStaff(teacher, teacherAccount, "teacher");
    const studentsUrl = `${origin}/api/v1/teacher/students`;
    const roster = await teacher.request.get(studentsUrl);
    expect(roster.status()).toBe(200);
    expect(await roster.json()).toMatchObject({
      items: [{ id: studentAccount.id, display_label: `學生-${studentAccount.id.slice(0, 8)}` }],
    });
    await teacher.goto(`${origin}/teacher`);
    await teacher.getByRole("link", { name: `學生-${studentAccount.id.slice(0, 8)} 的專案` }).click();
    await teacher.getByRole("link", { name: /教師唯讀垂直驗收/ }).click();
    await expect(teacher.getByText("教師唯讀查看保存版本與 Unicode café")).toBeVisible();
    await expect(teacher.getByText("學生確認只證明確認某個保存版本，不是教師批准。")).toBeVisible();
    await expect(teacher.getByText("Specification 人工審查：尚無提交")).toBeVisible();
    await expect(teacher.getByText("已勾選：確認資料使用保存版本")).toBeVisible();
    await teacher.getByRole("region", { name: "九階段保存與學生確認摘要" })
      .getByRole("link", { name: /Specification.*學生已確認目前保存版本/ }).click();
    await expect(teacher.getByText("學生保存的 Specification 草稿 café")).toBeVisible();

    const crossStudent = await teacher.request.get(
      `${origin}/api/v1/teacher/students/${studentB.id}/projects/${bProject}`,
    );
    expect(crossStudent.status()).toBe(404);
    expect(await crossStudent.text()).not.toContain("其他學生的私有專案");

    await admin.goto(`${origin}/admin/bindings`);
    const bindingRegion = admin.getByRole("region", { name: "師生綁定管理", exact: true });
    const existing = bindingRegion.getByLabel("既有綁定");
    await existing.selectOption(bindingId);
    await bindingRegion.getByLabel("解除理由").fill("教師唯讀垂直驗收完成後解除");
    const ended = waitResponse(admin, `/api/v1/admin/bindings/${bindingId}`, "DELETE");
    await bindingRegion.getByRole("button", { name: "核對並解除綁定", exact: true }).press("Enter");
    await expect(admin.getByRole("dialog")).toBeVisible();
    await admin.getByRole("dialog").getByRole("button", {
      name: "明確確認並送出解除", exact: true,
    }).press("Enter");
    expect((await ended).status()).toBe(200);
    const revoked = await teacher.request.get(
      `${origin}/api/v1/teacher/students/${studentAccount.id}/projects/${project}`,
    );
    expect(revoked.status()).toBe(404);
    expect(await revoked.text()).not.toContain("學生保存的 Specification 草稿 café");
    await teacher.goto(`${origin}/teacher/students/${studentAccount.id}/projects/${project}`);
    await expect(teacher.getByText("學生保存的 Specification 草稿 café")).toHaveCount(0);

    await admin.goto(`${origin}/admin/bindings`);
    const rebound = await createBindingFromUI();
    expect(rebound).not.toBe(bindingId);
    const afterRebind = await teacher.request.get(
      `${origin}/api/v1/teacher/students/${studentAccount.id}/projects/${project}`,
    );
    expect(afterRebind.status()).toBe(200);
    expect(await afterRebind.text()).toContain("教師唯讀垂直驗收");

    const state = await control.query(`SELECT p.requirements_revision,p.stage,d.row_version,d.content,
      c.record_row_version,t.done
      FROM app.projects p
      JOIN app.stage_records d ON d.project_id=p.id AND d.stage='Specification'
      JOIN app.stage_draft_confirmations c ON c.project_id=d.project_id AND c.stage=d.stage
      JOIN app.tasks t ON t.project_id=p.id
      WHERE p.id=$1`, [project]);
    expect(state.rows).toHaveLength(1);
    expect(state.rows[0]).toMatchObject({
      requirements_revision: 1,
      row_version: 0,
      content: { text: "學生保存的 Specification 草稿 café" },
      record_row_version: 0,
      done: true,
    });
    const views = await control.query(`SELECT count(*)::int AS count
      FROM app.audit_events e JOIN app.audit_identity_map actor ON actor.aid=e.actor_aid
      JOIN app.audit_identity_map subject ON subject.aid=e.subject_aid
      WHERE e.action='teacher_view' AND e.object_type='project' AND e.object_ref=$1
        AND actor.account_id=$2 AND subject.account_id=$3 AND e.meta='{}'::jsonb`,
    [project, teacherAccount.id, studentAccount.id]);
    expect(views.rows[0].count).toBeGreaterThanOrEqual(4);
    console.log("TeacherResourcesHTTPS=student_UI_save;admin_UI_bind_end_rebind;teacher_UI_read;cross_student_404;audit_verified");
  } finally {
    for (const context of contexts) await context.close();
    await control.query("DELETE FROM app.binding_operation_receipts WHERE actor_id=ANY($1::uuid[])",
      [accounts.map((account) => account.id)]);
    if (projectIds.length) {
      await control.query(`UPDATE app.projects SET classification_state='unconfirmed',tier=NULL,
        needs_visitor_identity=NULL,current_confirmation_id=NULL WHERE id=ANY($1::uuid[])`, [projectIds]);
      for (const table of ["stage_draft_confirmations", "stage_draft_idempotency", "project_task_imports", "tasks",
        "stage_records", "project_classification_idempotency", "project_classification_confirmations",
        "project_requirements", "project_create_idempotency"]) {
        await control.query(`DELETE FROM app.${table} WHERE project_id=ANY($1::uuid[])`, [projectIds]);
      }
      await control.query("DELETE FROM app.projects WHERE id=ANY($1::uuid[])", [projectIds]);
    }
    const ids = accounts.map((account) => account.id);
    await control.query("DELETE FROM app.teacher_student_bindings WHERE teacher_id=ANY($1::uuid[]) OR student_id=ANY($1::uuid[])", [ids]);
    await control.query("DELETE FROM app.teacher_school_memberships WHERE teacher_id=ANY($1::uuid[])", [ids]);
    await control.query(`DELETE FROM app.audit_events WHERE actor_aid IN
      (SELECT aid FROM app.audit_identity_map WHERE account_id=ANY($1::uuid[])) OR subject_aid IN
      (SELECT aid FROM app.audit_identity_map WHERE account_id=ANY($1::uuid[]))`, [ids]);
    await control.query("DELETE FROM app.audit_identity_map WHERE account_id=ANY($1::uuid[])", [ids]);
    await control.query("DELETE FROM app.profiles WHERE id=ANY($1::uuid[])", [ids]);
    await control.query("DELETE FROM app.schools WHERE id=ANY($1::uuid[])", [accounts.map((account) => account.schoolId)]);
    for (const account of accounts) await deleteSyntheticAuthAccount(account);
    await control.end();
  }
});
