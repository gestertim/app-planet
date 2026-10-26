import { createAuthPrincipalResolver } from "./auth-principal.ts";
import { createFoundationHandlers } from "./foundation-handlers.ts";

const handlers = createFoundationHandlers({
  resolver: createAuthPrincipalResolver(),
  requireSameOrigin: true,
});

export { handlers as productFoundationHandlers };
