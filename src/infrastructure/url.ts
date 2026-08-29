import { InfrastructureError } from "./errors";

const DOMAIN_LABEL_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;
const IPV4_PATTERN = /^\d+(?:\.\d+){3}$/u;

export function isPublicHostname(hostname: string): boolean {
  if (
    !hostname ||
    hostname.length > 253 ||
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal") ||
    hostname.includes(":") ||
    IPV4_PATTERN.test(hostname)
  ) {
    return false;
  }

  const labels = hostname.split(".");
  return (
    labels.length >= 2 &&
    labels.every((label) => DOMAIN_LABEL_PATTERN.test(label))
  );
}

export function safeHttpsUrl(input: string | URL, base?: URL): URL {
  let url: URL;
  try {
    url =
      input instanceof URL ? new URL(input.toString()) : new URL(input, base);
  } catch (cause) {
    throw new InfrastructureError(
      "UNSAFE_URL",
      "The provider URL is invalid.",
      { cause },
    );
  }

  const hostname = url.hostname.toLowerCase();
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    (url.port !== "" && url.port !== "443") ||
    url.hash !== "" ||
    !isPublicHostname(hostname)
  ) {
    throw new InfrastructureError(
      "UNSAFE_URL",
      "Only public HTTPS provider URLs on the standard port are allowed.",
    );
  }

  url.hostname = hostname;
  return url;
}
