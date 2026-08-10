import {
  etagFor,
  notModifiedResponse,
  readSkillArtifact,
  revalidatingHeaders,
  unavailableResponse
} from "../artifacts";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const body = await readSkillArtifact("install.md");
  if (!body) return unavailableResponse();
  const headers = revalidatingHeaders("text/plain; charset=utf-8", etagFor(body));
  if (request.headers.get("if-none-match") === headers.get("ETag")) return notModifiedResponse(headers);
  return new Response(body.toString("utf8"), { status: 200, headers });
}
