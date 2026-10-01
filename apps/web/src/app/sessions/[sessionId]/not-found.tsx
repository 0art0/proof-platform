import { NotFoundView } from "../../../features/problem-entry";

/** A session ID that is not stored on this server. */
export default function SessionNotFound() {
  return (
    <NotFoundView
      title="Proof not found"
      message="No saved proof has this ID. Check it for typos, or pick one of your recent proofs on the home page."
    />
  );
}
