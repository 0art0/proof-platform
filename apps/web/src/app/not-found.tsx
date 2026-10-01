import { NotFoundView } from "../features/problem-entry";

/** Shown for unknown URLs. */
export default function NotFound() {
  return (
    <NotFoundView
      title="Page not found"
      message="There is nothing at this address. Start again from the home page, where your recent sessions are listed."
    />
  );
}
