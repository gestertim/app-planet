import { createAuthPrincipalResolver } from "./auth-principal.ts";
import { createFoundationHandlers } from "./foundation-handlers.ts";
import { createProjectHandlers } from "./project-handlers.ts";
import { createProjectClassificationHandlers } from "./project-classification-handlers.ts";
import { createProjectRenameHandlers } from "./project-rename-handlers.ts";
import { createProjectExportHandler } from "./project-export-handlers.ts";
import { createProjectFileHandlers } from "./project-file-handlers.ts";
import { createSpecificationReviewHandlers } from "./specification-review-handlers.ts";
import { createBindingHandlers } from "./admin/accounts-bindings.ts";
import { createTeacherResourceHandlers } from "./teacher-resource-handlers.ts";
import { createTeacherViewAuditHandler } from "./admin/teacher-view-audit.ts";
import { createMembershipHandlers } from "./admin/teacher-school-memberships.ts";
import { createSchoolHandlers } from "./admin/schools.ts";

const handlers = createFoundationHandlers({
  resolver: createAuthPrincipalResolver(),
  requireSameOrigin: true,
});

export { handlers as productFoundationHandlers };

export const productProjectExportHandler = createProjectExportHandler({
  resolver: createAuthPrincipalResolver(),
});

export const productProjectFileHandlers = createProjectFileHandlers({
  resolver: createAuthPrincipalResolver(),
  requireSameOrigin: true,
  log: (event) => console.info(JSON.stringify(event)),
});

export const productProjectHandlers = createProjectHandlers({
  resolver: createAuthPrincipalResolver(),
  requireSameOrigin: true,
});

export const productProjectClassificationHandlers = createProjectClassificationHandlers({
  resolver: createAuthPrincipalResolver(),
  requireSameOrigin: true,
});

export const productProjectRenameHandlers = createProjectRenameHandlers({
  resolver: createAuthPrincipalResolver(),
  requireSameOrigin: true,
});

export const productSpecificationReviewHandlers = createSpecificationReviewHandlers({
  resolver: createAuthPrincipalResolver(),
  requireSameOrigin: true,
});

export const productBindingHandlers = createBindingHandlers({
  resolver: createAuthPrincipalResolver(),
  requireSameOrigin: true,
  log: (event) => console.info(JSON.stringify(event)),
});

export const productTeacherResourceHandlers = createTeacherResourceHandlers({
  resolver: createAuthPrincipalResolver(),
  log: (event) => console.info(JSON.stringify(event)),
});

export const productTeacherViewAuditHandler = createTeacherViewAuditHandler({
  resolver: createAuthPrincipalResolver(),
  log: (event) => console.info(JSON.stringify(event)),
});

export const productMembershipHandlers = createMembershipHandlers({
  resolver: createAuthPrincipalResolver(),
  requireSameOrigin: true,
  log: (event) => console.info(JSON.stringify(event)),
});

export const productSchoolHandlers = createSchoolHandlers({
  resolver: createAuthPrincipalResolver(),
  requireSameOrigin: true,
  log: (event) => console.info(JSON.stringify(event)),
});
