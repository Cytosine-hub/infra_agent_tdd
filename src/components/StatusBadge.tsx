import { STATUS_LABELS, type Status } from "@/lib/types";

const COLORS: Record<Status, string> = {
  submitted: "bg-amber-50 text-amber-700 border-amber-200",
  requirement_rejected: "bg-red-50 text-red-700 border-red-200",
  requirement_approved: "bg-sky-50 text-sky-700 border-sky-200",
  testcases_generated: "bg-violet-50 text-violet-700 border-violet-200",
  testcases_rejected: "bg-red-50 text-red-700 border-red-200",
  testcases_approved: "bg-blue-50 text-blue-700 border-blue-200",
  developing: "bg-indigo-50 text-indigo-700 border-indigo-200",
  in_review: "bg-cyan-50 text-cyan-700 border-cyan-200",
  done: "bg-emerald-50 text-emerald-700 border-emerald-200",
};

export default function StatusBadge({ status }: { status: Status }) {
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium ${COLORS[status]}`}
    >
      {STATUS_LABELS[status]}
    </span>
  );
}
