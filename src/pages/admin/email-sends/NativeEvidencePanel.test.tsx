import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { NativeEvidencePanel } from "./NativeEvidencePanel.js";
it("shows acceptance separately from observations and preserves unavailable readback on retry", async () => {
  const load = vi.fn().mockResolvedValue({ binding: "synthetic", candidate: "artifact:synthetic", schema: "70", sends: [{ id: "send", sourceKey: "source", messageId: "network:synthetic", observedState: null, abandonedAt: null }], sync: [{ id: "work", status: "processed" }], decisions: [{ id: "decision", allowed: false, reason: "permission_denied" }] });
  render(<NativeEvidencePanel accessToken="synthetic-session" load={load} />);
  expect(await screen.findByText(/Accepted; delivery unobserved/)).toBeTruthy();
  expect(screen.getByText(/Membership processed/)).toBeTruthy();
  expect(screen.queryByText(/^Delivered$/)).toBeNull();
  load.mockRejectedValueOnce(new Error("unavailable"));fireEvent.click(screen.getByRole("button", {name:"Refresh native evidence"}));
  await waitFor(()=>expect(screen.getByRole("alert").textContent).toContain("unavailable"));
});
