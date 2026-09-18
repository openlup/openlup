import Analytics from "@/components/Analytics";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { Toaster } from "@/components/ui/toaster";

export default function AppRuntimeEffects() {
  return (
    <>
      <Toaster />
      <Sonner />
      <Analytics />
    </>
  );
}
