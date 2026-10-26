import { Outlet, createFileRoute } from "@tanstack/react-router";

// These pages read the key and the address bar, which live only in the browser,
// so they never render on the Worker. Child routes inherit `ssr: false`.
export const Route = createFileRoute("/_browser")({
  component: Outlet,
  ssr: false,
});
