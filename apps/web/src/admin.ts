const ADMIN_PASSCODE_KEY = "side-admin-passcode";

export function storedAdminPasscode(): string {
  try {
    return window.sessionStorage.getItem(ADMIN_PASSCODE_KEY) ?? "";
  } catch {
    return "";
  }
}

export function storeAdminPasscode(passcode: string): void {
  try {
    if (passcode) window.sessionStorage.setItem(ADMIN_PASSCODE_KEY, passcode);
    else window.sessionStorage.removeItem(ADMIN_PASSCODE_KEY);
  } catch {
    // Browsers that disable session storage can still use the current Backtest page state.
  }
}

export function adminFetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  const passcode = storedAdminPasscode();
  const headers = new Headers(init.headers);
  if (passcode && !headers.has("x-side-admin-passcode")) headers.set("x-side-admin-passcode", passcode);
  return fetch(input, { ...init, headers });
}
