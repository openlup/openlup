import type { SegmentNeedIcon } from "@/domains/catalog/audienceModel";

const NEED_ICON_PATHS: Record<SegmentNeedIcon, string> = {
  bolt: "M13 2 4 14h6l-1 8 9-12h-6l1-8z",
  drop: "M12 3c3 4 6 6.6 6 10a6 6 0 0 1-12 0c0-3.4 3-6 6-10z",
  gut: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM8 12c1.5 2 6.5 2 8 0",
  tooth: "M7 3v8a5 5 0 0 0 10 0V3M7 3c0 2 1.2 3 2.5 3S12 5 12 3c0 2 1.2 3 2.5 3S17 5 17 3",
  joint: "M7 4a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM17 14a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM9.4 9.4l5.2 5.2",
  scale: "M12 4v16M5 8h14M5 8 2.5 15h5L5 8zM19 8l-2.5 7h5L19 8z",
  wind: "M3 8h11a3 3 0 1 0-3-3M3 14h7a3 3 0 1 1-3 3",
  eye: "M2 12s3.6-6 10-6 10 6 10 6-3.6 6-10 6-10-6-10-6zM12 9.4a2.6 2.6 0 1 0 0 5.2 2.6 2.6 0 0 0 0-5.2z",
};

const NeedIconGlyph = ({ icon }: { icon: SegmentNeedIcon }) => (
  <svg
    width="22"
    height="22"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d={NEED_ICON_PATHS[icon]} />
  </svg>
);

export default NeedIconGlyph;
