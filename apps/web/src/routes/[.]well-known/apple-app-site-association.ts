import { createFileRoute } from "@tanstack/react-router";

// The system reads this file to open these links in the app (ADR 0022, ADR 0023).
export const Route = createFileRoute("/.well-known/apple-app-site-association")(
  {
    server: {
      handlers: {
        GET: () =>
          Response.json({
            applinks: {
              details: [
                {
                  appIDs: ["JR398S689Z.app.orbis.client"],
                  components: [
                    {
                      "/": "/pair",
                      comment: "An Approval Request opens the approve sheet",
                    },
                    {
                      "/": "/join",
                      comment: "A Join Link opens joining the Group",
                    },
                    {
                      "/": "/s/*",
                      comment: "Orbis Links open the Set in Orbis",
                    },
                  ],
                },
              ],
            },
          }),
      },
    },
  }
);
