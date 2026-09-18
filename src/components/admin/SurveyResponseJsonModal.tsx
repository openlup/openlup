import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[];

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  data: Json | null;
  createdAt: string | null;
}

export default function SurveyResponseJsonModal({
  open,
  onOpenChange,
  data,
  createdAt,
}: Props) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl max-h-[80vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle>Response JSON</DialogTitle>
          {createdAt && (
            <div className="text-xs text-text-muted">
              {new Date(createdAt).toISOString()}
            </div>
          )}
        </DialogHeader>
        <pre
          className="flex-1 overflow-auto rounded-lg bg-offwhite p-4 text-xs text-teal-dark font-mono whitespace-pre-wrap break-words"
          style={{ maxHeight: "60vh" }}
        >
          {data === null ? "(empty)" : JSON.stringify(data, null, 2)}
        </pre>
      </DialogContent>
    </Dialog>
  );
}
