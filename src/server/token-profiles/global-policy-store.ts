import "server-only";

import type { Database } from "../db";
import { insertActivityAuditRecord } from "../audit/postgres-store";
import {
  buildCurrentGlobalTokenProfilePolicy,
  GLOBAL_TOKEN_PROFILE_POLICY_SETTING_KEY,
  parseGlobalTokenProfilePolicy,
  type GlobalTokenProfilePolicy
} from "./global-policy";

export type GlobalTokenProfilePolicySettings = {
  policy: GlobalTokenProfilePolicy;
  version: number;
  updatedByPrismUserId: string | null;
  updatedAt: Date | null;
};

export type GlobalTokenProfilePolicyStore = {
  readGlobalTokenProfilePolicy(): Promise<GlobalTokenProfilePolicySettings>;
  updateGlobalTokenProfilePolicy(input: {
    policy: GlobalTokenProfilePolicy;
    updatedByPrismUserId: string;
    now?: Date;
    audit?: { endpoint: string; requestId: string };
  }): Promise<GlobalTokenProfilePolicySettings>;
};

type PrismSettingRow = {
  value: unknown;
  version: number;
  updated_by_prism_user_id: string | null;
  updated_at: Date | null;
};

export class GlobalTokenProfilePolicyUnavailableError extends Error {
  constructor() {
    super("global_token_profile_policy_unavailable");
    this.name = "GlobalTokenProfilePolicyUnavailableError";
  }
}

export function createPostgresGlobalTokenProfilePolicyStore(database: Database): GlobalTokenProfilePolicyStore {
  return {
    async readGlobalTokenProfilePolicy() {
      const result = await database.query<PrismSettingRow>(
        `select value, version, updated_by_prism_user_id, updated_at
         from prism_settings
         where key = $1
         limit 1`,
        [GLOBAL_TOKEN_PROFILE_POLICY_SETTING_KEY]
      );
      const row = result.rows[0];
      if (!row) {
        return {
          policy: buildCurrentGlobalTokenProfilePolicy(),
          version: 1,
          updatedByPrismUserId: null,
          updatedAt: null
        };
      }
      return toPolicySettings(row);
    },
    async updateGlobalTokenProfilePolicy({ policy, updatedByPrismUserId, now = new Date(), audit }) {
      return database.transaction(async (tx) => {
        const result = await tx.query<PrismSettingRow>(
          `insert into prism_settings (key, value, version, updated_by_prism_user_id, updated_at)
           values ($1, $2::jsonb, 1, $3, $4)
           on conflict (key) do update
             set value = excluded.value,
                 version = prism_settings.version + 1,
                 updated_by_prism_user_id = excluded.updated_by_prism_user_id,
                 updated_at = excluded.updated_at
           returning value, version, updated_by_prism_user_id, updated_at`,
          [GLOBAL_TOKEN_PROFILE_POLICY_SETTING_KEY, JSON.stringify(policy), updatedByPrismUserId, now]
        );
        const row = result.rows[0];
        if (!row) throw new GlobalTokenProfilePolicyUnavailableError();

        if (audit) {
          await insertActivityAuditRecord(tx, {
            prismUserId: updatedByPrismUserId,
            activityType: "global_token_profile_policy_updated",
            endpoint: audit.endpoint,
            actionCategory: "settings",
            objectType: "prism_setting",
            objectId: GLOBAL_TOKEN_PROFILE_POLICY_SETTING_KEY,
            status: "updated",
            httpStatus: 200,
            requestId: audit.requestId,
            upstreamCalled: false
          });
        }

        return toPolicySettings(row);
      });
    }
  };
}

function toPolicySettings(row: PrismSettingRow): GlobalTokenProfilePolicySettings {
  const parsed = parseGlobalTokenProfilePolicy(row.value);
  if (parsed.kind !== "valid") throw new GlobalTokenProfilePolicyUnavailableError();
  return {
    policy: parsed.policy,
    version: row.version,
    updatedByPrismUserId: row.updated_by_prism_user_id,
    updatedAt: row.updated_at
  };
}
