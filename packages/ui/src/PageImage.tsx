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
  // Keep each object URL paired with the PNG it was made from, so a URL that has
  // already been revoked is never rendered.
  const [image, setImage] = useState<{ png: Uint8Array; url: string }>();

  useEffect(() => {
    const url = URL.createObjectURL(new Blob([png as BlobPart], { type: "image/png" }));
    setImage({ png, url });
    return () => URL.revokeObjectURL(url);
  }, [png]);

  if (!image || image.png !== png) return null;
  return <img className="pdfo-page" src={image.url} width={width} height={height} alt={alt} />;
}
