import { describe, expect, it } from "vitest";

import packageJson from "../../package.json";

const forbiddenDependencyPatterns = [/supabase/i, /postgrest/i, /postgrest-js/i];

describe("Prism substrate dependencies", () => {
  it("does not introduce Supabase/Auth/PostgREST dependencies", () => {
    const dependencyNames = Object.keys({
      ...packageJson.dependencies,
      ...packageJson.devDependencies
    });

    expect(dependencyNames.filter((name) => forbiddenDependencyPatterns.some((pattern) => pattern.test(name)))).toEqual([]);
  });
});
