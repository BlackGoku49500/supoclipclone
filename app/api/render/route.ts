import type { NextRequest } from "next/server";
import { render } from "../../../server/api";
export const runtime = "nodejs";
export function POST(req: NextRequest) {
  return render(req, false);
}
