import { useLectureRecorder } from "@/pages/lecture/useLectureRecorder";
import LectureRecorderView from "@/pages/lecture/LectureRecorderView";

export default function LectureRecorderPage() {
  const c = useLectureRecorder();
  return <LectureRecorderView c={c} />;
}
