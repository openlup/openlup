import { AlertTriangle, RefreshCw } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";

export function AdminOmsErrorState({
  title,
  description,
  retryLabel,
  retrying,
  testId,
  onRetry,
}: {
  title: string;
  description: string;
  retryLabel: string;
  retrying: boolean;
  testId: string;
  onRetry: () => void;
}) {
  return (
    <Alert
      variant="destructive"
      data-testid={testId}
      className="border-warm-coral/40 bg-warm-coral/10 text-teal-dark"
    >
      <AlertTriangle aria-hidden="true" className="text-warm-coral" size={18} />
      <AlertTitle className="text-teal-dark">{title}</AlertTitle>
      <AlertDescription className="flex flex-col gap-3 text-text-muted sm:flex-row sm:items-center sm:justify-between">
        <span>{description}</span>
        <Button
          type="button"
          size="sm"
          disabled={retrying}
          onClick={onRetry}
          className="w-full gap-2 bg-warm-coral text-void hover:bg-warm-coral/90 disabled:bg-warm-sand disabled:text-text-muted sm:w-auto"
        >
          <RefreshCw aria-hidden="true" className={retrying ? "animate-spin" : ""} size={15} />
          {retryLabel}
        </Button>
      </AlertDescription>
    </Alert>
  );
}
