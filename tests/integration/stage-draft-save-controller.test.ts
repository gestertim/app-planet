import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  confirmOwnedProjectClassificationSubset,
  createOwnedProjectSubset,
  saveOwnedProjectRequirementsSubset,
} from "../../apps/web/src/server/projects.ts";
import {
  readOwnedStageDraftSubset,
  saveOwnedStageDraftSubset,
} from "../../apps/web/src/server/stage-drafts.ts";
import {
  StageDraftSaveController,
  type StageDraftSaveAdapter,
  type StageDraftSaveRequest,
  type StageDraftSaveResponse,
  type StageDraftTarget,
} from "../../apps/web/src/components/project/save-controller.ts";
import {
  inspectConnection,
  localPools,
  syntheticContext,
  syntheticCreationContext,
} from "./authorization-context.ts";

const { control, authorization, parallelAuthorization } = localPools();
const actor = (n: number) => `a8000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const school = (n: number) => `a8100000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const operationKey = () => `a8200000-0000-4000-8000-${String(++sequence).padStart(12, "0")}`;
const projects = new Set<string>();
let sequence = 0;

type AfterCommit = (
  request: StageDraftSaveRequest,
  response: StageDraftSaveResponse,
  callNumber: number,
) => Promise<StageDraftSaveResponse>;

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function target(projectId: string, stage: StageDraftTarget["stage"] = "Specification"): StageDraftTarget {
  return { project_id: projectId, stage };
}

function writeContext(actorNumber = 1) {
  return syntheticCreationContext(authorization, actor(actorNumber));
}

function readContext(actorNumber = 1) {
  return syntheticContext(authorization, actor(actorNumber));
}

function bridge(actorNumber = 1, afterCommit?: AfterCommit) {
  const calls: StageDraftSaveRequest[] = [];
  const adapter: StageDraftSaveAdapter = {
    async save(request) {
      calls.push(request);
      const result = await saveOwnedStageDraftSubset(
        writeContext(actorNumber),
        {
          project_id: request.project_id,
          stage: request.stage,
          expected_row_version: request.expected_row_version,
          content: { text: request.content.text },
        },
        request.idempotency_key,
      );
      const response: StageDraftSaveResponse = {
        target: { project_id: request.project_id, stage: request.stage },
        result,
      };
      return afterCommit ? afterCommit(request, response, calls.length) : response;
    },
  };
  return { adapter, calls };
}

async function createProject(actorNumber = 1) {
  const result = await createOwnedProjectSubset(
    writeContext(actorNumber),
    { title: "synthetic-controller-integration" },
    operationKey(),
  );
  if (result.outcome !== "created") throw new Error("合成控制器專案建立失敗");
  projects.add(result.project.id);
  return result.project.id;
}

async function read(
  projectId: string,
  stage: StageDraftTarget["stage"] = "Specification",
  actorNumber = 1,
) {
  return readOwnedStageDraftSubset(readContext(actorNumber), { project_id: projectId, stage });
}

async function makeController(
  projectId: string,
  options: {
    stage?: StageDraftTarget["stage"];
    actorNumber?: number;
    adapter?: StageDraftSaveAdapter;
  } = {},
) {
  const stage = options.stage ?? "Specification";
  const actorNumber = options.actorNumber ?? 1;
  const initialRead = await read(projectId, stage, actorNumber);
  const initialDraft = initialRead.outcome === "found" ? initialRead.draft : null;
  const saveAdapter = options.adapter ?? bridge(actorNumber).adapter;
  const controller = new StageDraftSaveController({
    adapter: saveAdapter,
    initialTarget: target(projectId, stage),
    initialDraft,
    createOperationKey: operationKey,
  });
  return { controller, initialRead };
}

async function saveDirect(
  projectId: string,
  expectedVersion: number | null,
  text: string,
  actorNumber = 1,
  stage: StageDraftTarget["stage"] = "Specification",
) {
  return saveOwnedStageDraftSubset(
    writeContext(actorNumber),
    {
      project_id: projectId,
      stage,
      expected_row_version: expectedVersion,
      content: { text },
    },
    operationKey(),
  );
}

async function establishClassification(projectId: string) {
  const requirements = await saveOwnedProjectRequirementsSubset(writeContext(), {
    project_id: projectId,
    expected_row_version: 0,
    expected_requirements_revision: 0,
    requirements: {
      description: "synthetic authoritative requirement",
      runtime_needs: "static",
      runtime_ai_required: false,
    },
  }, operationKey());
  if (requirements.outcome !== "saved") throw new Error("合成需求建立失敗");
  const confirmation = await confirmOwnedProjectClassificationSubset(writeContext(), {
    project_id: projectId,
    expected_row_version: 1,
    expected_requirements_revision: 1,
    tier: "A",
    needs_visitor_identity: false,
    requested_tier_acknowledgement: "no_preference",
  }, operationKey());
  if (confirmation.outcome !== "confirmed") throw new Error("合成分類確認建立失敗");
}

async function immutableProjectSnapshot(projectId: string) {
  const result = await control.query(`
    SELECT jsonb_build_object(
      'project', (SELECT to_jsonb(p) FROM app.projects p WHERE id=$1),
      'requirements', (SELECT COALESCE(jsonb_agg(to_jsonb(r) ORDER BY revision), '[]')
        FROM app.project_requirements r WHERE project_id=$1),
      'confirmations', (SELECT COALESCE(jsonb_agg(to_jsonb(c) ORDER BY id), '[]')
        FROM app.project_classification_confirmations c WHERE project_id=$1),
      'classification_keys', (SELECT COALESCE(jsonb_agg(to_jsonb(i) ORDER BY operation_scope,idempotency_key), '[]')
        FROM app.project_classification_idempotency i WHERE project_id=$1)
    ) AS snapshot
  `, [projectId]);
  return result.rows[0].snapshot;
}

async function databaseDraft(projectId: string, stage = "Specification") {
  const result = await control.query(`
    SELECT row_version,content,state,content_source,approved_by,approved_at
    FROM app.stage_records WHERE project_id=$1 AND stage=$2
  `, [projectId, stage]);
  return result.rows;
}

async function poolState() {
  for (const [pool, count] of [[authorization, 1], [parallelAuthorization, 8]] as const) {
    const clients = await Promise.all(Array.from({ length: count }, () => pool.connect()));
    try {
      for (const client of clients) {
        const state = await inspectConnection(client);
        expect(state).toMatchObject({
          actor: "app_authorization_test",
          login: "app_authorization_test",
          sub: null,
          claims: null,
        });
        const activity = await control.query(
          "SELECT state,xact_start FROM pg_stat_activity WHERE pid=$1",
          [state.pid],
        );
        expect(activity.rows).toEqual([{ state: "idle", xact_start: null }]);
      }
    } finally {
      for (const client of clients) client.release();
    }
  }
}

beforeAll(async () => {
  for (const n of [1, 2]) {
    await control.query(`
      INSERT INTO app.schools(id,label,approval_state,approval_epoch,created_at,updated_at)
      VALUES ($1,'synthetic-controller-school','approved',1,now(),now())
    `, [school(n)]);
  }
  for (const n of [1, 2, 3, 4, 5]) {
    await control.query("INSERT INTO auth.users(id) VALUES ($1)", [actor(n)]);
    await control.query(`
      INSERT INTO app.profiles(id,role,status,deletion_state,school_id,display_label,status_changed_at)
      VALUES ($1,$2,'approved','none',$3,'synthetic-controller-actor',now())
    `, [
      actor(n),
      n === 4 ? "teacher" : n === 5 ? "admin" : "student",
      n === 3 ? school(2) : school(1),
    ]);
  }
});

afterEach(async () => {
  const ids = [...projects];
  if (ids.length) {
    await control.query("DELETE FROM app.stage_draft_idempotency WHERE project_id=ANY($1::uuid[])", [ids]);
    await control.query("DELETE FROM app.stage_records WHERE project_id=ANY($1::uuid[])", [ids]);
    await control.query(`UPDATE app.projects SET classification_state='unconfirmed',
      tier=NULL,needs_visitor_identity=NULL,current_confirmation_id=NULL WHERE id=ANY($1::uuid[])`, [ids]);
    for (const table of [
      "project_classification_idempotency",
      "project_classification_confirmations",
      "project_requirements",
      "project_create_idempotency",
    ]) {
      await control.query(`DELETE FROM app.${table} WHERE project_id=ANY($1::uuid[])`, [ids]);
    }
    await control.query("DELETE FROM app.projects WHERE id=ANY($1::uuid[])", [ids]);
    projects.clear();
  }
  await control.query(
    "UPDATE app.profiles SET status='approved',deletion_state='none' WHERE id=ANY($1::uuid[])",
    [[1, 2, 3, 4, 5].map(actor)],
  );
  await control.query(
    "UPDATE app.schools SET approval_state='approved' WHERE id=ANY($1::uuid[])",
    [[school(1), school(2)]],
  );
});

afterAll(async () => {
  try {
    await poolState();
    for (const n of [1, 2, 3, 4, 5]) {
      await control.query("DELETE FROM app.profiles WHERE id=$1", [actor(n)]);
      await control.query("DELETE FROM auth.users WHERE id=$1", [actor(n)]);
    }
    await control.query("DELETE FROM app.schools WHERE id=ANY($1::uuid[])", [[school(1), school(2)]]);
    console.log("controller bridge pool role/claim/transaction clean: 9 sockets");
  } finally {
    await Promise.all([authorization.end(), parallelAuthorization.end(), control.end()]);
  }
});

describe("T054 保存控制器至既有 server／隔離 PostgreSQL", () => {
  it("以應用服務讀回的初始空狀態初始化控制器，首次保存真實建立版本 0", async () => {
    const projectId = await createProject();
    const { controller, initialRead } = await makeController(projectId);
    expect(initialRead).toEqual({ outcome: "not_found" });
    controller.edit(" \t首次保存 🌍 e\u0301\r\n");

    expect(await controller.save()).toEqual({ outcome: "saved" });
    const freshRead = await read(projectId);
    expect(freshRead).toMatchObject({
      outcome: "found",
      draft: {
        project_id: projectId,
        stage: "Specification",
        row_version: 0,
        content: { text: " \t首次保存 🌍 e\u0301\r\n" },
      },
    });
    expect(await databaseDraft(projectId)).toEqual([{
      row_version: 0,
      content: { text: " \t首次保存 🌍 e\u0301\r\n" },
      state: "ai_draft",
      content_source: "student_input",
      approved_by: null,
      approved_at: null,
    }]);
    expect(controller.getState()).toMatchObject({
      confirmedDraft: { row_version: 0 },
      dirty: false,
      operation: { status: "saved" },
    });
  });

  it("以 server 讀回版本更新，且 project、權威需求、分類與確認 evidence 不變", async () => {
    const projectId = await createProject();
    await establishClassification(projectId);
    expect(await saveDirect(projectId, null, "已保存的原始草稿")).toMatchObject({
      outcome: "saved",
      operation: { row_version: 0 },
    });
    const { controller, initialRead } = await makeController(projectId);
    expect(initialRead).toMatchObject({ outcome: "found", draft: { row_version: 0 } });
    const before = await immutableProjectSnapshot(projectId);

    controller.edit("更新內容：保留空白  \r\n與原文");
    expect(await controller.save()).toEqual({ outcome: "saved" });

    expect(await read(projectId)).toMatchObject({
      outcome: "found",
      draft: { row_version: 1, content: { text: "更新內容：保留空白  \r\n與原文" } },
    });
    expect(await immutableProjectSnapshot(projectId)).toEqual(before);
    expect(controller.getState()).toMatchObject({
      confirmedDraft: { row_version: 1 },
      dirty: false,
    });
  });

  it("commit 後 adapter 暫不交付成功回應時，較新記憶體編輯維持 dirty", async () => {
    const projectId = await createProject();
    const committed = deferred<StageDraftSaveResponse>();
    const deliver = deferred<StageDraftSaveResponse>();
    const server = bridge(1, async (_request, response, callNumber) => {
      if (callNumber === 1) {
        committed.resolve(response);
        return deliver.promise;
      }
      return response;
    });
    const { controller } = await makeController(projectId, { adapter: server.adapter });
    controller.edit("已提交快照");
    const pendingSave = controller.save();

    const committedResponse = await committed.promise;
    expect(committedResponse.result).toMatchObject({ outcome: "saved", operation: { row_version: 0 } });
    expect(await databaseDraft(projectId)).toMatchObject([{ row_version: 0, content: { text: "已提交快照" } }]);
    controller.edit("保存中繼續編輯");
    expect(controller.getState()).toMatchObject({
      editorText: "保存中繼續編輯",
      dirty: true,
      operation: { status: "saving" },
    });
    deliver.resolve(committedResponse);

    expect(await pendingSave).toEqual({ outcome: "saved" });
    expect(await read(projectId)).toMatchObject({
      outcome: "found",
      draft: { row_version: 0, content: { text: "已提交快照" } },
    });
    expect(controller.getState()).toMatchObject({
      confirmedDraft: { row_version: 0, content: { text: "已提交快照" } },
      editorText: "保存中繼續編輯",
      dirty: true,
      operation: { status: "saved" },
    });
  });

  it("真實版本衝突保留本地內容及 current／submitted，DB 不被覆寫", async () => {
    const projectId = await createProject();
    expect(await saveDirect(projectId, null, "版本零")).toMatchObject({ outcome: "saved" });
    const { controller } = await makeController(projectId);
    expect(await saveDirect(projectId, 0, "另一個 context 的版本一")).toMatchObject({
      outcome: "saved",
      operation: { row_version: 1 },
    });

    controller.edit("控制器本地提交");
    expect(await controller.save()).toEqual({ outcome: "conflict" });

    expect(await read(projectId)).toMatchObject({
      outcome: "found",
      draft: { row_version: 1, content: { text: "另一個 context 的版本一" } },
    });
    expect(await databaseDraft(projectId)).toMatchObject([
      { row_version: 1, content: { text: "另一個 context 的版本一" } },
    ]);
    expect(controller.getState()).toMatchObject({
      confirmedDraft: { row_version: 1, content: { text: "另一個 context 的版本一" } },
      editorText: "控制器本地提交",
      dirty: true,
      operation: {
        status: "conflict",
        conflict: {
          current: { version: 1, content: { text: "另一個 context 的版本一" } },
          submitted: { version: 0, content: { text: "控制器本地提交" } },
        },
      },
    });
  });

  it("server 已 COMMIT 後遺失回應，以同一 UUID／快照重試走真實冪等 replay", async () => {
    const projectId = await createProject();
    const committed = deferred<StageDraftSaveResponse>();
    const server = bridge(1, async (_request, response, callNumber) => {
      if (callNumber === 1) {
        committed.resolve(response);
        throw new Error("synthetic_response_lost_after_server_commit");
      }
      return response;
    });
    const { controller } = await makeController(projectId, { adapter: server.adapter });
    controller.edit("COMMIT 後回應遺失的原快照");
    const firstAttempt = controller.save();

    const committedResponse = await committed.promise;
    expect(committedResponse.result).toMatchObject({ outcome: "saved", operation: { row_version: 0 } });
    expect(await databaseDraft(projectId)).toMatchObject([
      { row_version: 0, content: { text: "COMMIT 後回應遺失的原快照" } },
    ]);
    expect(await firstAttempt).toEqual({ outcome: "failed", reason: "outcome_unknown" });
    expect(controller.getState()).toMatchObject({
      dirty: true,
      operation: { status: "failed", reason: "outcome_unknown", retryable: true },
    });

    const submittedBeforeRetry = controller.getState().operation;
    expect(await controller.retry()).toEqual({ outcome: "replayed" });
    expect(server.calls).toHaveLength(2);
    expect(server.calls[1]).toEqual(server.calls[0]);
    expect(controller.getState()).toMatchObject({
      confirmedDraft: { row_version: 0, content: { text: "COMMIT 後回應遺失的原快照" } },
      dirty: false,
      operation: { status: "replayed", receipt: { row_version: 0 } },
    });
    expect(await read(projectId)).toMatchObject({
      outcome: "found",
      draft: { row_version: 0, content: { text: "COMMIT 後回應遺失的原快照" } },
    });
    const counts = await control.query(`
      SELECT
        (SELECT count(*)::int FROM app.stage_records WHERE project_id=$1) AS draft_count,
        (SELECT count(*)::int FROM app.stage_draft_idempotency WHERE project_id=$1) AS key_count
    `, [projectId]);
    expect(counts.rows).toEqual([{ draft_count: 1, key_count: 1 }]);
    expect(submittedBeforeRetry).toMatchObject({ status: "failed", submitted: { request: { idempotency_key: server.calls[0].idempotency_key } } });
    console.log("post-COMMIT response-loss/replay evidence", JSON.stringify({
      first_result: committedResponse.result,
      retry_request_same: server.calls[1] === server.calls[0],
      database: counts.rows[0],
      final_version: controller.getState().confirmedDraft?.row_version,
    }));
  });

  it("replay receipt 保留原版本、current 反映較新交易，控制器不回退或丟失本地編輯", async () => {
    const projectId = await createProject();
    const committed = deferred<StageDraftSaveResponse>();
    const server = bridge(1, async (_request, response, callNumber) => {
      if (callNumber === 1) {
        committed.resolve(response);
        throw new Error("synthetic_response_lost_after_server_commit");
      }
      return response;
    });
    const { controller } = await makeController(projectId, { adapter: server.adapter });
    controller.edit("原始 replay receipt");
    const firstAttempt = controller.save();
    const committedResponse = await committed.promise;
    expect(committedResponse.result).toMatchObject({ outcome: "saved", operation: { row_version: 0 } });
    expect(await firstAttempt).toEqual({ outcome: "failed", reason: "outcome_unknown" });

    expect(await saveDirect(projectId, 0, "另一交易的較新 current")).toMatchObject({
      outcome: "saved",
      operation: { row_version: 1 },
    });
    const beforeReplay = await databaseDraft(projectId);
    controller.edit("控制器保留的更新中編輯");

    expect(await controller.retry()).toEqual({ outcome: "replayed" });

    expect(controller.getState()).toMatchObject({
      confirmedDraft: { row_version: 1, content: { text: "另一交易的較新 current" } },
      editorText: "控制器保留的更新中編輯",
      dirty: true,
      operation: {
        status: "replayed",
        receipt: { row_version: 0, content: { text: "原始 replay receipt" } },
        currentDraft: { row_version: 1, content: { text: "另一交易的較新 current" } },
      },
    });
    expect(await databaseDraft(projectId)).toEqual(beforeReplay);
    expect(await read(projectId)).toMatchObject({
      outcome: "found",
      draft: { row_version: 1, content: { text: "另一交易的較新 current" } },
    });
  });

  it.each(["cancel", "replace"] as const)(
    "保存已 COMMIT、回應未交付時%s切換意圖不啟用舊目標",
    async (intent) => {
      const projectId = await createProject();
      const committed = deferred<StageDraftSaveResponse>();
      const deliver = deferred<StageDraftSaveResponse>();
      const server = bridge(1, async (_request, response, callNumber) => {
        if (callNumber === 1) {
          committed.resolve(response);
          return deliver.promise;
        }
        return response;
      });
      const { controller } = await makeController(projectId, { adapter: server.adapter });
      const originalTarget = target(projectId);
      const staleTarget = target(await createProject(), "UX/UI");
      controller.edit("先提交，再取消或取代切換");
      const oldSwitch = controller.requestSwitch(staleTarget, "save_then_switch");

      const committedResponse = await committed.promise;
      expect(committedResponse.result).toMatchObject({ outcome: "saved", operation: { row_version: 0 } });
      expect(await databaseDraft(projectId)).toMatchObject([
        { row_version: 0, content: { text: "先提交，再取消或取代切換" } },
      ]);
      if (intent === "cancel") {
        expect(await controller.requestSwitch(originalTarget, "keep_and_stay")).toEqual({ outcome: "switched" });
      } else {
        expect(await controller.requestSwitch(staleTarget, "discard_and_switch"))
          .toEqual({ outcome: "blocked", reason: "saving" });
      }
      deliver.resolve(committedResponse);

      expect(await oldSwitch).toEqual({ outcome: "superseded" });
      expect(controller.getActiveTarget()).toEqual(originalTarget);
      expect(controller.getState(originalTarget)).toMatchObject({
        confirmedDraft: { row_version: 0 },
        editorText: "先提交，再取消或取代切換",
        dirty: false,
      });
      expect(controller.getState(staleTarget)).toMatchObject({ confirmedDraft: null, editorText: "", dirty: false });
      expect(await read(projectId)).toMatchObject({
        outcome: "found",
        draft: { row_version: 0, content: { text: "先提交，再取消或取代切換" } },
      });
    },
  );

  it.each([2, 3, 4, 5])("同校／跨校其他學生、教師或管理員 %i 沒有控制器保存捷徑", async (actorNumber) => {
    const projectId = await createProject();
    expect(await saveDirect(projectId, null, "僅擁有者可讀寫")).toMatchObject({ outcome: "saved" });
    const { controller, initialRead } = await makeController(projectId, { actorNumber });
    expect(initialRead).toEqual(actorNumber < 4 ? { outcome: "not_found" } : { outcome: "denied", reason: "policy_denied" });
    controller.edit("未授權保存");

    expect(await controller.save()).toEqual({
      outcome: "failed",
      reason: actorNumber < 4 ? "project_not_found" : "policy_denied",
    });
    expect(await read(projectId)).toMatchObject({
      outcome: "found",
      draft: { row_version: 0, content: { text: "僅擁有者可讀寫" } },
    });
    expect(await databaseDraft(projectId)).toMatchObject([
      { row_version: 0, content: { text: "僅擁有者可讀寫" } },
    ]);
  });

  it.each(["disabled", "marked", "unconfirmed"] as const)(
    "保存 COMMIT 後帳號／學校狀態改變，新的保存與原鍵 replay 都重新授權：%s",
    async (condition) => {
      const projectId = await createProject();
      const committed = deferred<StageDraftSaveResponse>();
      const server = bridge(1, async (_request, response, callNumber) => {
        if (callNumber === 1) {
          committed.resolve(response);
          throw new Error("synthetic_response_lost_after_server_commit");
        }
        return response;
      });
      const { controller } = await makeController(projectId, { adapter: server.adapter });
      controller.edit("原操作已提交");
      const firstAttempt = controller.save();
      const committedResponse = await committed.promise;
      expect(committedResponse.result).toMatchObject({ outcome: "saved", operation: { row_version: 0 } });
      expect(await firstAttempt).toEqual({ outcome: "failed", reason: "outcome_unknown" });

      if (condition === "disabled") {
        await control.query("UPDATE app.profiles SET status='disabled' WHERE id=$1", [actor(1)]);
      } else if (condition === "marked") {
        await control.query("UPDATE app.profiles SET deletion_state='marked' WHERE id=$1", [actor(1)]);
      } else {
        await control.query("UPDATE app.schools SET approval_state='unconfirmed' WHERE id=$1", [school(1)]);
      }
      const beforeRetry = await databaseDraft(projectId);

      expect(await controller.retry()).toEqual({ outcome: "failed", reason: "policy_denied" });
      expect(await databaseDraft(projectId)).toEqual(beforeRetry);
      controller.edit("狀態改變後的新保存");
      expect(await controller.save()).toEqual({ outcome: "failed", reason: "policy_denied" });
      expect(await databaseDraft(projectId)).toEqual(beforeRetry);
      console.log("revoked save/replay denial evidence", JSON.stringify({
        condition,
        committed_before_revocation: committedResponse.result.outcome,
        persisted_rows: beforeRetry.length,
        replay_result: controller.getState().operation,
      }));
    },
  );

  it.each(["withdrawn", "expired"] as const)(
    "%s 仍依既有 edit_saved_content 能力允許控制器保存",
    async (schoolState) => {
      const projectId = await createProject();
      await control.query("UPDATE app.schools SET approval_state=$2 WHERE id=$1", [school(1), schoolState]);
      const { controller, initialRead } = await makeController(projectId);
      expect(initialRead).toEqual({ outcome: "not_found" });
      controller.edit(`既有政策 ${schoolState}`);

      expect(await controller.save()).toEqual({ outcome: "saved" });
      expect(await read(projectId)).toMatchObject({
        outcome: "found",
        draft: { row_version: 0, content: { text: `既有政策 ${schoolState}` } },
      });
    },
  );

  it("以同一控制器隔離不同 project／stage 資源，並使用各自版本", async () => {
    const projectA = await createProject();
    const projectB = await createProject();
    const { controller } = await makeController(projectA);
    const stageA = target(projectA);
    const otherStageA = target(projectA, "UX/UI");
    const stageB = target(projectB);

    controller.edit("A Specification");
    expect(await controller.save()).toEqual({ outcome: "saved" });
    controller.edit("A UX/UI", otherStageA);
    expect(await controller.save(otherStageA)).toEqual({ outcome: "saved" });
    controller.edit("B Specification", stageB);
    expect(await controller.save(stageB)).toEqual({ outcome: "saved" });

    expect(await read(projectA, "Specification")).toMatchObject({
      outcome: "found",
      draft: { row_version: 0, content: { text: "A Specification" } },
    });
    expect(await read(projectA, "UX/UI")).toMatchObject({
      outcome: "found",
      draft: { row_version: 0, content: { text: "A UX/UI" } },
    });
    expect(await read(projectB, "Specification")).toMatchObject({
      outcome: "found",
      draft: { row_version: 0, content: { text: "B Specification" } },
    });
    expect(controller.getState(stageA)).toMatchObject({ confirmedDraft: { row_version: 0 }, dirty: false });
    expect(controller.getState(otherStageA)).toMatchObject({ confirmedDraft: { row_version: 0 }, dirty: false });
    expect(controller.getState(stageB)).toMatchObject({ confirmedDraft: { row_version: 0 }, dirty: false });
  });
});
