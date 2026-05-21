import "server-only";

export type ServerConfig = {
  databaseUrl?: string;
};

export function getServerConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  return {
    databaseUrl: env.DATABASE_URL
  };
}
