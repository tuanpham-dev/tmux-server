import * as api from "../api";
import { isAudioPath } from "../fileKinds";

interface Props {
  filePath: string;
  active: boolean;
}

// No portaled tab-bar controls — the native <video>/<audio> controls already
// cover play/pause/seek/volume, matching how a browser tab handles the same
// file. Media elements ignore Content-Disposition: attachment (only an
// <iframe> navigation honors it, see PdfView), so the plain download URL
// works here with no server changes.
export default function MediaView({ filePath, active }: Props) {
  const src = api.downloadUrl(filePath);
  return (
    <div className={`media-host${active ? "" : " hidden"}`}>
      {isAudioPath(filePath) ? (
        <audio className="media-audio" src={src} controls />
      ) : (
        <video className="media-video" src={src} controls />
      )}
    </div>
  );
}
