export const dynamic = "force-dynamic";
export function GET() {
  return Response.json(
    { status: "ok", service: "supoclip-lite" },
    { headers: { "Cache-Control": "no-store" } },
  );
}
