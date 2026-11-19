import type {Metadata} from "next";
import type {ReactNode} from "react";
export const metadata:Metadata={title:"SupoClip Lite — Clip studio",description:"Find the hooks in a stream, frame your facecam, and render captioned vertical MP4 clips."};
export default function Layout({children}:{children:ReactNode}) {
  return <html lang="en"><body style={{margin:0,background:"#09090b"}}>{children}</body></html>;
}
