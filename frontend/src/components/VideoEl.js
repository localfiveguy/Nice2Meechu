import React from "react";

export const VideoEl = React.forwardRef(function VideoEl({ src, className, ...rest }, ref) {
  const webm = src && src.endsWith(".mp4") ? src.replace(".mp4", ".webm") : null;
  return (
    <video ref={ref} className={className} {...rest} key={src}>
      {webm && <source src={webm} type="video/webm" />}
      <source src={src} type={src?.endsWith(".webm") ? "video/webm" : "video/mp4"} />
    </video>
  );
});
