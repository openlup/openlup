import { ChevronLeft, ChevronRight } from "lucide-react";

interface AdminPaginationControlsProps {
  page: number;
  totalPages: number;
  label?: (page: number, totalPages: number) => string;
  previousLabel: string;
  nextLabel: string;
  onPageChange: (page: number) => void;
}

export function AdminPaginationControls({
  page,
  totalPages,
  label = (currentPage, pages) => `Strona ${currentPage + 1} z ${pages}`,
  previousLabel,
  nextLabel,
  onPageChange,
}: AdminPaginationControlsProps) {
  if (totalPages <= 1) return null;

  return (
    <div className="mt-4 flex items-center justify-between">
      <p className="text-sm text-text-muted">{label(page, totalPages)}</p>
      <div className="flex gap-2">
        <button
          type="button"
          aria-label={previousLabel}
          disabled={page === 0}
          onClick={() => onPageChange(Math.max(0, page - 1))}
          className="rounded-lg border border-warm-sand px-3 py-1.5 text-sm text-text-muted hover:bg-offwhite disabled:opacity-30"
        >
          <ChevronLeft size={16} />
        </button>
        <button
          type="button"
          aria-label={nextLabel}
          disabled={page >= totalPages - 1}
          onClick={() => onPageChange(page + 1)}
          className="rounded-lg border border-warm-sand px-3 py-1.5 text-sm text-text-muted hover:bg-offwhite disabled:opacity-30"
        >
          <ChevronRight size={16} />
        </button>
      </div>
    </div>
  );
}
