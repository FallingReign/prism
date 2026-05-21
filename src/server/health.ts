export type HealthStatus = {
  service: "ok";
  database: "ok" | "unavailable";
};

export type DatabaseProbe = {
  query: (sql: string) => Promise<unknown>;
};

export async function checkHealth(database: DatabaseProbe): Promise<HealthStatus> {
  try {
    await database.query("select 1");
  } catch {
    return {
      service: "ok",
      database: "unavailable"
    };
  }

  return {
    service: "ok",
    database: "ok"
  };
}
