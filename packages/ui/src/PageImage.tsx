// SPDX-License-Identifier: AGPL-3.0-or-later

import { useEffect, useState } from "react";

export interface PageImageProps {
  png: Uint8Array;
  width: number;
  height: number;
  alt: string;
}

/** Shows one rendered PDF page. */
export function PageImage({ png, width, height, alt }: PageImageProps) {
  const [url, setUrl] = useState<string>();

  useEffect(() => {
    const objectUrl = URL.createObjectURL(new Blob([png as BlobPart], { type: "image/png" }));
    setUrl(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [png]);

  if (!url) return null;
  return <img className="pdfo-page" src={url} width={width} height={height} alt={alt} />;
}
