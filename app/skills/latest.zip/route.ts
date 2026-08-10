import {
  etagFor,
  notModifiedResponse,
  readSkillArtifact,
  readSkillManifest,
  revalidatingHeaders,
  unavailableResponse
} from "../artifacts";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const loaded = await readSkillManifest();
  if (!loaded) return unavailableResponse();
  const body = await readSkillArtifact("latest.zip");
  if (!body) return unavailableResponse();
  const headers = revalidatingHeaders("application/zip", etagFor(body));
  if (request.headers.get("if-none-match") === headers.get("ETag")) return notModifiedResponse(headers);
  return new Response(new Uint8Array(body), { status: 200, headers });
}
