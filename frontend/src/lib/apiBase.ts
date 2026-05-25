const RAW_API_BASE = import.meta.env.VITE_API_BASE_URL || import.meta.env.VITE_API_BASE || "/api";

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function normalizeApiBase(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "/api";

  if (/^https?:\/\//i.test(trimmed)) {
    const url = new URL(trimmed);
    if (url.pathname === "/" || url.pathname === "") {
      url.pathname = "/api";
    }
    return stripTrailingSlash(url.toString());
  }

  return stripTrailingSlash(trimmed) || "/api";
}

export const RAW_API_BASE_URL = String(RAW_API_BASE);
export const API_BASE_URL = normalizeApiBase(RAW_API_BASE_URL);

export function apiUrl(path: string): string {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return `${API_BASE_URL}${normalizedPath}`;
}

export function displayRequestUrl(url: string): string {
  if (/^[a-z][a-z\d+\-.]*:\/\//i.test(url)) return url;
  if (typeof window === "undefined") return url;
  return new URL(url, window.location.href).href;
}
