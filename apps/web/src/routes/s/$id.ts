import { createFileRoute } from "@tanstack/react-router";

import { apiUrl } from "@/lib/api-url";

// The web Worker cannot fetch the API Worker's route on the same zone, so an
// Orbis Link redirects to the page the Group renders (ADR 0022).
export const Route = createFileRoute("/s/$id")({
  server: {
    handlers: {
      GET: ({ params }) =>
        Response.redirect(
          `${apiUrl()}/share/sets/${encodeURIComponent(params.id)}/page`,
          302
        ),
    },
  },
});
