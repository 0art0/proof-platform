"use client";

import { useEffect, useState } from "react";

/**
 * False during server rendering and the first client render, true once effects have run, i.e. once
 * React has attached its handlers. Interactive controls expose it as `data-hydrated` so browser
 * tests wait for readiness instead of retrying clicks that hydration would swallow.
 */
export function useHydrated(): boolean {
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => setHydrated(true), []);
  return hydrated;
}
