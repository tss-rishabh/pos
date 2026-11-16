export function isDesktopRuntime(): boolean {
  return /\bElectron\/\d+(?:\.\d+){1,2}\b/.test(navigator.userAgent);
}
