import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { createSyntheticAuthAccount, deleteSyntheticAuthAccount } from "./real-auth-fixture.ts";

export async function createReviewActors(control: Pool) {
  const student = await createSyntheticAuthAccount(control, "ReviewStudent");
  const otherStudent = await createSyntheticAuthAccount(control, "ReviewOtherStudent");
  const teacher = await createSyntheticAuthAccount(control, "ReviewTeacher");
  const outsider = await createSyntheticAuthAccount(control, "ReviewOtherTeacher");
  const admin = await createSyntheticAuthAccount(control, "ReviewAdmin");
  await control.query("UPDATE app.profiles SET role='teacher' WHERE id=ANY($1::uuid[])", [[teacher.id, outsider.id]]);
  await control.query("UPDATE app.profiles SET role='admin' WHERE id=$1", [admin.id]);
  const binding = randomUUID(), membership = randomUUID();
  await control.query(`INSERT INTO app.teacher_student_bindings(id,teacher_id,student_id,state,created_by_aid,created_at)
    VALUES($1,$2,$3,'active',$4,now())`, [binding, teacher.id, student.id, randomUUID()]);
  await control.query(`INSERT INTO app.teacher_school_memberships(id,teacher_id,school_id,state,created_by_aid,created_at)
    VALUES($1,$2,$3,'active',$4,now())`, [membership, teacher.id, student.schoolId, randomUUID()]);
  await control.query(`INSERT INTO app.teacher_student_bindings(id,teacher_id,student_id,state,created_by_aid,created_at)
    VALUES($1,$2,$3,'active',$4,now())`, [randomUUID(), teacher.id, otherStudent.id, randomUUID()]);
  await control.query(`INSERT INTO app.teacher_school_memberships(id,teacher_id,school_id,state,created_by_aid,created_at)
    VALUES($1,$2,$3,'active',$4,now())`, [randomUUID(), teacher.id, otherStudent.schoolId, randomUUID()]);
  return { student, otherStudent, teacher, outsider, admin, binding, membership };
}
export async function cleanupReviewActors(control: Pool, actors: Awaited<ReturnType<typeof createReviewActors>>) {
  const accounts = [actors.student, actors.otherStudent, actors.teacher, actors.outsider, actors.admin];
  const ids = accounts.map((account) => account.id);
  await control.query(`DELETE FROM app.specification_decisions WHERE submission_id IN
    (SELECT id FROM app.specification_submissions WHERE student_id=ANY($1::uuid[]))`, [ids]);
  await control.query("DELETE FROM app.specification_submissions WHERE student_id=ANY($1::uuid[])", [ids]);
  await control.query(`UPDATE app.projects SET classification_state='unconfirmed',tier=NULL,
    needs_visitor_identity=NULL,current_confirmation_id=NULL WHERE owner_id=ANY($1::uuid[])`, [ids]);
  for (const table of ["stage_draft_confirmations", "stage_draft_idempotency", "stage_records",
    "project_classification_idempotency", "project_classification_confirmations", "project_requirements", "project_create_idempotency"]) {
    await control.query(`DELETE FROM app.${table} WHERE project_id IN (SELECT id FROM app.projects WHERE owner_id=ANY($1::uuid[]))`, [ids]);
  }
  await control.query("DELETE FROM app.projects WHERE owner_id=ANY($1::uuid[])", [ids]);
  await control.query("DELETE FROM app.teacher_student_bindings WHERE teacher_id=ANY($1::uuid[]) OR student_id=ANY($1::uuid[])", [ids]);
  await control.query("DELETE FROM app.teacher_school_memberships WHERE teacher_id=ANY($1::uuid[])", [ids]);
  await control.query(`DELETE FROM app.audit_events WHERE actor_aid IN
    (SELECT aid FROM app.audit_identity_map WHERE account_id=ANY($1::uuid[]))`, [ids]);
  await control.query("DELETE FROM app.audit_identity_map WHERE account_id=ANY($1::uuid[])", [ids]);
  await control.query("DELETE FROM app.profiles WHERE id=ANY($1::uuid[])", [ids]);
  await control.query("DELETE FROM app.schools WHERE id=ANY($1::uuid[])", [accounts.map((account) => account.schoolId)]);
  for (const account of accounts) await deleteSyntheticAuthAccount(account);
}
