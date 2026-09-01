import "server-only";

import { NextResponse } from "next/server";

export function localAppJsonResponse(body: object, status = 200, requestId?: string): NextResponse {
  return secureLocalAppResponse(NextResponse.json(body, { status }), requestId);
}

export function localAppRedirect(location: string, status: 302 | 303 = 302, requestId?: string): NextResponse {
  return secureLocalAppResponse(NextResponse.redirect(location, { status }), requestId);
}

export function localAppHtmlResponse(html: string, status = 200, requestId?: string): NextResponse {
  const response = new NextResponse(html, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8" }
  });
  response.headers.set(
    "Content-Security-Policy",
    "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'"
  );
  response.headers.set("X-Content-Type-Options", "nosniff");
  const secured = secureLocalAppResponse(response, requestId);
  secured.headers.set("Referrer-Policy", "strict-origin");
  return secured;
}

export function secureLocalAppResponse(response: NextResponse, requestId?: string): NextResponse {
  response.headers.set("Cache-Control", "no-store");
  response.headers.set("Pragma", "no-cache");
  response.headers.set("Referrer-Policy", "no-referrer");
  response.headers.set("X-Frame-Options", "DENY");
  if (requestId) response.headers.set("X-Prism-Request-ID", requestId);
  if (!response.headers.has("Content-Security-Policy")) {
    response.headers.set("Content-Security-Policy", "frame-ancestors 'none'; base-uri 'none'");
  }
  return response;
}

export async function readBoundedUtf8Body(request: Request, maximumBytes: number): Promise<string | null> {
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      total += chunk.value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel();
        return null;
      }
      chunks.push(chunk.value);
    }
    const combined = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      combined.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(combined);
  } catch {
    return null;
  }
}
