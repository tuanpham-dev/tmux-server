import * as api from "../api";

interface Props {
  filePath: string;
  active: boolean;
}

const basename = (p: string) => p.slice(p.lastIndexOf("/") + 1);

// inlineUrl (not downloadUrl) — an iframe *navigates* to its src, which
// honors Content-Disposition: attachment and would download the PDF instead
// of rendering it (unlike an <img>/<video> subresource load).
export default function PdfView({ filePath, active }: Props) {
  return (
    <div className={`pdf-host${active ? "" : " hidden"}`}>
      <iframe className="pdf-frame" src={api.inlineUrl(filePath)} title={basename(filePath)} />
    </div>
  );
}
