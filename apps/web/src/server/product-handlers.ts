import { createAuthPrincipalResolver } from "./auth-principal.ts";
import { createFoundationHandlers } from "./foundation-handlers.ts";
import { createProjectHandlers } from "./project-handlers.ts";

const handlers = createFoundationHandlers({
  resolver: createAuthPrincipalResolver(),
  requireSameOrigin: true,
});

export { handlers as productFoundationHandlers };

export const productProjectHandlers = createProjectHandlers({
  resolver: createAuthPrincipalResolver(),
  requireSameOrigin: true,
});
