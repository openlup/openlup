import * as React from "react";
import { ChevronDown, ChevronLeft, ChevronRight, ChevronUp } from "lucide-react";
import {
  DayFlag,
  DayPicker,
  SelectionState,
  UI,
  type ChevronProps,
} from "react-day-picker";

import { cn } from "@/lib/utils";
import { buttonVariants } from "@/components/ui/buttonVariants";

export type CalendarProps = React.ComponentProps<typeof DayPicker>;

function CalendarChevron({ className, orientation = "left" }: ChevronProps) {
  const Icon = {
    down: ChevronDown,
    left: ChevronLeft,
    right: ChevronRight,
    up: ChevronUp,
  }[orientation];

  return <Icon aria-hidden="true" className={cn("h-4 w-4", className)} />;
}

function Calendar({ className, classNames, components, showOutsideDays = true, ...props }: CalendarProps) {
  return (
    <DayPicker
      showOutsideDays={showOutsideDays}
      className={cn("p-3", className)}
      classNames={{
        [UI.Months]: "flex flex-col gap-4 sm:flex-row",
        [UI.Month]: "space-y-4",
        [UI.MonthCaption]: "relative flex items-center justify-center pt-1",
        [UI.CaptionLabel]: "text-sm font-medium",
        [UI.Nav]: "flex items-center gap-1",
        [UI.PreviousMonthButton]: cn(
          buttonVariants({ variant: "outline" }),
          "absolute left-1 h-7 w-7 bg-transparent p-0 opacity-50 hover:opacity-100",
        ),
        [UI.NextMonthButton]: cn(
          buttonVariants({ variant: "outline" }),
          "absolute right-1 h-7 w-7 bg-transparent p-0 opacity-50 hover:opacity-100",
        ),
        [UI.MonthGrid]: "w-full border-collapse space-y-1",
        [UI.Weekdays]: "flex",
        [UI.Weekday]: "w-9 rounded-md text-[0.8rem] font-normal text-muted-foreground",
        [UI.Week]: "mt-2 flex w-full",
        [UI.Day]:
          "relative h-9 w-9 p-0 text-center text-sm focus-within:relative focus-within:z-20 data-[selected=true]:bg-accent first:data-[selected=true]:rounded-l-md last:data-[selected=true]:rounded-r-md",
        [UI.DayButton]: cn(
          buttonVariants({ variant: "ghost" }),
          "h-9 w-9 p-0 font-normal aria-selected:opacity-100",
        ),
        [SelectionState.range_end]: "day-range-end rounded-r-md",
        [SelectionState.range_start]: "rounded-l-md",
        [SelectionState.selected]:
          "[&>button]:bg-primary [&>button]:text-primary-foreground [&>button:hover]:bg-primary [&>button:hover]:text-primary-foreground [&>button:focus]:bg-primary [&>button:focus]:text-primary-foreground",
        [DayFlag.today]: "bg-accent text-accent-foreground",
        [DayFlag.outside]:
          "day-outside text-muted-foreground opacity-50 data-[selected=true]:bg-accent/50 data-[selected=true]:text-muted-foreground data-[selected=true]:opacity-30",
        [DayFlag.disabled]: "text-muted-foreground opacity-50",
        [SelectionState.range_middle]:
          "bg-accent text-accent-foreground [&>button]:bg-transparent [&>button]:text-accent-foreground",
        [DayFlag.hidden]: "invisible",
        ...classNames,
      }}
      components={{
        Chevron: CalendarChevron,
        ...components,
      }}
      {...props}
    />
  );
}
Calendar.displayName = "Calendar";

export { Calendar };
