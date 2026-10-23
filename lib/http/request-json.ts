/** Read an object-shaped JSON body before route-specific field validation. */
export async function readJsonObject(request: Request): Promise<Record<string, unknown>> {
  const body: unknown = await request.json();
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new TypeError("Request body must be a JSON object.");
  }
  return body as Record<string, unknown>;
}
