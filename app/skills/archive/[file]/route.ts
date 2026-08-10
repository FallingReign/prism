import {
  etagFor,
  immutableHeaders,
  notFoundResponse,
  notModifiedResponse,
  readSkillArtifact,
  readSkillManifest
} from "../../artifacts";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ file: string }> | { file: string } };

export async function GET(request: Request, context: RouteContext): Promise<Response> {
  const loaded = await readSkillManifest();
  if (!loaded) return notFoundResponse();
  const { file } = await context.params;
  if (file !== loaded.manifest.archive.file) return notFoundResponse();
  const body = await readSkillArtifact(file);
  if (!body) return notFoundResponse();
  const headers = immutableHeaders("application/zip", etagFor(body));
  if (request.headers.get("if-none-match") === headers.get("ETag")) return notModifiedResponse(headers);
  return new Response(new Uint8Array(body), { status: 200, headers });
}
