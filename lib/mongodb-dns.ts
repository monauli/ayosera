import dns from "dns";

const uri = process.env.MONGODB_URI || "mongodb://127.0.0.1:27017";

function parseDnsServers(value: string | undefined) {
  return (
    value
      ?.split(",")
      .map((server) => server.trim())
      .filter(Boolean) ?? []
  );
}

function isLoopbackDnsServer(server: string) {
  return server === "localhost" || server.startsWith("127.") || server === "::1";
}

function configureMongoSrvDns() {
  if (!uri.startsWith("mongodb+srv://")) return;

  const configuredServers = parseDnsServers(process.env.MONGODB_DNS_SERVERS);
  const currentServers = dns.getServers();
  const shouldUseDevFallback =
    process.env.NODE_ENV !== "production" &&
    currentServers.length > 0 &&
    currentServers.every(isLoopbackDnsServer);

  const servers = configuredServers.length
    ? configuredServers
    : shouldUseDevFallback
      ? ["8.8.8.8", "1.1.1.1"]
      : [];

  if (servers.length) {
    dns.setServers(servers);
  }

  if (process.env.MONGODB_DEBUG_DNS === "1") {
    console.info("MongoDB DNS servers", {
      before: currentServers,
      configured: configuredServers,
      after: dns.getServers(),
    });
  }
}

configureMongoSrvDns();
