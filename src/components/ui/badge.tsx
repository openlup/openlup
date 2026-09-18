/* eslint-disable react-refresh/only-export-components -- shadcn-compatible modules intentionally export component helpers/hooks. */
import * as React from "react";
import type { VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";
import { badgeVariants } from "@/components/ui/badgeVariants";

export interface BadgeProps extends React.HTMLAttributes<HTMLDivElement>, VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return <div className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export { Badge, badgeVariants };
