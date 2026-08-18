import { isIP } from "node:net";

const stripIpv6Brackets = (hostname: string) =>
  hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;

export const isSafeHttpsUrl = (value: unknown): value is string => {
  if (typeof value !== "string") {
    return false;
  }

  try {
    const url = new URL(value);
    const hostname = stripIpv6Brackets(url.hostname).toLowerCase();

    return (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      hostname.length > 0 &&
      hostname !== "localhost" &&
      !hostname.endsWith(".localhost") &&
      isIP(hostname) === 0
    );
  } catch {
    return false;
  }
};
