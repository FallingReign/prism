import {
  etagFor,
  notModifiedResponse,
  readSkillManifest,
  revalidatingHeaders,
  unavailableResponse
} from "../artifacts";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const loaded = await readSkillManifest();
  if (!loaded) return unavailableResponse();
  const headers = revalidatingHeaders("application/json; charset=utf-8", etagFor(loaded.bytes));
  if (request.headers.get("if-none-match") === headers.get("ETag")) return notModifiedResponse(headers);
  return new Response(loaded.bytes.toString("utf8"), { status: 200, headers });
}
