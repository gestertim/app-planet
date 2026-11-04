import { createAuthPrincipalResolver } from "./auth-principal.ts";
import { createFoundationHandlers } from "./foundation-handlers.ts";
import { createProjectHandlers } from "./project-handlers.ts";
import { createProjectClassificationHandlers } from "./project-classification-handlers.ts";
import { createSpecificationReviewHandlers } from "./specification-review-handlers.ts";
import { createBindingHandlers } from "./admin/accounts-bindings.ts";
import { createTeacherResourceHandlers } from "./teacher-resource-handlers.ts";

const handlers = createFoundationHandlers({
  resolver: createAuthPrincipalResolver(),
  requireSameOrigin: true,
});

export { handlers as productFoundationHandlers };

export const productProjectHandlers = createProjectHandlers({
  resolver: createAuthPrincipalResolver(),
  requireSameOrigin: true,
});

export const productProjectClassificationHandlers = createProjectClassificationHandlers({
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
