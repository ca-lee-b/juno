"use client";

import { useSyncExternalStore } from "react";

const query = "(max-width: 767px)";
function subscribe(callback: () => void) {
  const media = window.matchMedia(query);
  media.addEventListener("change", callback);
  return () => media.removeEventListener("change", callback);
}
function getSnapshot() {
  return window.matchMedia(query).matches;
}
function getServerSnapshot() {
  return false;
}

export function useIsMobile() {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
