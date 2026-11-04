import {
  teacherResourcePageQuerySchema,
} from "@app-planet/core";
import {
  createRouteHandler,
  jsonResponse,
  problemResponse,
  type RouteOptions,
} from "./http.ts";
import {
  readTeacherProject,
  readTeacherProjectTasks,
  readTeacherStageDraft,
  readTeacherStudentProjects,
  readTeacherStudents,
} from "./teacher-resources.ts";

type HandlerOptions = Pick<RouteOptions, "resolver" | "log">;

function parsePage(request: Request) {
  const search = new URL(request.url).searchParams;
  if ([...search.keys()].some((key) => search.getAll(key).length !== 1)) return null;
  const parsed = teacherResourcePageQuerySchema.safeParse(Object.fromEntries(search));
  return parsed.success ? parsed.data : null;
}

function invalid(context: Parameters<typeof problemResponse>[1]) {
  return problemResponse("invalid_request", context);
}

function sendResult<T>(
  result: { outcome: "found"; value: T } | { outcome: "not_found" | "invalid_input" | "dependency_failure" },
  context: Parameters<typeof problemResponse>[1],
) {
  if (result.outcome === "found") return jsonResponse(200, result.value, context);
  if (result.outcome === "invalid_input") return problemResponse("invalid_request", context);
  if (result.outcome === "dependency_failure") return problemResponse("dependency_unavailable", context);
  return problemResponse("not_found", context);
}

export function createTeacherResourceHandlers(options: HandlerOptions) {
  const students = createRouteHandler(
    { ...options, route: "teacher_students", methods: ["GET"] },
    async ({ request, session, ...context }) => {
      const query = parsePage(request);
      if (!query) return invalid(context);
      return sendResult(await readTeacherStudents(session, query), context);
    },
  );
  const projects = createRouteHandler(
    { ...options, route: "teacher_student_projects", methods: ["GET"] },
    async ({ request, session, routeParams, ...context }) => {
      const query = parsePage(request);
      if (!query) return invalid(context);
      return sendResult(await readTeacherStudentProjects(session, routeParams.studentId ?? "", query), context);
    },
  );
  const project = createRouteHandler(
    { ...options, route: "teacher_project", methods: ["GET"] },
    async ({ request, session, routeParams, ...context }) => {
      if (new URL(request.url).search) return invalid(context);
      return sendResult(await readTeacherProject(
        session, routeParams.studentId ?? "", routeParams.projectId ?? "",
      ), context);
    },
  );
  const stageDraft = createRouteHandler(
    { ...options, route: "teacher_stage_draft", methods: ["GET"] },
    async ({ request, session, routeParams, ...context }) => {
      if (new URL(request.url).search) return invalid(context);
      return sendResult(await readTeacherStageDraft(
        session, routeParams.studentId ?? "", routeParams.projectId ?? "", routeParams.stage ?? "",
      ), context);
    },
  );
  const tasks = createRouteHandler(
    { ...options, route: "teacher_project_tasks", methods: ["GET"] },
    async ({ request, session, routeParams, ...context }) => {
      const query = parsePage(request);
      if (!query) return invalid(context);
      return sendResult(await readTeacherProjectTasks(
        session, routeParams.studentId ?? "", routeParams.projectId ?? "", query,
      ), context);
    },
  );
  return { students, projects, project, stageDraft, tasks };
}
